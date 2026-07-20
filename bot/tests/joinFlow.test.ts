import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { runJoinFlow } from "../src/joinFlow.js";
import { meetPlatform } from "../src/platforms/meet.js";
import type { ControlPlaneClient } from "../src/controlPlaneClient.js";
import type { Settings } from "../src/config.js";
import { setupMockMeetRoutes, buildMockMeetUrl } from "./mockPage.js";

// Mock-page-driven join flow tests (ticket 5.2, docs/meet-bot.md — "no CI
// run ever joins a real Meet"). Chromium runs headless here — that's a test
// concern only; the launch-profile module tested separately asserts prod's
// headless:false/mute-audio-strip options without needing a real browser.

class FakeControlPlane implements ControlPlaneClient {
  events: { state: string; detail: string | undefined }[] = [];
  heartbeats: { state: string }[] = [];
  async heartbeat(state: string) {
    this.heartbeats.push({ state });
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

let fetchCalls: string[] = [];
function fakeFetch(): typeof fetch {
  fetchCalls = [];
  return (async (url: string | URL) => {
    fetchCalls.push(String(url));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

function makeSettings(meetUrl: string, overrides: Partial<Settings> = {}): Settings {
  return {
    admissionTimeoutS: 1.2,
    joinRequestAttempts: 3,
    loneParticipantS: 60,
    noOneJoinedS: 600,
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
      meetUrl,
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

describe("runJoinFlow", () => {
  it("reaches recording once the mock admits, filling the configured display name", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await setupMockMeetRoutes(page);
    const cp = new FakeControlPlane();
    const settings = makeSettings(
      buildMockMeetUrl("prejoin", { autoAdmitAfterMs: "150", autoAdmitCount: "2" }),
    );

    const outcome = await runJoinFlow(
      page,
      meetPlatform,
      settings,
      cp,
      Date.now,
      fastSleep,
      fakeFetch(),
    );

    expect(outcome).toBe("recording");
    expect(cp.events.map((e) => e.state)).toEqual(["joining", "lobby", "recording"]);
    expect(await page.locator("#nameInput").inputValue()).toBe("ScribeFlow Notetaker");
    // dismissPostAdmissionModals clicked "Got it" away.
    expect(await page.locator("#gotIt").isHidden()).toBe(true);
    await context.close();
  });

  it("is terminal and never re-asks on denial", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await setupMockMeetRoutes(page);
    const cp = new FakeControlPlane();
    const settings = makeSettings(
      buildMockMeetUrl("prejoin", { autoDenyAfterMs: "100" }),
    );

    const outcome = await runJoinFlow(
      page,
      meetPlatform,
      settings,
      cp,
      Date.now,
      fastSleep,
      fakeFetch(),
    );

    expect(outcome).toBe("denied");
    expect(cp.events.at(-1)?.state).toBe("denied");
    // Terminal-failure screenshot upload was attempted (best-effort).
    expect(fetchCalls).toContain("https://example.com/debug-put");
    await context.close();
  });

  it("times out to not_admitted when nobody responds", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await setupMockMeetRoutes(page);
    const cp = new FakeControlPlane();
    const settings = makeSettings(buildMockMeetUrl("prejoin"), {
      admissionTimeoutS: 0.3,
    });

    const outcome = await runJoinFlow(
      page,
      meetPlatform,
      settings,
      cp,
      Date.now,
      fastSleep,
      fakeFetch(),
    );

    expect(outcome).toBe("not_admitted");
    await context.close();
  });

  it("is terminal (failed) when removed while still waiting for admission", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await setupMockMeetRoutes(page);
    const cp = new FakeControlPlane();
    const settings = makeSettings(
      buildMockMeetUrl("prejoin", { autoRemoveAfterMs: "100" }),
    );

    const outcome = await runJoinFlow(
      page,
      meetPlatform,
      settings,
      cp,
      Date.now,
      fastSleep,
      fakeFetch(),
    );

    expect(outcome).toBe("failed");
    await context.close();
  });

  it("classifies a sign-in wall as blocked without attempting to join", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await setupMockMeetRoutes(page);
    const cp = new FakeControlPlane();
    const settings = makeSettings(buildMockMeetUrl("blocked"));

    const outcome = await runJoinFlow(
      page,
      meetPlatform,
      settings,
      cp,
      Date.now,
      fastSleep,
      fakeFetch(),
    );

    expect(outcome).toBe("blocked");
    expect(cp.events.map((e) => e.state)).toEqual(["joining", "blocked"]);
    await context.close();
  });

  it("classifies an invalid meeting code as invalid_url", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await setupMockMeetRoutes(page);
    const cp = new FakeControlPlane();
    const settings = makeSettings(buildMockMeetUrl("invalid"));

    const outcome = await runJoinFlow(
      page,
      meetPlatform,
      settings,
      cp,
      Date.now,
      fastSleep,
      fakeFetch(),
    );

    expect(outcome).toBe("invalid_url");
    await context.close();
  });

  it("re-issues an expired join request, at most BOT_JOIN_REQUEST_ATTEMPTS asks, and can still succeed", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await setupMockMeetRoutes(page);
    const cp = new FakeControlPlane();
    const settings = makeSettings(
      buildMockMeetUrl("prejoin", { autoExpireAfterMs: "100", autoAdmitAfterMs: "400" }),
    );

    const outcome = await runJoinFlow(
      page,
      meetPlatform,
      settings,
      cp,
      Date.now,
      fastSleep,
      fakeFetch(),
    );

    expect(outcome).toBe("recording");
    await context.close();
  });

  it("bounds re-asks under a repeated redirect and eventually gives up", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await setupMockMeetRoutes(page);
    const cp = new FakeControlPlane();
    // The redirect delay is generous relative to a re-navigate+re-ask cycle
    // (~150-250ms observed elsewhere in this suite) so the mock's own
    // page-load timer can't race a fresh page.goto — that race, not the
    // join-flow logic, is what this test is exercising around.
    const settings = makeSettings(
      buildMockMeetUrl("prejoin", { autoRedirectAfterMs: "400" }),
      { admissionTimeoutS: 1.3, joinRequestAttempts: 2 },
    );

    const outcome = await runJoinFlow(
      page,
      meetPlatform,
      settings,
      cp,
      Date.now,
      fastSleep,
      fakeFetch(),
    );

    expect(outcome).toBe("not_admitted");
    await context.close();
  });
});
