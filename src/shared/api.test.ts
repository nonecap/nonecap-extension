import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './test/chrome-mock';
import { DEFAULT_API_BASE, recognize, register, stats, outcome, type ApiErrorKind } from './api';

const USER_KEY = 'nc_live_user';
const EXT_KEY = 'nc_ext_install';

let chromeMock: ChromeMock;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message = 'nope'): Response {
  return jsonResponse(status, { error: { code, message } });
}

function authHeaderOfCall(index: number): string | undefined {
  const call = fetchMock.mock.calls[index];
  expect(call).toBeDefined();
  const init = call![1] as RequestInit;
  return (init.headers as Record<string, string>)['authorization'];
}

const recognizePayload = { image: 'aGk=', task: 'grid' as const, host: 'example.com' };

beforeEach(() => {
  chromeMock = installChromeMock();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  chromeMock.uninstall();
});

describe('error mapping', () => {
  const matrix: [status: number, code: string, kind: ApiErrorKind][] = [
    [402, 'ext_daily_limit', 'daily_limit'],
    [402, 'insufficient_credits', 'no_credits'],
    [401, 'unauthorized', 'bad_key'],
    [403, 'account_locked', 'bad_key'],
    [429, 'rate_limited', 'rate_limited'],
    [413, 'validation_error', 'server'],
    [422, 'validation_error', 'server'],
    [500, 'internal_error', 'server'],
    [503, 'unavailable', 'server'],
  ];

  it.each(matrix)('maps HTTP %i %s → %s', async (status, code, kind) => {
    chromeMock.store['extKey'] = EXT_KEY; // ext key only → no fallback path
    fetchMock.mockResolvedValueOnce(errorResponse(status, code));
    const result = await recognize(recognizePayload);
    expect(result).toEqual({ ok: false, kind, message: 'nope' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a fetch throw to network', async () => {
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'));
    const result = await recognize(recognizePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('network');
  });

  it('maps an AbortSignal timeout to network with a timeout message', async () => {
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    const result = await recognize(recognizePayload);
    expect(result).toEqual({ ok: false, kind: 'network', message: 'Request timed out' });
  });

  it('maps malformed JSON on a 200 to server', async () => {
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockResolvedValueOnce(new Response('definitely not json', { status: 200 }));
    const result = await recognize(recognizePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('server');
  });

  it('fails with no_key when no key is configured at all', async () => {
    const result = await recognize(recognizePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('no_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('recognize', () => {
  it('passes free-tier credits through and uses the ext key', async () => {
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        session: 'extsess_1',
        action: 'click_tiles',
        tiles: [0, 4, 7],
        credits: { remaining: 87, resets_at: '2026-06-11T00:00:00Z' },
      }),
    );
    const result = await recognize(recognizePayload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.session).toBe('extsess_1');
      expect(result.data.action).toBe('click_tiles');
      expect(result.data.credits).toEqual({ remaining: 87, resets_at: '2026-06-11T00:00:00Z' });
      expect(result.usedFallback).toBeUndefined();
    }
    expect(authHeaderOfCall(0)).toBe(`Bearer ${EXT_KEY}`);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${DEFAULT_API_BASE}/v1/ext/recognize`);
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual(recognizePayload);
  });

  it('prefers the user key when both keys exist', async () => {
    chromeMock.store['userKey'] = USER_KEY;
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { session: 'extsess_2', action: 'refresh', credits_charged: 12 }),
    );
    const result = await recognize(recognizePayload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.credits_charged).toBe(12);
    expect(authHeaderOfCall(0)).toBe(`Bearer ${USER_KEY}`);
  });

  it('retries once with the ext key on a user-key 401 and marks usedFallback', async () => {
    chromeMock.store['userKey'] = USER_KEY;
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock
      .mockResolvedValueOnce(errorResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(
        jsonResponse(200, { session: 'extsess_3', action: 'click_points', points: [{ x: 500, y: 500 }] }),
      );
    const result = await recognize(recognizePayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeaderOfCall(0)).toBe(`Bearer ${USER_KEY}`);
    expect(authHeaderOfCall(1)).toBe(`Bearer ${EXT_KEY}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usedFallback).toBe(true);
      expect(result.data.session).toBe('extsess_3');
    }
  });

  it('surfaces the retry failure when the ext-key fallback also fails', async () => {
    chromeMock.store['userKey'] = USER_KEY;
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock
      .mockResolvedValueOnce(errorResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(errorResponse(402, 'ext_daily_limit'));
    const result = await recognize(recognizePayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('daily_limit');
  });

  it('does NOT retry on a user-key 403', async () => {
    chromeMock.store['userKey'] = USER_KEY;
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockResolvedValueOnce(errorResponse(403, 'account_locked'));
    const result = await recognize(recognizePayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('bad_key');
  });

  it('does NOT retry when there is no ext key to fall back to', async () => {
    chromeMock.store['userKey'] = USER_KEY;
    fetchMock.mockResolvedValueOnce(errorResponse(401, 'unauthorized'));
    const result = await recognize(recognizePayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('bad_key');
  });

  it('respects the apiBase override from storage', async () => {
    chromeMock.store['extKey'] = EXT_KEY;
    chromeMock.store['apiBase'] = 'http://localhost:8787';
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { session: 's', action: 'refresh' }));
    await recognize(recognizePayload);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8787/v1/ext/recognize');
  });
});

describe('register', () => {
  it('posts without auth and returns the new key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { key: 'nc_ext_new', daily_limit: 100 }));
    const result = await register();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ key: 'nc_ext_new', daily_limit: 100 });
    expect(authHeaderOfCall(0)).toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe(`${DEFAULT_API_BASE}/v1/ext/register`);
  });

  it('maps register 429 to rate_limited', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(429, 'rate_limited'));
    const result = await register();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('rate_limited');
  });
});

describe('outcome', () => {
  it('posts the session outcome with the selected key', async () => {
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await outcome({ session: 'extsess_1', result: 'solved', rounds: 2 });
    expect(result.ok).toBe(true);
    expect(authHeaderOfCall(0)).toBe(`Bearer ${EXT_KEY}`);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${DEFAULT_API_BASE}/v1/ext/outcome`);
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      session: 'extsess_1',
      result: 'solved',
      rounds: 2,
    });
  });

  it('retries with the ext key when the user key is dead (401) and marks usedFallback', async () => {
    chromeMock.store['userKey'] = USER_KEY;
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock
      .mockResolvedValueOnce(errorResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await outcome({ session: 'extsess_9', result: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeaderOfCall(0)).toBe(`Bearer ${USER_KEY}`);
    expect(authHeaderOfCall(1)).toBe(`Bearer ${EXT_KEY}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usedFallback).toBe(true);
  });

  it('fails with no_key when no key is configured', async () => {
    const result = await outcome({ session: 'extsess_9', result: 'solved' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('no_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('stats', () => {
  it('GETs stats with the user key and falls back on 401', async () => {
    chromeMock.store['userKey'] = USER_KEY;
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock
      .mockResolvedValueOnce(errorResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(
        jsonResponse(200, { month_solves: 5, month_credits_spent: 50, solve_rate: 0.8 }),
      );
    const result = await stats();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usedFallback).toBe(true);
      expect(result.data.month_solves).toBe(5);
    }
  });

  it('uses keyOverride verbatim with NO fallback', async () => {
    chromeMock.store['userKey'] = USER_KEY;
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockResolvedValueOnce(errorResponse(401, 'unauthorized'));
    const result = await stats('nc_live_candidate');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeaderOfCall(0)).toBe('Bearer nc_live_candidate');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('bad_key');
  });

  it('maps the free-key 403 forbidden to bad_key', async () => {
    chromeMock.store['extKey'] = EXT_KEY;
    fetchMock.mockResolvedValueOnce(errorResponse(403, 'forbidden'));
    const result = await stats();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('bad_key');
  });
});
