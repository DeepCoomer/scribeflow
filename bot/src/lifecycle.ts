import type { Page } from "playwright";
import type { ControlPlaneClient } from "./controlPlaneClient.js";
import type { PlatformStrategy } from "./platforms/types.js";
import type { Settings } from "./config.js";
import { getLogger } from "./logging.js";

// Structural, not the concrete Capture class, so tests can pass a fake
// without satisfying Capture's private fields.
export type Stoppable = { stop(): Promise<void> };

const log = getLogger("lifecycle");

// Leave conditions (ticket 5.4, docs/meet-bot.md's leave-conditions table).
export type LeaveReason =
  | "lone_participant"
  | "no_one_joined"
  | "removed"
  | "redirected"
  | "max_duration"
  | "orchestrator_signal";

const PARTICIPANT_POLL_MS = 5000;

export type StopSignal = { requested: boolean };

// Polls participant count every 5s (docs/meet-bot.md) via the same
// pollAdmission signal the join flow uses, tracking whether a second
// participant was ever seen (the lone-participant/no-one-joined distinction
// only makes sense relative to that). Returns as soon as any leave
// condition fires; the caller (main.ts) runs the graceful exit ladder.
export async function monitorLifecycle(
  page: Page,
  platform: PlatformStrategy,
  settings: Settings,
  cp: ControlPlaneClient,
  stop: StopSignal,
  now: () => number = Date.now,
  sleepImpl: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<LeaveReason> {
  const recordingStartedAt = now();
  let everSawSecondParticipant = false;
  let loneSince: number | null = null;

  for (;;) {
    if (stop.requested) return "orchestrator_signal";

    const elapsedMs = now() - recordingStartedAt;
    if (elapsedMs > settings.maxDurationS * 1000) return "max_duration";

    const signal = await platform.pollAdmission(page);
    if (signal.removed) return "removed";
    if (signal.redirectedAway) return "redirected";

    const count = signal.participantCount ?? 0;
    if (count >= 2) {
      everSawSecondParticipant = true;
      loneSince = null;
    } else if (everSawSecondParticipant) {
      loneSince ??= now();
      if (now() - loneSince > settings.loneParticipantS * 1000) return "lone_participant";
    } else if (elapsedMs > settings.noOneJoinedS * 1000) {
      return "no_one_joined";
    }

    await cp.heartbeat("recording", { participantCount: count }).catch((err: unknown) => {
      log.warn("heartbeat_failed", { error: String(err) });
    });
    await sleepImpl(PARTICIPANT_POLL_MS);
  }
}

// Graceful exit ladder, every path (docs/meet-bot.md): click "Leave call"
// (best-effort) -> stop ffmpeg (stdin q / SIGTERM@15s / SIGKILL@+5s, owned
// by Capture.stop()) -> report terminal state. The orchestrator's `docker
// stop` grace is 60s, well clear of the ~20s ffmpeg ladder.
export async function gracefulExit(
  page: Page,
  platform: PlatformStrategy,
  capture: Stoppable,
  cp: ControlPlaneClient,
  reason: LeaveReason,
): Promise<void> {
  await cp.event("leaving", reason);
  try {
    await platform.leave(page);
  } catch (err) {
    log.warn("leave_click_failed", { error: String(err) });
  }
  await capture.stop();
  await cp.event("done", reason);
}
