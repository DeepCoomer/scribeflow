import type { Locator, Page } from "playwright";
import { meetSelectors, parseParticipantCount } from "../selectors.js";
import type {
  AdmissionSignal,
  LandingClassification,
  PlatformStrategy,
} from "./types.js";

async function isVisible(_page: Page, locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible({ timeout: 500 });
  } catch {
    return false;
  }
}

// Bounded loop: "Got it" modals and mic/cam-not-found toasts can stack after
// admission (docs/meet-bot.md step 5) — dismiss up to a fixed number of
// times rather than looping until none remain, since a persistently-visible
// unrelated element must never hang the join flow.
const MAX_DISMISS_ITERATIONS = 5;

export const meetPlatform: PlatformStrategy = {
  name: "meet",

  normalizeUrl(url: string): string {
    const u = new URL(url);
    u.searchParams.set("hl", "en");
    return u.toString();
  },

  async classifyLanding(page: Page): Promise<LandingClassification> {
    if (
      page.url().includes("accounts.google.com") ||
      (await isVisible(page, meetSelectors.signInHeading(page)))
    ) {
      return "blocked";
    }
    if (await isVisible(page, meetSelectors.invalidMeetingText(page))) {
      return "invalid_url";
    }
    return "pre_join";
  },

  async requestToJoin(page: Page, displayName: string): Promise<void> {
    const continueBtn = meetSelectors.continueWithoutMicCam(page);
    if (await isVisible(page, continueBtn)) {
      await continueBtn.click().catch(() => undefined);
    }

    const nameInput = meetSelectors.nameInput(page);
    if (await isVisible(page, nameInput)) {
      await nameInput.fill(displayName).catch(() => undefined);
    }

    // "ScribeFlow Notetaker" (D33) always joins via one of these three, in
    // this order of preference — try each in turn, first one wins.
    for (const button of [
      meetSelectors.askToJoin(page),
      meetSelectors.joinNow(page),
      meetSelectors.joinAnyway(page),
    ]) {
      if (await isVisible(page, button)) {
        await button.click().catch(() => undefined);
        return;
      }
    }
  },

  async pollAdmission(page: Page): Promise<AdmissionSignal> {
    if (!page.url().includes("meet.google.com")) {
      return {
        admitted: false,
        denied: false,
        requestExpired: false,
        removed: false,
        redirectedAway: true,
        participantCount: null,
      };
    }
    if (await isVisible(page, meetSelectors.removedText(page))) {
      return {
        admitted: false,
        denied: false,
        requestExpired: false,
        removed: true,
        redirectedAway: false,
        participantCount: null,
      };
    }
    if (await isVisible(page, meetSelectors.deniedText(page))) {
      return {
        admitted: false,
        denied: true,
        requestExpired: false,
        removed: false,
        redirectedAway: false,
        participantCount: null,
      };
    }
    if (await isVisible(page, meetSelectors.requestExpiredText(page))) {
      return {
        admitted: false,
        denied: false,
        requestExpired: true,
        removed: false,
        redirectedAway: false,
        participantCount: null,
      };
    }

    // D71: admission is a participant-count signal, never button presence
    // (the "Leave call" button exists while still in the lobby). Still
    // waiting on the host shows lobby text and no participant signal yet.
    const stillWaiting = await isVisible(page, meetSelectors.lobbyWaitingText(page));
    const peopleButton = meetSelectors.peopleButton(page);
    const avatarBadge = meetSelectors.avatarCountBadge(page);
    const peopleVisible = await isVisible(page, peopleButton);
    const avatarVisible = await isVisible(page, avatarBadge);

    if (stillWaiting || (!peopleVisible && !avatarVisible)) {
      return {
        admitted: false,
        denied: false,
        requestExpired: false,
        removed: false,
        redirectedAway: false,
        participantCount: null,
      };
    }

    const label = peopleVisible
      ? await peopleButton.getAttribute("aria-label").catch(() => null)
      : await avatarBadge.getAttribute("data-avatar-count").catch(() => null);
    return {
      admitted: true,
      denied: false,
      requestExpired: false,
      removed: false,
      redirectedAway: false,
      participantCount: parseParticipantCount(label),
    };
  },

  async dismissPostAdmissionModals(page: Page): Promise<void> {
    for (let i = 0; i < MAX_DISMISS_ITERATIONS; i++) {
      const gotIt = meetSelectors.gotItButton(page);
      const toast = meetSelectors.dismissToast(page);
      let dismissedAny = false;
      if (await isVisible(page, gotIt)) {
        await gotIt.click().catch(() => undefined);
        dismissedAny = true;
      }
      if (await isVisible(page, toast)) {
        await toast.click().catch(() => undefined);
        dismissedAny = true;
      }
      if (!dismissedAny) return;
      await page.waitForTimeout(300);
    }
  },

  async announceRecording(page: Page): Promise<void> {
    // Best-effort only (D33 / CLAUDE.md invariant 7): a failure here must
    // never fail the join or stop the recording.
    try {
      const openBtn = meetSelectors.chatOpenButton(page);
      if (await isVisible(page, openBtn)) {
        await openBtn.click();
      }
      const input = meetSelectors.chatInput(page);
      await input.fill("This meeting is being transcribed by ScribeFlow", {
        timeout: 3000,
      });
      await meetSelectors.chatSendButton(page).click({ timeout: 3000 });
    } catch {
      // logged by the caller (main.ts), never fatal
    }
  },

  async leave(page: Page): Promise<void> {
    const btn = meetSelectors.leaveCallButton(page);
    if (await isVisible(page, btn)) {
      await btn.click().catch(() => undefined);
    }
  },
};
