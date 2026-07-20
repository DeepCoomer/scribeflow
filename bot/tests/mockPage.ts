import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

// No CI run ever joins a real Meet (docs/meet-bot.md — Testing strategy).
// Route interception serves the local mock page for real navigations to
// https://meet.google.com/*, so `page.url()` genuinely carries the Meet
// origin the join-flow/lifecycle code checks against, without any real
// network traffic leaving the process.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "mockMeet.html");

export async function setupMockMeetRoutes(page: Page): Promise<void> {
  const html = await readFile(fixturePath, "utf8");
  await page.route("https://meet.google.com/**", (route) =>
    route.fulfill({ body: html, contentType: "text/html" }),
  );
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ body: "<html><h1>Sign in</h1></html>", contentType: "text/html" }),
  );
  await page.route("https://example.com/**", (route) =>
    route.fulfill({ body: "<html>kicked</html>", contentType: "text/html" }),
  );
}

export function buildMockMeetUrl(
  scenario = "prejoin",
  extraParams: Record<string, string> = {},
): string {
  const params = new URLSearchParams({ scenario, ...extraParams });
  return `https://meet.google.com/abc-defg-hij?${params.toString()}`;
}

/** Navigates directly — used by tests that don't go through runJoinFlow's
 * own goto (e.g. lifecycle tests, which start already "in call"). */
export async function gotoMockMeet(
  page: Page,
  scenario = "prejoin",
  extraParams: Record<string, string> = {},
): Promise<void> {
  await setupMockMeetRoutes(page);
  await page.goto(buildMockMeetUrl(scenario, extraParams), {
    waitUntil: "domcontentloaded",
  });
}

export function noopFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}
