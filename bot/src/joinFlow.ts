import type { Page } from "playwright";
import type { ControlPlaneClient } from "./controlPlaneClient.js";
import type { PlatformStrategy } from "./platforms/types.js";
import type { Settings } from "./config.js";
import type { BotState } from "./state.js";
import { getLogger } from "./logging.js";

const log = getLogger("joinFlow");

const LOBBY_POLL_MS = 2000;

export type JoinOutcome = Extract<
  BotState,
  "recording" | "not_admitted" | "denied" | "blocked" | "invalid_url" | "failed"
>;

async function reportTerminal(
  page: Page,
  cp: ControlPlaneClient,
  state: Exclude<JoinOutcome, "recording">,
  fetchImpl: typeof fetch,
  detail?: string,
): Promise<void> {
  // Best-effort debug screenshot (docs/meet-bot.md — "every terminal failure
  // screenshots the page and PUTs it to R2 under .../bot-debug/"). Never
  // allowed to mask the real terminal state below.
  try {
    const shot = await page.screenshot();
    const { url } = await cp.debugUrl(`${state}-${Date.now()}.png`);
    await fetchImpl(url, {
      method: "PUT",
      body: shot,
      headers: { "content-type": "image/png" },
    });
  } catch (err) {
    log.warn("debug_screenshot_failed", { state, error: String(err) });
  }
  await cp.event(state, detail);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The join-flow state machine (ticket 5.2, docs/meet-bot.md — "Join flow"):
// spawning -> joining -> lobby -> recording, or one of the terminal outcomes
// (not_admitted/denied/blocked/invalid_url/failed). `now` is injectable so
// tests can drive the admission-timeout loop without real sleeps.
export async function runJoinFlow(
  page: Page,
  platform: PlatformStrategy,
  settings: Settings,
  cp: ControlPlaneClient,
  now: () => number = Date.now,
  sleepImpl: (ms: number) => Promise<void> = sleep,
  fetchImpl: typeof fetch = fetch,
): Promise<JoinOutcome> {
  await cp.event("joining");
  await page.goto(platform.normalizeUrl(settings.session.meetUrl), {
    waitUntil: "domcontentloaded",
  });

  const landing = await platform.classifyLanding(page);
  if (landing === "blocked") {
    await reportTerminal(page, cp, "blocked", fetchImpl);
    return "blocked";
  }
  if (landing === "invalid_url") {
    await reportTerminal(page, cp, "invalid_url", fetchImpl);
    return "invalid_url";
  }

  await platform.requestToJoin(page, settings.displayName);
  await cp.event("lobby");

  const deadline = now() + settings.admissionTimeoutS * 1000;
  let asks = 1;
  while (now() < deadline) {
    const signal = await platform.pollAdmission(page);

    if (signal.removed) {
      await reportTerminal(
        page,
        cp,
        "failed",
        fetchImpl,
        "removed while waiting for admission",
      );
      return "failed";
    }
    if (signal.denied) {
      // D71: denial is terminal — never re-ask a host who said no.
      await reportTerminal(page, cp, "denied", fetchImpl);
      return "denied";
    }
    if (signal.admitted) {
      await platform.dismissPostAdmissionModals(page);
      await cp.event("recording");
      return "recording";
    }
    if (
      (signal.requestExpired || signal.redirectedAway) &&
      asks < settings.joinRequestAttempts
    ) {
      asks += 1;
      log.info("join.re_asking", {
        asks,
        reason: signal.requestExpired ? "expired" : "redirected",
      });
      if (signal.redirectedAway) {
        await page.goto(platform.normalizeUrl(settings.session.meetUrl), {
          waitUntil: "domcontentloaded",
        });
      }
      await platform.requestToJoin(page, settings.displayName);
    }
    await sleepImpl(LOBBY_POLL_MS);
  }

  await reportTerminal(page, cp, "not_admitted", fetchImpl);
  return "not_admitted";
}
