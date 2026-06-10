import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './test/chrome-mock';
import { DEFAULT_SETTINGS } from './settings';
import { getAll, get, set, subscribe, mergeSettings, type StorageShape } from './storage';

let chromeMock: ChromeMock;

beforeEach(() => {
  chromeMock = installChromeMock();
});

afterEach(() => {
  chromeMock.uninstall();
});

describe('getAll', () => {
  it('returns defaults on an empty store', async () => {
    const all = await getAll();
    expect(all).toEqual({
      extKey: null,
      userKey: null,
      settings: DEFAULT_SETTINGS,
      credits: null,
      lastSolve: null,
      stats: null,
      apiBase: null,
    } satisfies StorageShape);
  });

  it('round-trips values written via set()', async () => {
    await set({
      extKey: 'nc_ext_a',
      credits: { remaining: 42, resetsAt: '2026-06-11T00:00:00Z' },
      lastSolve: { secs: 7.2, at: 1760000000000 },
    });
    const all = await getAll();
    expect(all.extKey).toBe('nc_ext_a');
    expect(all.credits).toEqual({ remaining: 42, resetsAt: '2026-06-11T00:00:00Z' });
    expect(all.lastSolve).toEqual({ secs: 7.2, at: 1760000000000 });
    expect(all.userKey).toBeNull();
  });
});

describe('get', () => {
  it('reads a single key', async () => {
    await set({ userKey: 'nc_live_x' });
    expect(await get('userKey')).toBe('nc_live_x');
    expect(await get('apiBase')).toBeNull();
  });

  it('deep-merges stored partial settings with defaults', async () => {
    chromeMock.store['settings'] = { autoSolve: false, blocklist: ['bank.example'] };
    const settings = await get('settings');
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      autoSolve: false,
      blocklist: ['bank.example'],
    });
  });

  it('returns full defaults when stored settings are garbage', async () => {
    chromeMock.store['settings'] = 'corrupt';
    expect(await get('settings')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('mergeSettings', () => {
  it('never hands out references into DEFAULT_SETTINGS', () => {
    const merged = mergeSettings(undefined);
    merged.blocklist.push('mutated.example');
    expect(DEFAULT_SETTINGS.blocklist).toEqual([]);
  });
});

describe('subscribe', () => {
  it('delivers typed partials for changed keys', async () => {
    const cb = vi.fn();
    subscribe(cb);
    await set({ userKey: 'nc_live_1', settings: { ...DEFAULT_SETTINGS, style: 'fast' } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({
      userKey: 'nc_live_1',
      settings: { ...DEFAULT_SETTINGS, style: 'fast' },
    });
  });

  it('merges partial settings in change events with defaults', async () => {
    const cb = vi.fn();
    subscribe(cb);
    await chrome.storage.local.set({ settings: { grid: false } });
    expect(cb).toHaveBeenCalledWith({ settings: { ...DEFAULT_SETTINGS, grid: false } });
  });

  it('normalizes removed keys to null', async () => {
    await set({ userKey: 'nc_live_1' });
    const cb = vi.fn();
    subscribe(cb);
    await chrome.storage.local.remove('userKey');
    expect(cb).toHaveBeenCalledWith({ userKey: null });
  });

  it('ignores keys outside the typed shape', async () => {
    const cb = vi.fn();
    subscribe(cb);
    await chrome.storage.local.set({ unrelated: 123 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', async () => {
    const cb = vi.fn();
    const unsubscribe = subscribe(cb);
    unsubscribe();
    await set({ extKey: 'nc_ext_b' });
    expect(cb).not.toHaveBeenCalled();
  });
});
