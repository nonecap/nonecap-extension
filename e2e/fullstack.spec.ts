/**
 * OPTIONAL full-stack e2e: the built extension against a LOCALLY-RUN real
 * NoneCap API (monorepo packages/api) with REAL Gemini vision, on the real
 * hCaptcha demo widget. Skipped unless FULLSTACK=1 — it spends real Gemini
 * money (one attempt, up to MAX_ROUNDS=6 recognize rounds ≈ $0.002).
 *
 * Prerequisites (NOT managed by this spec):
 *   1. The monorepo API running locally against a TEST database with a real
 *      GEMINI_API_KEY, e.g. from packages/api:
 *        DATABASE_URL=$TEST_DATABASE_URL GEMINI_API_KEY=... PORT=8790 npx tsx src/server.ts
 *   2. bun run build (dist/ must exist).
 *
 * Run:  FULLSTACK=1 bunx playwright test e2e/fullstack.spec.ts
 * Override the API base with FULLSTACK_API (default http://127.0.0.1:8790).
 *
 * Unlike solve.spec.ts this spec does NOT seed an extKey: the extension's
 * real onInstalled → POST /v1/ext/register flow runs against the local API
 * (the prod hostname is dead-ended via --host-resolver-rules so nothing can
 * ever reach api.nonecap.com). Engagement and billing are observed through
 * chrome.storage (`credits.remaining` drops as the API meters rounds);
 * server-side rows (ext_installs / ext_usage / ext_sessions) are meant to be
 * verified directly in the test DB by whoever runs this.
 */

import { expect, test, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const API = process.env.FULLSTACK_API ?? 'http://127.0.0.1:8790';
const DEMO_URL = 'https://accounts.hcaptcha.com/demo';

test.skip(!process.env.FULLSTACK, 'full-stack e2e is opt-in: FULLSTACK=1 (spends real Gemini money)');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, stepMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return false;
}

let context: BrowserContext | null = null;

async function extensionServiceWorker(ctx: BrowserContext): Promise<Worker> {
  const existing = ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (existing) return existing;
  return ctx.waitForEvent('serviceworker', { timeout: 15_000 });
}

type Stored = { extKey: string | null; remaining: number | null };

async function readStored(sw: Worker): Promise<Stored> {
  return sw.evaluate(async () => {
    const all = await chrome.storage.local.get(['extKey', 'credits']);
    return {
      extKey: (all.extKey as string | undefined) ?? null,
      remaining: (all.credits as { remaining: number } | undefined)?.remaining ?? null,
    };
  });
}

function tokenPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[name=h-captcha-response]');
    return ta !== null && ta.value.trim().length > 0;
  });
}

function pillStatus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-nonecap=pill]');
    return host?.shadowRoot?.querySelector('.p-status')?.textContent ?? '';
  });
}

test.beforeAll(async () => {
  expect(
    existsSync(path.join(DIST, 'manifest.json')),
    'dist/manifest.json missing — run `bun run build` first',
  ).toBe(true);

  // The real API must already be up (this spec never spawns it: it needs a
  // test DATABASE_URL and a Gemini key only the monorepo side knows about).
  let healthy = false;
  try {
    healthy = (await fetch(`${API}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    healthy = false;
  }
  expect(healthy, `no API at ${API} — start packages/api against the TEST database first`).toBe(true);

  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      // Safety net: even though apiBase is seeded immediately, make sure the
      // production API is unreachable no matter what.
      '--host-resolver-rules=MAP api.nonecap.com 127.0.0.1',
    ],
  });

  // Seed ONLY apiBase — registration must happen through the real flow.
  const sw = await extensionServiceWorker(context);
  await sw.evaluate(async (apiBase) => {
    await chrome.storage.local.set({ apiBase });
  }, API);
});

test.afterAll(async () => {
  await context?.close();
});

test('full stack: real register → real challenge → real Gemini rounds → terminal outcome', async () => {
  test.setTimeout(300_000);
  const ctx = context!;
  const sw = await extensionServiceWorker(ctx);

  // ---- 1. Real registration -------------------------------------------------
  // onInstalled fired at launch; if its register attempt raced ahead of the
  // apiBase seed (and died on the dead-ended prod host), nudge the retry
  // alarm instead of waiting out its 1-minute backoff.
  if ((await readStored(sw)).extKey === null) {
    await sw.evaluate(async () => {
      await chrome.alarms.create('register-retry', { delayInMinutes: 0.002 });
    });
  }
  const registered = await waitFor(async () => (await readStored(sw)).extKey !== null, 90_000, 500);
  expect(registered, 'extension never obtained a key from the local API').toBe(true);
  const afterRegister = await readStored(sw);
  expect(afterRegister.extKey!.startsWith('nc_ext_'), `unexpected key shape: ${afterRegister.extKey}`).toBe(true);
  expect(afterRegister.remaining, 'register must seed the free daily balance').toBe(100);
  console.log(`[fullstack] registered key ${afterRegister.extKey} (balance ${afterRegister.remaining})`);

  // ---- 2. Engage a real challenge --------------------------------------------
  // Engagement signal: credits.remaining drops below 100, i.e. the API
  // metered a recognize round (which also proves the upload + Gemini call +
  // billed response round-tripped). hCaptcha sometimes passively passes a
  // clean IP without serving a challenge — retry with a fresh page.
  let page: Page | null = null;
  let engaged = false;
  for (let attempt = 1; attempt <= 3 && !engaged; attempt++) {
    if (page) await page.close();
    page = await ctx.newPage();
    await page.goto(DEMO_URL);
    engaged = await waitFor(async () => {
      const { remaining } = await readStored(sw);
      return remaining !== null && remaining < 100;
    }, 45_000);
    if (!engaged) {
      const passive = await tokenPresent(page);
      console.warn(
        `[fullstack] attempt ${attempt}: no billed round within 45s` +
          (passive ? ' (passive pass: token granted without a challenge)' : ' (challenge never opened)') +
          (attempt < 3 ? ' — retrying with a fresh page' : ''),
      );
    }
  }
  expect(engaged, 'no recognize round was ever billed — the loop never reached the API').toBe(true);
  const activePage = page!;

  // ---- 3. Terminal state ------------------------------------------------------
  // solved: hCaptcha accepted the REAL Gemini answers (token lands / pill
  //         flips to Solved);
  // failed: the extension gave up after MAX_ROUNDS / watchdog. Real-answer
  //         accuracy isn't guaranteed on whatever challenge was served, so a
  //         clean give-up still passes (with a warning); the outcome row in
  //         ext_sessions is verified DB-side by the runner.
  let end: 'solved' | 'gave-up' | null = null;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && end === null) {
    if ((await tokenPresent(activePage)) || (await pillStatus(activePage)).includes('Solved')) {
      end = 'solved';
      break;
    }
    const status = await pillStatus(activePage);
    const busy = status === '' || /Detected|Opening|Solving|Verifying/i.test(status);
    if (!busy) {
      end = 'gave-up';
      break;
    }
    await sleep(500);
  }
  expect(end, 'attempt neither solved nor settled within 150s').not.toBeNull();

  const final = await readStored(sw);
  const rounds = 100 - (final.remaining ?? 100);
  console.log(`[fullstack] terminal=${end} roundsBilled=${rounds} remaining=${final.remaining}`);
  expect(rounds, 'at least one billed round must have happened').toBeGreaterThanOrEqual(1);
  expect(rounds, 'more rounds billed than MAX_ROUNDS allows — runaway loop?').toBeLessThanOrEqual(6);
  if (end === 'gave-up') {
    console.warn(
      '[fullstack] PASS WITH WARNING: hCaptcha did not accept the real Gemini answers; ' +
        'the extension gave up cleanly. Loop + billing mechanics proven end to end.',
    );
  }

  // Let the async outcome ping land before the runner inspects ext_sessions.
  await sleep(4_000);
  await activePage.close();
});
