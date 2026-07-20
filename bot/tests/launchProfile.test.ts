import { describe, it, expect } from "vitest";
import { buildLaunchOptions, withLocale } from "../src/launchProfile.js";

// docs/meet-bot.md's failure-mode matrix calls this test out by name:
// "Playwright default args mute Chromium | ignoreDefaultArgs: ['--mute-audio']
// — asserted by a launch-profile unit test."
describe("buildLaunchOptions", () => {
  it("strips --mute-audio and --enable-automation from Playwright's defaults (D67)", () => {
    const opts = buildLaunchOptions();
    expect(opts.ignoreDefaultArgs).toContain("--mute-audio");
    expect(opts.ignoreDefaultArgs).toContain("--enable-automation");
  });

  it("runs headful on the Xvfb display, not Playwright's own headless mode", () => {
    expect(buildLaunchOptions().headless).toBe(false);
  });

  it("disables Playwright's own signal handlers so shutdown ordering belongs to main.ts", () => {
    const opts = buildLaunchOptions();
    expect(opts.handleSIGINT).toBe(false);
    expect(opts.handleSIGTERM).toBe(false);
    expect(opts.handleSIGHUP).toBe(false);
  });

  it("never includes fake-device flags — the bot joins device-less (D68)", () => {
    const opts = buildLaunchOptions();
    for (const arg of opts.args) {
      expect(arg).not.toMatch(/use-fake-device|use-fake-ui-for-media-stream/);
    }
  });

  it("carries the container sandbox args", () => {
    const opts = buildLaunchOptions();
    expect(opts.args).toContain("--no-sandbox");
    expect(opts.args).toContain("--disable-setuid-sandbox");
  });
});

describe("withLocale", () => {
  it("pins hl=en on the Meet URL", () => {
    expect(withLocale("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij?hl=en",
    );
  });

  it("overrides an existing hl param rather than duplicating it", () => {
    const url = withLocale("https://meet.google.com/abc-defg-hij?hl=fr");
    expect(new URL(url).searchParams.getAll("hl")).toEqual(["en"]);
  });
});
