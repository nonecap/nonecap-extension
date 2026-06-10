import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from '../shared/test/chrome-mock';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import type { ApiResult, RecognizeData, RecognizePayload } from '../shared/api';
import { createRecognizeBookkeeper, evaluateGate } from './gate';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  mock.uninstall();
});

const settings = (partial: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...partial });

describe('evaluateGate', () => {
  it('proceeds with default settings, no keys and NULL credits (optimistic)', async () => {
    // credits === null means the API has never answered (registration may
    // still be retrying). We deliberately proceed: recognize is the
    // authoritative gate and reports daily_limit/no_credits if we're wrong.
    expect(await evaluateGate('example.com', 'grid')).toEqual({ proceed: true, reason: 'ok' });
  });

  it('blocks when autoSolve is off', async () => {
    await chrome.storage.local.set({ settings: settings({ autoSolve: false }) });
    expect(await evaluateGate('example.com', 'grid')).toEqual({ proceed: false, reason: 'off' });
  });

  it('blocks a paused host', async () => {
    await chrome.storage.local.set({ settings: settings({ pausedHosts: ['example.com'] }) });
    expect(await evaluateGate('example.com', 'grid')).toEqual({ proceed: false, reason: 'off' });
    expect(await evaluateGate('other.com', 'grid')).toEqual({ proceed: true, reason: 'ok' });
  });

  it('blocks a blocklisted host', async () => {
    await chrome.storage.local.set({ settings: settings({ blocklist: ['example.com'] }) });
    expect(await evaluateGate('example.com', 'grid')).toEqual({ proceed: false, reason: 'off' });
  });

  it('blocks grid tasks when the grid toggle is off (drag still allowed)', async () => {
    await chrome.storage.local.set({ settings: settings({ grid: false }) });
    expect(await evaluateGate('example.com', 'grid')).toEqual({ proceed: false, reason: 'off' });
    expect(await evaluateGate('example.com', 'single')).toEqual({ proceed: true, reason: 'ok' });
  });

  it('blocks single (drag) tasks when the drag toggle is off', async () => {
    await chrome.storage.local.set({ settings: settings({ drag: false }) });
    expect(await evaluateGate('example.com', 'single')).toEqual({ proceed: false, reason: 'off' });
    expect(await evaluateGate('example.com', 'grid')).toEqual({ proceed: true, reason: 'ok' });
  });

  it('omitting the task skips the per-type toggles (checkbox gate)', async () => {
    await chrome.storage.local.set({ settings: settings({ grid: false, drag: false }) });
    expect(await evaluateGate('example.com')).toEqual({ proceed: true, reason: 'ok' });
  });

  it('blocks on a known zero balance without a user key', async () => {
    await chrome.storage.local.set({ credits: { remaining: 0, resetsAt: 'soon' } });
    expect(await evaluateGate('example.com', 'grid')).toEqual({
      proceed: false,
      reason: 'no-solves',
    });
  });

  it('a user key bypasses the credits check', async () => {
    await chrome.storage.local.set({
      credits: { remaining: 0, resetsAt: 'soon' },
      userKey: 'nc_live_x',
    });
    expect(await evaluateGate('example.com', 'grid')).toEqual({ proceed: true, reason: 'ok' });
  });
});

describe('createRecognizeBookkeeper', () => {
  type Result = ApiResult<RecognizeData>;
  const payload: RecognizePayload = { image: 'PNG', task: 'grid', host: 'example.com', session: null };

  function make(result: Result) {
    const recognize = vi.fn(async () => result);
    const reRegister = vi.fn();
    return { wrapped: createRecognizeBookkeeper({ recognize, reRegister }), recognize, reRegister };
  }

  it('persists credits from a successful recognize response', async () => {
    const { wrapped } = make({
      ok: true,
      data: {
        action: 'click_tiles',
        tiles: [1],
        session: 's1',
        credits: { remaining: 41, resets_at: '2026-06-11T00:00:00Z' },
      },
    });
    const res = await wrapped(payload);
    expect(res.ok).toBe(true);
    expect(mock.store['credits']).toEqual({ remaining: 41, resetsAt: '2026-06-11T00:00:00Z' });
  });

  it('usedFallback clears the (dead) userKey but keeps solving', async () => {
    await chrome.storage.local.set({ userKey: 'nc_live_dead', extKey: 'nc_ext_ok' });
    const { wrapped } = make({
      ok: true,
      usedFallback: true,
      data: { action: 'click_tiles', tiles: [], session: 's1' },
    });
    const res = await wrapped(payload);
    expect(res.ok).toBe(true);
    expect(mock.store['userKey']).toBeNull();
    expect(mock.store['extKey']).toBe('nc_ext_ok');
  });

  it('no_key triggers a re-registration attempt', async () => {
    const { wrapped, reRegister } = make({ ok: false, kind: 'no_key', message: 'no key' });
    const res = await wrapped(payload);
    expect(res).toEqual({ ok: false, kind: 'no_key', message: 'no key' });
    expect(reRegister).toHaveBeenCalledTimes(1);
  });

  it('bad_key with a userKey stored clears the userKey, not the extKey', async () => {
    await chrome.storage.local.set({ userKey: 'nc_live_bad', extKey: 'nc_ext_ok' });
    const { wrapped, reRegister } = make({ ok: false, kind: 'bad_key', message: 'rejected' });
    await wrapped(payload);
    expect(mock.store['userKey']).toBeNull();
    expect(mock.store['extKey']).toBe('nc_ext_ok');
    expect(reRegister).not.toHaveBeenCalled();
  });

  it('bad_key without a userKey clears the extKey and re-registers', async () => {
    await chrome.storage.local.set({ extKey: 'nc_ext_dead' });
    const { wrapped, reRegister } = make({ ok: false, kind: 'bad_key', message: 'rejected' });
    await wrapped(payload);
    expect(mock.store['extKey']).toBeNull();
    expect(reRegister).toHaveBeenCalledTimes(1);
  });

  it('transient failures pass through without side effects', async () => {
    await chrome.storage.local.set({ userKey: 'nc_live_x', extKey: 'nc_ext_y' });
    const { wrapped, reRegister } = make({ ok: false, kind: 'network', message: 'down' });
    const res = await wrapped(payload);
    expect(res.ok).toBe(false);
    expect(mock.store['userKey']).toBe('nc_live_x');
    expect(mock.store['extKey']).toBe('nc_ext_y');
    expect(reRegister).not.toHaveBeenCalled();
  });
});
