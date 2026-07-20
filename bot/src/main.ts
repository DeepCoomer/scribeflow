import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { loadSettings } from "./config.js";
import { getPlatform } from "./platforms/index.js";
import { launchBrowser, newContext } from "./launchProfile.js";
import { createControlPlaneClient } from "./controlPlaneClient.js";
import { runJoinFlow } from "./joinFlow.js";
import { monitorLifecycle, gracefulExit, type StopSignal } from "./lifecycle.js";
import { Capture, runAudioHealthCheck } from "./capture.js";
import { getLogger } from "./logging.js";

const log = getLogger("main");

function restartAudioChain(): Promise<void> {
  // Best-effort PulseAudio bounce: kill the daemon, entrypoint.sh's own
  // supervision (or a fresh `pulseaudio --start`) brings it back with the
  // same "meet_out" null sink config. One restart only (docs/meet-bot.md);
  // the caller (runAudioHealthCheck) enforces the "once" part.
  return new Promise((resolve) => {
    const proc = spawn("pulseaudio", ["--kill"]);
    proc.once("exit", () => {
      const restart = spawn("pulseaudio", ["--start", "--log-target=stderr"]);
      restart.once("exit", () => resolve());
      restart.once("error", () => resolve());
    });
    proc.once("error", () => resolve());
  });
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const platform = getPlatform(settings.session.platform);
  const cp = createControlPlaneClient(settings.session);
  await mkdir(settings.recordingDir, { recursive: true });

  const stop: StopSignal = { requested: false };
  process.on("SIGTERM", () => {
    log.info("signal.sigterm_received");
    stop.requested = true;
  });

  await cp
    .event("spawning")
    .catch((err: unknown) => log.warn("event_failed", { error: String(err) }));

  const browser = await launchBrowser();
  const context = await newContext(browser, settings);
  const page = await context.newPage();

  try {
    const outcome = await runJoinFlow(page, platform, settings, cp);
    if (outcome !== "recording") {
      log.info("join.terminal", { outcome });
      return;
    }

    await platform
      .announceRecording(page)
      .catch((err: unknown) => log.warn("announce_failed", { error: String(err) }));

    const capture = new Capture(
      settings.recordingDir,
      settings.segmentS,
      async ({ idx, path, startedAtMs }) => {
        try {
          const { url } = await cp.segmentUrl(idx, startedAtMs);
          const bytes = await readFile(path);
          const res = await fetch(url, {
            method: "PUT",
            body: bytes,
            headers: { "content-type": "audio/ogg" },
          });
          if (!res.ok) throw new Error(`segment upload failed: ${res.status}`);
          log.info("segment.uploaded", { idx });
        } catch (err) {
          // Best-effort — a lost segment is bounded to <= BOT_SEGMENT_S of
          // audio (docs/meet-bot.md: "a crash loses <=5 minutes"); it must
          // never take down the recording.
          log.error("segment.upload_failed", { idx, error: String(err) });
        }
      },
    );
    capture.start();

    setTimeout(() => {
      void runAudioHealthCheck({ spawn, restartAudioChain }, cp).catch((err: unknown) =>
        log.warn("health_check_failed", { error: String(err) }),
      );
    }, 60_000);

    const reason = await monitorLifecycle(page, platform, settings, cp, stop);
    log.info("lifecycle.leaving", { reason });
    await gracefulExit(page, platform, capture, cp, reason);
  } catch (err) {
    log.error("bot.failed", { error: String(err) });
    await cp.event("failed", String(err)).catch(() => undefined);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error("main.crashed", { error: String(err) });
    process.exit(1);
  });
