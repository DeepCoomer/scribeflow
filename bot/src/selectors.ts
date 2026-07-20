import type { Locator, Page } from "playwright";

// Every Meet DOM selector lives here (docs/meet-bot.md — Meet's UI shifts a
// few times a year; 5.6 is reserved for updating just this file). Text
// matches are deliberately loose (case-insensitive regex) since Meet's exact
// copy has changed before and `hl=en` (launchProfile.ts) only pins the
// language, not the wording within it.

export const meetSelectors = {
  continueWithoutMicCam: (page: Page): Locator =>
    page.getByRole("button", { name: /continue without microphone and camera/i }),
  nameInput: (page: Page): Locator => page.locator('input[type="text"]').first(),
  askToJoin: (page: Page): Locator => page.getByRole("button", { name: /ask to join/i }),
  joinNow: (page: Page): Locator => page.getByRole("button", { name: /^join now$/i }),
  joinAnyway: (page: Page): Locator => page.getByRole("button", { name: /join anyway/i }),

  signInHeading: (page: Page): Locator => page.getByRole("heading", { name: /sign in/i }),
  invalidMeetingText: (page: Page): Locator =>
    page.getByText(
      /check your meeting code|couldn.t find that meeting|not a valid meeting/i,
    ),

  lobbyWaitingText: (page: Page): Locator =>
    page.getByText(/asking to join|waiting for someone to let you in|ready to join/i),
  requestExpiredText: (page: Page): Locator =>
    page.getByText(/no one responded to your request/i),
  deniedText: (page: Page): Locator =>
    page.getByText(/denied your request to join|can.t join this call/i),
  removedText: (page: Page): Locator =>
    page.getByText(/you.ve been removed from the meeting/i),

  avatarCountBadge: (page: Page): Locator => page.locator("[data-avatar-count]"),
  peopleButton: (page: Page): Locator => page.getByRole("button", { name: /^people/i }),

  gotItButton: (page: Page): Locator => page.getByRole("button", { name: /^got it$/i }),
  dismissToast: (page: Page): Locator =>
    page.getByRole("button", { name: /dismiss|no thanks/i }),

  leaveCallButton: (page: Page): Locator =>
    page.getByRole("button", { name: /leave call/i }),

  chatOpenButton: (page: Page): Locator =>
    page.getByRole("button", { name: /chat with everyone|show everyone/i }),
  chatInput: (page: Page): Locator => page.locator('textarea[aria-label*="message" i]'),
  chatSendButton: (page: Page): Locator =>
    page.getByRole("button", { name: /send a message|send/i }),
};

// "People - 3" from the aria-label the avatar/people button carries (D71:
// admission and participant count both come from this signal, never button
// presence). Falls back to the [data-avatar-count] badge's own text.
export function parseParticipantCount(ariaLabelOrText: string | null): number | null {
  if (!ariaLabelOrText) return null;
  const match = /(\d+)/.exec(ariaLabelOrText);
  return match ? Number(match[1]) : null;
}
