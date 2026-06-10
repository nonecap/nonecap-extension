/**
 * The "may we solve here?" gate and the recognize bookkeeping wrapper,
 * extracted from index.ts so they are unit-testable with the chrome storage
 * mock. No chrome.* here — storage goes through the shared typed wrapper and
 * the API call + re-registration trigger are injected.
 */

import { get, getAll, set, type StoredStats } from '../shared/storage';
import type { ApiResult, RecognizeData, RecognizePayload, StatsData } from '../shared/api';

export type Gate = { proceed: boolean; reason: 'ok' | 'off' | 'no-solves' };

/**
 * Decide whether the extension may touch captchas on `host` right now.
 * Pass `task` to also apply the per-challenge-type toggles (the checkbox
 * gate omits it — challenge type is unknown until the popup opens).
 */
export async function evaluateGate(host: string, task?: 'grid' | 'single'): Promise<Gate> {
  const all = await getAll();
  const s = all.settings;
  if (!s.autoSolve || s.pausedHosts.includes(host) || s.blocklist.includes(host)) {
    return { proceed: false, reason: 'off' };
  }
  if (task !== undefined && !(task === 'grid' ? s.grid : s.drag)) {
    return { proceed: false, reason: 'off' };
  }
  // credits === null means we've never heard from the API yet (registration
  // may still be retrying), so proceed optimistically: recognize itself is
  // the authoritative gate and comes back daily_limit/no_credits if we're
  // wrong. Only a *known* zero balance blocks up front.
  const haveSolves = all.userKey !== null || (all.credits?.remaining ?? 1) > 0;
  if (!haveSolves) return { proceed: false, reason: 'no-solves' };
  return { proceed: true, reason: 'ok' };
}

export type RecognizeFn = (p: RecognizePayload) => Promise<ApiResult<RecognizeData>>;

/**
 * Wrap a recognize call with storage side effects, keeping the solve loop
 * pure:
 * - persist returned credits so badge/popup stay current;
 * - `usedFallback` means the stored userKey is dead → drop it;
 * - `no_key` → kick a fresh anonymous registration;
 * - `bad_key` with a userKey stored → the userKey was rejected (the api
 *   client's extKey fallback only covers 401): clear the userKey, keep the
 *   extKey; without a userKey it is the extKey itself that is dead → clear
 *   it and re-register.
 */
export function createRecognizeBookkeeper(opts: {
  recognize: RecognizeFn;
  /** Fire-and-forget trigger for a fresh anonymous registration. */
  reRegister: () => void;
}): RecognizeFn {
  return async (payload) => {
    const res = await opts.recognize(payload);
    if (res.ok) {
      if (res.data.credits !== undefined) {
        await set({
          credits: { remaining: res.data.credits.remaining, resetsAt: res.data.credits.resets_at },
        });
      }
      if (res.usedFallback) {
        await set({ userKey: null });
      }
      return res;
    }
    if (res.kind === 'no_key') {
      opts.reRegister();
    } else if (res.kind === 'bad_key') {
      const userKey = await get('userKey');
      if (userKey !== null) {
        await set({ userKey: null });
      } else {
        await set({ extKey: null });
        opts.reRegister();
      }
    }
    return res;
  };
}

/**
 * How long fetched stats stay fresh. Popup opens are the natural refresh
 * trigger (GET_STATE), so 5 minutes keeps the numbers feeling live while
 * bounding API chatter for someone who opens the popup constantly.
 */
export const STATS_TTL_MS = 5 * 60_000;

/** Pure staleness predicate for the stored monthly stats. */
export function statsAreStale(stats: StoredStats | null, now: number): boolean {
  return stats === null || now - stats.fetchedAt > STATS_TTL_MS;
}

/**
 * If a userKey is connected and the stored stats are missing/stale, fetch
 * fresh ones and persist them. Designed to be fired without awaiting from
 * the GET_STATE handler: the reply carries current state and the popup's
 * poll picks the refreshed numbers up on its next tick.
 */
export async function refreshStatsIfStale(
  fetchStats: () => Promise<ApiResult<StatsData>>,
  now: number = Date.now(),
): Promise<void> {
  const [userKey, stats] = await Promise.all([get('userKey'), get('stats')]);
  if (userKey === null) return; // free keys have no stats endpoint
  if (!statsAreStale(stats, now)) return;
  const res = await fetchStats();
  if (!res.ok) return; // keep the old numbers; next popup open retries
  await set({
    stats: {
      monthSolves: res.data.month_solves,
      monthCreditsSpent: res.data.month_credits_spent,
      solveRate: res.data.solve_rate,
      fetchedAt: now,
    },
  });
}
