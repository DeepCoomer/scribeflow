import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext } from "playwright";
import type { Settings } from "./config.js";

// D68 (docs/meet-bot.md — Browser launch profile): both prior arts (Vexa,
// screenappai/meeting-bot) converged on disabling exactly these two stealth
// evasions for Meet specifically; leaving them on trips Meet's own
// fingerprint checks.
const stealth = StealthPlugin() as { enabledEvasions: Set<string> };
stealth.enabledEvasions.delete("iframe.contentWindow");
stealth.enabledEvasions.delete("media.codecs");
chromiumExtra.use(stealth as never);

export const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=1280,800",
  "--no-first-run",
  "--no-default-browser-check",
];

// Playwright launches Chromium with --mute-audio by default; PulseAudio's
// null-sink capture would record silence unless it's stripped (D67).
// --enable-automation also goes, so the automation info bar doesn't change
// the window geometry Meet expects pre-admission.
export const IGNORE_DEFAULT_ARGS = ["--mute-audio", "--enable-automation"];

export type LaunchOptions = {
  headless: boolean;
  args: string[];
  ignoreDefaultArgs: string[];
  handleSIGINT: boolean;
  handleSIGTERM: boolean;
  handleSIGHUP: boolean;
};

// Pure and exported separately from launchBrowser() so a unit test can
// assert the mute-strip and signal-handling flags without actually spawning
// Chromium (docs/meet-bot.md's failure-mode matrix calls this out by name:
// "asserted by a launch-profile unit test").
export function buildLaunchOptions(): LaunchOptions {
  return {
    // Xvfb display :99 gives Chromium a real surface — headless Chromium is
    // fingerprinted/blocked by Meet (docs/meet-bot.md — Container anatomy).
    headless: false,
    args: LAUNCH_ARGS,
    ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
    // Playwright's own signal handlers close the browser the instant a
    // signal lands, destroying the in-flight recording; shutdown ordering
    // belongs to main.ts's own SIGTERM handler instead.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

export async function launchBrowser(): Promise<Browser> {
  const opts = buildLaunchOptions();
  return chromiumExtra.launch(opts);
}

export async function newContext(
  browser: Browser,
  settings: Settings,
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    ...(settings.storageStatePath ? { storageState: settings.storageStatePath } : {}),
  });
}

// hl=en pins every text selector in selectors.ts to one language instead of
// multiplying selectors per locale (docs/meet-bot.md — we control the
// browser, so pinning is simpler).
export function withLocale(meetUrl: string): string {
  const url = new URL(meetUrl);
  url.searchParams.set("hl", "en");
  return url.toString();
}
