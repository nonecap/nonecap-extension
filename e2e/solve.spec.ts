/**
 * End-to-end tests of the extension against REAL hCaptcha widgets with the
 * NoneCap API mocked locally (scripts/mock-api.ts).
 *
 * LOCAL ONLY — not wired into CI. MV3 extensions can only be loaded into
 * headed Chromium (headless Chrome cannot install unpacked extensions), so
 * this suite opens a visible browser window and needs a desktop session.
 * Run: bun run build && bun run e2e
 *
 * Two tests, because hCaptcha's publisher TEST sitekey turns out not to
 * exercise the solve loop at all (verified empirically): clicking its
 * checkbox immediately grants the canned pass token
 * 10000000-aaaa-bbbb-cccc-000000000001 without ever serving a challenge.
 *
 *  1. Local fixture (test sitekey): proves widget detection, the background
 *     gate, the checkbox click and the token watcher — the front half of the
 *     pipeline — on an arbitrary http page. No recognize traffic can happen.
 *
 *  2. https://accounts.hcaptcha.com/demo (real sitekey): hCaptcha serves a
 *     real challenge here, which exercises the full loop — capture, crop,
 *     recognize upload (mock-validated PNG >= 100x100), action execution in
 *     the challenge frame, and the outcome ping.
 *
 * What test 2 does NOT prove: recognition accuracy. The mock plays fixed
 * answers (grid: tiles [1,3] then verify; single: a fixed drag), which are
 * almost certainly wrong for whatever challenge hCaptcha serves. Both
 * legitimate endings are accepted:
 *   solved — hCaptcha accepted anyway: token lands in
 *            textarea[name=h-captcha-response] / the pill shows "Solved";
 *   failed — hCaptcha kept re-challenging until the extension hit MAX_ROUNDS
 *            (or pulled the challenge) and reported outcome 'failed'. That
 *            still proves the loop mechanics, so it passes with a warning.
 */

import { expect, test, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, type JournalEntry } from '../scripts/mock-api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Share the port with mock-api.ts (single source of truth) and pass it back
// to the spawned server via PORT so the two can never drift.
const MOCK_PORT = DEFAULT_PORT;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PAGE_PORT = 8788;
const FIXTURE_URL = `http://127.0.0.1:${PAGE_PORT}/demo.html`;
const DEMO_URL = 'https://accounts.hcaptcha.com/demo';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, stepMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return false;
}

// ---- mock API helpers --------------------------------------------------------

async function mockUp(): Promise<boolean> {
  try {
    const res = await fetch(`${MOCK}/__log`, { signal: AbortSignal.timeout(1000) });
    return res.ok; // a non-ok answer means port 8787 is held by something else
  } catch {
    return false;
  }
}

async function fetchJournal(): Promise<JournalEntry[]> {
  const res = await fetch(`${MOCK}/__log`);
  const json = (await res.json()) as { requests: JournalEntry[] };
  return json.requests;
}

const resetJournal = async (): Promise<void> => {
  await fetch(`${MOCK}/__reset`, { method: 'POST' });
};
const recognizeEntries = async (): Promise<JournalEntry[]> =>
  (await fetchJournal()).filter((e) => e.path === '/v1/ext/recognize');
const outcomeEntries = async (): Promise<JournalEntry[]> =>
  (await fetchJournal()).filter((e) => e.path === '/v1/ext/outcome');

// ---- shared resources ----------------------------------------------------------

let mockProc: ChildProcess | null = null;
let pageServer: Server | null = null;
let context: BrowserContext | null = null;

test.beforeAll(async () => {
  expect(
    existsSync(path.join(DIST, 'manifest.json')),
    'dist/manifest.json missing — run `bun run build` before `bun run e2e`',
  ).toBe(true);

  // 1. Mock NoneCap API. Reuse a server that is already running (dev
  //    convenience); otherwise spawn `bun scripts/mock-api.ts` and wait for it.
  if (!(await mockUp())) {
    mockProc = spawn('bun', [path.join(ROOT, 'scripts', 'mock-api.ts')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Keep the child on the same port the spec talks to (single constant).
      env: { ...process.env, PORT: String(MOCK_PORT) },
    });
    mockProc.stdout?.on('data', (d: Buffer) => process.stdout.write(d.toString()));
    mockProc.stderr?.on('data', (d: Buffer) => process.stderr.write(d.toString()));
    // A mid-run crash would otherwise surface only as opaque fetch failures.
    mockProc.on('exit', (code) => {
      if (code !== null && code !== 0) console.error(`[e2e] mock API exited unexpectedly with code ${code}`);
    });
    const up = await waitFor(mockUp, 10_000, 200);
    expect(
      up,
      `mock API never came up on 127.0.0.1:${MOCK_PORT} (is the port held by another process?)`,
    ).toBe(true);
  }

  // 2. Tiny static server for the fixture page. Content scripts do not
  //    reliably inject into file:// pages, so the fixture must be http://.
  const html = readFileSync(path.join(ROOT, 'e2e', 'fixtures', 'demo.html'));
  pageServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => pageServer!.listen(PAGE_PORT, '127.0.0.1', resolve));

  // 3. Headed Chromium with the built extension. headless: false is REQUIRED:
  //    headless Chromium refuses --load-extension for MV3 extensions.
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      // The extension's onInstalled handler immediately tries to register an
      // anonymous key against the PRODUCTION API (apiBase is seeded only
      // after launch). Dead-end the prod hostname so the e2e never makes a
      // real API call; the alarm-backed retry later hits the mock instead.
      '--host-resolver-rules=MAP api.nonecap.com 127.0.0.1',
    ],
  });

  // Seed storage through the extension's service worker BEFORE any page
  // opens: apiBase points the API client at the mock (the mock accepts any
  // Bearer key, so a fake extKey skips the register flow), and a known
  // credit balance keeps the solve gate open.
  const sw = await extensionServiceWorker(context);
  await sw.evaluate(async (seed) => {
    await chrome.storage.local.set(seed);
  }, {
    extKey: 'nc_ext_e2etest00000000000000',
    apiBase: MOCK,
    credits: { remaining: 100, resetsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() },
  });
});

test.afterAll(async () => {
  await context?.close();
  pageServer?.close();
  mockProc?.kill();
});

// ---- helpers over the live browser ----------------------------------------------

async function extensionServiceWorker(ctx: BrowserContext): Promise<Worker> {
  const existing = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (existing) return existing;
  return ctx.waitForEvent('serviceworker', { timeout: 15_000 });
}

/** True when hCaptcha has written a token into the page's response textarea. */
function tokenPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[name=h-captcha-response]');
    return ta !== null && ta.value.trim().length > 0;
  });
}

/** Current status text of the on-page pill (open shadow DOM), '' when hidden. */
function pillStatus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-nonecap=pill]');
    return host?.shadowRoot?.querySelector('.p-status')?.textContent ?? '';
  });
}

// ---- test 1: local fixture, publisher test sitekey -------------------------------

test('fixture page: detects the widget, clicks the checkbox, token lands (test sitekey)', async () => {
  const ctx = context!;
  await resetJournal();

  const page = await ctx.newPage();
  await page.goto(FIXTURE_URL);

  // The pill flipping to "Captcha detected" proves the whole detection chain:
  // top-frame widget scan -> anchor-frame CHECKBOX_SEEN -> background gate
  // (settings + credits) said proceed -> PHASE pushed back to the top frame.
  const detected = await waitFor(async () => (await pillStatus(page)) !== '', 30_000, 250);
  expect(detected, 'pill never appeared — extension did not engage the widget').toBe(true);

  // With the test sitekey hCaptcha then grants the canned pass token on the
  // checkbox click without serving a challenge, so the token watcher is the
  // end of the line here. (Honesty note: hCaptcha may grant that token even
  // without a perfect click, so this asserts engagement + token plumbing,
  // not click mechanics — test 2 covers the real interaction.)
  const token = await waitFor(() => tokenPresent(page), 30_000, 250);
  expect(token, 'no h-captcha-response token within 30s').toBe(true);

  // No challenge ever opened, so the loop must not have called the API.
  expect(await recognizeEntries()).toHaveLength(0);
  expect(await outcomeEntries()).toHaveLength(0);

  await page.close();
});

// ---- test 2: real challenge on the hCaptcha demo page ------------------------------

test('demo page: full solve loop — capture, recognize, execute, outcome', async () => {
  // Worst case spends 3x30s engaging + 75s solving + settle; the suite-wide
  // 120s default is too tight for that.
  test.setTimeout(240_000);
  const ctx = context!;

  // Engage: the first recognize POST in the mock journal is the signal that
  // the whole front half worked (widget detected -> checkbox clicked ->
  // challenge opened -> rect served -> tab captured -> cropped PNG uploaded).
  // hCaptcha can passively pass a clean IP without serving a challenge, and
  // the widget is occasionally flaky about opening — retry the whole page
  // interaction up to 3 times.
  let page: Page | null = null;
  let engaged = false;
  for (let attempt = 1; attempt <= 3 && !engaged; attempt++) {
    // Close the previous attempt's page FIRST so its still-running solve loop
    // cannot POST into the journal we are about to reset (which would make the
    // fresh attempt look engaged before its own page has even loaded).
    if (page) await page.close();
    await resetJournal();
    page = await ctx.newPage();
    await page.goto(DEMO_URL);
    engaged = await waitFor(async () => (await recognizeEntries()).length > 0, 30_000);
    if (!engaged) {
      const passive = await tokenPresent(page);
      console.warn(
        `[e2e] attempt ${attempt}: no recognize call within 30s` +
          (passive ? ' (passive pass: token granted without a challenge)' : ' (challenge never opened)') +
          (attempt < 3 ? ' — retrying with a fresh page' : ''),
      );
    }
  }
  expect(engaged, 'extension never sent a recognize request after 3 attempts').toBe(true);
  const activePage = page!;

  // (1) Capture/crop correctness: the mock validates and journals every
  // upload. Every recognize request must have carried a decodable PNG of at
  // least 100x100 (a tiny or garbage image means the crop pipeline broke).
  const firstRecogs = await recognizeEntries();
  expect(firstRecogs.length).toBeGreaterThanOrEqual(1);

  // (3) Terminal state, within a generous window (multi-round attempts take
  // a while: up to MAX_ROUNDS=6 rounds of capture spacing + animated cursor +
  // hCaptcha round trips, plus the 20s ROUND_STALL_MS watchdog as a backstop).
  let end: 'solved' | 'failed' | null = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && end === null) {
    if ((await tokenPresent(activePage)) || (await pillStatus(activePage)).includes('Solved')) {
      end = 'solved';
      break;
    }
    if ((await outcomeEntries()).some((e) => e.outcome?.result === 'failed')) {
      end = 'failed';
      break;
    }
    await sleep(500);
  }
  expect(end, 'challenge neither solved nor reported failed within 90s').not.toBeNull();

  if (end === 'solved') {
    // The token watcher polls every 300ms and the outcome ping is async —
    // give the 'solved' outcome time to land before freezing the journal.
    const reported = await waitFor(async () => (await outcomeEntries()).length >= 1, 15_000);
    expect(reported, 'no outcome ping arrived after the token landed').toBe(true);
    expect((await outcomeEntries())[0]?.outcome?.result).toBe('solved');
  } else {
    // The extension gave up (MAX_ROUNDS, or the ROUND_STALL_MS watchdog on a
    // dead frame). It must NOT stay wedged on 'Verifying': failLoud shows the
    // error phase then lingers to idle. Assert the pill left "Verifying" so a
    // regression of the hang this suite was written to catch is caught.
    const unstuck = await waitFor(async () => !(await pillStatus(activePage)).includes('Verifying'), 30_000);
    expect(unstuck, 'pill stayed on "Verifying" after the failed outcome — attempt hung').toBe(true);
    console.warn(
      '[e2e] PASS WITH WARNING: hCaptcha did not accept the scripted answers and the ' +
        'extension correctly gave up (outcome=failed). Loop mechanics proven; ' +
        'recognition accuracy is not exercised by this suite (the mock plays a fixed script).',
    );
  }

  // Re-check every upload now that the attempt is over.
  for (const entry of await recognizeEntries()) {
    expect(entry.png, 'a recognize upload was not a decodable PNG').not.toBeNull();
    expect(entry.png!.width).toBeGreaterThanOrEqual(100);
    expect(entry.png!.height).toBeGreaterThanOrEqual(100);
    expect(entry.status, 'the mock rejected a recognize upload — see mock output').toBe(200);
  }

  // (2) Exactly one outcome ping once the flow settles. Close the page first
  // so a re-rendering challenge cannot start a fresh attempt while we wait.
  await activePage.close();
  await sleep(4_000);
  const outcomes = await outcomeEntries();
  expect(outcomes, `expected exactly 1 outcome ping, got ${outcomes.length}`).toHaveLength(1);
});
