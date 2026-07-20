import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { monitorLifecycle, gracefulExit, type StopSignal } from "../src/lifecycle.js";
import { meetPlatform } from "../src/platforms/meet.js";
import type { ControlPlaneClient } from "../src/controlPlaneClient.js";
import type { Settings } from "../src/config.js";
import { gotoMockMeet } from "./mockPage.js";

class FakeControlPlane implements ControlPlaneClient {
  events: { state: string; detail: string | undefined }[] = [];
  async heartbeat() {
    /* no-op */
  }
  async event(state: string, detail?: string) {
    this.events.push({ state, detail });
  }
  async segmentUrl() {
    return { url: "https://example.com/segment-put", key: "k" };
  }
  async debugUrl() {
    return { url: "https://example.com/debug-put", key: "k" };
  }
}

function fastSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 40)));
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    admissionTimeoutS: 300,
    joinRequestAttempts: 3,
    loneParticipantS: 0.15,
    noOneJoinedS: 0.15,
    maxDurationS: 7200,
    segmentS: 300,
    displayName: "ScribeFlow Notetaker",
    debugVnc: false,
    storageStatePath: undefined,
    recordingDir: "/rec",
    session: {
      tenantId: "t1",
      meetingId: "m1",
      sessionId: "s1",
      sessionToken: "tok",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      orchestratorUrl: "https://example.com",
      platform: "meet",
    },
    ...overrides,
  };
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

describe("monitorLifecycle", () => {
  it("fires no_one_joined when the bot has been alone since admission", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoMockMeet(page, "prejoin");
    await page.evaluate(() =>
      (window as unknown as { mock: { admit: (n: number) => void } }).mock.admit(1),
    );

    const reason = await monitorLifecycle(
      page,
      meetPlatform,
      makeSettings(),
      new FakeControlPlane(),
      { requested: false },
      Date.now,
      fastSleep,
    );

    expect(reason).toBe("no_one_joined");
    await context.close();
  });

  it("fires lone_participant after seeing a second participant leave", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoMockMeet(page, "prejoin");
    await page.evaluate(() =>
      (window as unknown as { mock: { admit: (n: number) => void } }).mock.admit(2),
    );
    setTimeout(() => {
      void page.evaluate(() =>
        (
          window as unknown as { mock: { setParticipantCount: (n: number) => void } }
        ).mock.setParticipantCount(1),
      );
    }, 60);

    const reason = await monitorLifecycle(
      page,
      meetPlatform,
      makeSettings(),
      new FakeControlPlane(),
      { requested: false },
      Date.now,
      fastSleep,
    );

    expect(reason).toBe("lone_participant");
    await context.close();
  });

  it("fires removed when the host removes the bot", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoMockMeet(page, "prejoin");
    await page.evaluate(() =>
      (window as unknown as { mock: { admit: (n: number) => void } }).mock.admit(2),
    );
    setTimeout(() => {
      void page.evaluate(() =>
        (window as unknown as { mock: { remove: () => void } }).mock.remove(),
      );
    }, 60);

    const reason = await monitorLifecycle(
      page,
      meetPlatform,
      makeSettings({ loneParticipantS: 5, noOneJoinedS: 5 }),
      new FakeControlPlane(),
      { requested: false },
      Date.now,
      fastSleep,
    );

    expect(reason).toBe("removed");
    await context.close();
  });

  it("fires redirected when the page navigates off meet.google.com", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoMockMeet(page, "prejoin");
    await page.evaluate(() =>
      (window as unknown as { mock: { admit: (n: number) => void } }).mock.admit(2),
    );
    setTimeout(() => {
      void page.evaluate(() =>
        (window as unknown as { mock: { redirectAway: () => void } }).mock.redirectAway(),
      );
    }, 60);

    const reason = await monitorLifecycle(
      page,
      meetPlatform,
      makeSettings({ loneParticipantS: 5, noOneJoinedS: 5 }),
      new FakeControlPlane(),
      { requested: false },
      Date.now,
      fastSleep,
    );

    expect(reason).toBe("redirected");
    await context.close();
  });

  it("fires max_duration as a hard cap regardless of participant activity", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoMockMeet(page, "prejoin");
    await page.evaluate(() =>
      (window as unknown as { mock: { admit: (n: number) => void } }).mock.admit(2),
    );

    const reason = await monitorLifecycle(
      page,
      meetPlatform,
      makeSettings({ loneParticipantS: 5, noOneJoinedS: 5, maxDurationS: 0.1 }),
      new FakeControlPlane(),
      { requested: false },
      Date.now,
      fastSleep,
    );

    expect(reason).toBe("max_duration");
    await context.close();
  });

  it("returns orchestrator_signal as soon as the stop signal is set", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoMockMeet(page, "prejoin");
    await page.evaluate(() =>
      (window as unknown as { mock: { admit: (n: number) => void } }).mock.admit(2),
    );

    const stop: StopSignal = { requested: false };
    setTimeout(() => (stop.requested = true), 30);

    const reason = await monitorLifecycle(
      page,
      meetPlatform,
      makeSettings({ loneParticipantS: 5, noOneJoinedS: 5 }),
      new FakeControlPlane(),
      stop,
      Date.now,
      fastSleep,
    );

    expect(reason).toBe("orchestrator_signal");
    await context.close();
  });
});

describe("gracefulExit", () => {
  it("clicks leave, stops capture, and reports leaving then done", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoMockMeet(page, "prejoin");
    await page.evaluate(() =>
      (window as unknown as { mock: { admit: (n: number) => void } }).mock.admit(2),
    );

    const cp = new FakeControlPlane();
    let stopped = false;
    const fakeCapture = { stop: async () => void (stopped = true) };

    await gracefulExit(page, meetPlatform, fakeCapture, cp, "lone_participant");

    expect(stopped).toBe(true);
    expect(cp.events.map((e) => e.state)).toEqual(["leaving", "done"]);
    expect(
      await page.evaluate(
        () => (window as unknown as { __leftCall: boolean }).__leftCall,
      ),
    ).toBe(true);
    await context.close();
  });
});
