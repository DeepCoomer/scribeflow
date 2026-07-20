import type { Page } from "playwright";

// Platform strategy interface (ticket 5.2, docs/meet-bot.md — Zoom section):
// bot.ts isolates Meet-specific selectors and flow behind this so Phase 8's
// Zoom lane is a second implementation, not a rewrite of the join/lifecycle
// state machines in joinFlow.ts/lifecycle.ts.

export type LandingClassification = "pre_join" | "blocked" | "invalid_url";

export type AdmissionSignal = {
  admitted: boolean;
  denied: boolean;
  requestExpired: boolean;
  removed: boolean;
  /** The page navigated away from the platform's own domain (D71 — Meet
   * sometimes silently redirects an expired ask-to-join request). */
  redirectedAway: boolean;
  participantCount: number | null;
};

export interface PlatformStrategy {
  readonly name: "meet" | "zoom";

  /** hl=en-style locale pinning, tracking params stripped, etc. */
  normalizeUrl(url: string): string;

  classifyLanding(page: Page): Promise<LandingClassification>;

  /** Fills the display name and clicks through to "ask to join" / "join
   * now", whichever the pre-join screen offers. Safe to call again to
   * re-issue an expired request. */
  requestToJoin(page: Page, displayName: string): Promise<void>;

  /** One poll of the current admission/lifecycle state — used both by the
   * lobby wait (joinFlow.ts) and the in-call participant/removal monitor
   * (lifecycle.ts), so admission and "am I still in the call" share one
   * signal source (D71: never button presence). */
  pollAdmission(page: Page): Promise<AdmissionSignal>;

  /** Dismisses "Got it" modals and mic/cam-not-found toasts that stack
   * right after admission. Bounded internally — never loops forever. */
  dismissPostAdmissionModals(page: Page): Promise<void>;

  /** Best-effort consent line in chat; failure is logged, never fatal
   * (CLAUDE.md invariant 7 / D33). */
  announceRecording(page: Page): Promise<void>;

  /** Best-effort "Leave call" click as the first step of the graceful exit
   * ladder (docs/meet-bot.md — Leave conditions). */
  leave(page: Page): Promise<void>;
}
