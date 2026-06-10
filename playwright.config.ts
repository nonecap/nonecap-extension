/**
 * Playwright config for the LOCAL-ONLY e2e suite (e2e/solve.spec.ts).
 *
 * Deliberately not wired into CI: MV3 extensions only load in headed
 * Chromium (headless cannot install unpacked extensions), the flow drives a
 * real hCaptcha widget over the network, and macOS/Linux desktop sessions
 * are assumed. Run it yourself with `bun run e2e`.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  // One worker, no parallelism: the suite owns global resources (the mock
  // API port, a headed browser, the hCaptcha demo widget).
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    // The spec launches its own persistent context (required for
    // --load-extension); these defaults only apply to incidental pages.
    actionTimeout: 15_000,
  },
});
