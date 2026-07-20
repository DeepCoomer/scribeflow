import { defineConfig } from "vitest/config";

// Mock-Meet-page tests drive a real (headless) Chromium instance through
// several polling loops each — slower than a pure unit test, so the
// default 5s per-test timeout is too tight.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // The join-flow/lifecycle suites drive a real headless Chromium through
    // wall-clock polling loops; under CPU contention a CDP round-trip can
    // occasionally stall well past its usual ~10-100ms, which looks
    // identical to a hang from vitest's side. One retry absorbs that
    // environment noise without masking a real regression (a genuine logic
    // bug fails deterministically, not once-in-N runs).
    retry: 2,
    // Each test file that launches its own Playwright Chromium instance
    // (join flow / lifecycle) gets its own OS process — sharing a
    // worker-thread pool across files caused an intermittent hang on the
    // first navigation right after a previous file's browser.close(), most
    // likely a CDP-connection race between the two Chromium instances.
    pool: "forks",
    // Multiple headless Chromium instances racing in parallel starve each
    // other's event loop under CPU contention, which turns the wall-clock
    // timing assertions in joinFlow/lifecycle tests flaky. One file's
    // browser at a time keeps the timing margins meaningful.
    fileParallelism: false,
  },
});
