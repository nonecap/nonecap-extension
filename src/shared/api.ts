/**
 * Typed client for the NoneCap extension API.
 *
 * No exceptions ever cross this seam: every function returns a
 * discriminated result. Keys and the API base are read via storage.ts
 * (this module's only — indirect — chrome dependency).
 */

import type { ExtAction } from './messages';
import { get as storageGet } from './storage';

export const DEFAULT_API_BASE = 'https://api.nonecap.com';

const RECOGNIZE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export type ApiErrorKind =
  | 'daily_limit'
  | 'no_credits'
  | 'bad_key'
  | 'rate_limited'
  | 'network'
  | 'server';

export type ApiResult<T> =
  | { ok: true; data: T; usedFallback?: true }
  | { ok: false; kind: ApiErrorKind; message: string };

export type RegisterData = { key: string; daily_limit: number };

export type RecognizePayload = {
  /** Base64 PNG, no data-url prefix. */
  image: string;
  task: 'grid' | 'single';
  host: string;
  session?: string | null;
};

export type RecognizeData = ExtAction & {
  session: string;
  /** Present on free (nc_ext_) keys. */
  credits?: { remaining: number; resets_at: string };
  /** Present on user (nc_live_/nc_test_) keys. */
  credits_charged?: number;
};

export type OutcomePayload = {
  session: string;
  result: 'solved' | 'failed';
  rounds?: number;
};

export type OutcomeData = { ok: true };

export type StatsData = {
  month_solves: number;
  month_credits_spent: number;
  solve_rate: number | null;
};

type Failure = { ok: false; kind: ApiErrorKind; message: string; status: number | null };
type InternalResult<T> = { ok: true; data: T } | Failure;

function mapError(status: number, code: string | null): ApiErrorKind {
  if (status === 402 && code === 'ext_daily_limit') return 'daily_limit';
  if (status === 402 && code === 'insufficient_credits') return 'no_credits';
  if (status === 401 || status === 403) return 'bad_key';
  if (status === 429) return 'rate_limited';
  return 'server';
}

async function request<T>(
  path: string,
  opts: { method: 'GET' | 'POST'; body?: unknown; key?: string; timeoutMs: number },
): Promise<InternalResult<T>> {
  const base = (await storageGet('apiBase')) ?? DEFAULT_API_BASE;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method,
      headers: {
        'content-type': 'application/json',
        ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch {
    return { ok: false, kind: 'network', message: 'Could not reach the NoneCap API', status: null };
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (res.ok) {
    if (json === null || typeof json !== 'object') {
      return { ok: false, kind: 'server', message: 'Malformed response from the NoneCap API', status: res.status };
    }
    return { ok: true, data: json as T };
  }

  const err =
    json !== null && typeof json === 'object' && 'error' in json
      ? (json as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const code = typeof err?.code === 'string' ? err.code : null;
  const message =
    typeof err?.message === 'string' && err.message.length > 0
      ? err.message
      : `NoneCap API error (HTTP ${res.status})`;
  return { ok: false, kind: mapError(res.status, code), message, status: res.status };
}

function strip<T>(result: InternalResult<T>): ApiResult<T> {
  if (result.ok) return result;
  return { ok: false, kind: result.kind, message: result.message };
}

/**
 * Run an authenticated call with the preferred key (userKey ?? extKey).
 * If the call fails 401 while a userKey was used and an extKey exists,
 * retry once with the extKey; on a successful retry the result carries
 * `usedFallback: true` so the caller can mark the user key invalid while
 * still solving.
 */
async function withKeyFallback<T>(
  call: (key: string) => Promise<InternalResult<T>>,
): Promise<ApiResult<T>> {
  const [userKey, extKey] = await Promise.all([storageGet('userKey'), storageGet('extKey')]);
  const key = userKey ?? extKey;
  if (!key) return { ok: false, kind: 'bad_key', message: 'No API key configured' };

  const first = await call(key);
  if (first.ok) return first;

  if (first.status === 401 && userKey !== null && key === userKey && extKey !== null) {
    const retry = await call(extKey);
    if (retry.ok) return { ok: true, data: retry.data, usedFallback: true };
    return strip(retry);
  }
  return strip(first);
}

/** Register an anonymous free-tier install key. No auth. */
export async function register(): Promise<ApiResult<RegisterData>> {
  const result = await request<RegisterData>('/v1/ext/register', {
    method: 'POST',
    body: {},
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  return strip(result);
}

/** Submit a challenge screenshot for recognition. */
export async function recognize(payload: RecognizePayload): Promise<ApiResult<RecognizeData>> {
  return withKeyFallback((key) =>
    request<RecognizeData>('/v1/ext/recognize', {
      method: 'POST',
      body: payload,
      key,
      timeoutMs: RECOGNIZE_TIMEOUT_MS,
    }),
  );
}

/** Report the outcome of a solve session. */
export async function outcome(payload: OutcomePayload): Promise<ApiResult<OutcomeData>> {
  const [userKey, extKey] = await Promise.all([storageGet('userKey'), storageGet('extKey')]);
  const key = userKey ?? extKey;
  if (!key) return { ok: false, kind: 'bad_key', message: 'No API key configured' };
  const result = await request<OutcomeData>('/v1/ext/outcome', {
    method: 'POST',
    body: payload,
    key,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  return strip(result);
}

/**
 * Fetch monthly usage stats (user keys only; free keys get 403 → bad_key).
 * Pass `keyOverride` to validate a key before storing it — no fallback then.
 */
export async function stats(keyOverride?: string): Promise<ApiResult<StatsData>> {
  const call = (key: string): Promise<InternalResult<StatsData>> =>
    request<StatsData>('/v1/ext/stats', {
      method: 'GET',
      key,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  if (keyOverride !== undefined) return strip(await call(keyOverride));
  return withKeyFallback(call);
}
