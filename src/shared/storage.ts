/**
 * Typed wrapper over chrome.storage.local.
 *
 * This is the ONLY module in src/shared that touches chrome.* APIs.
 * All access is lazy (inside functions), so the module can be imported
 * in tests before a chrome mock is installed.
 */

import { DEFAULT_SETTINGS, type Settings } from './settings';

export type StoredCredits = { remaining: number; resetsAt: string };
export type StoredLastSolve = { secs: number; at: number };
export type StoredStats = {
  monthSolves: number;
  monthCreditsSpent: number;
  solveRate: number | null;
  fetchedAt: number;
};

export type StorageShape = {
  /** Anonymous free-tier install key (nc_ext_…). */
  extKey: string | null;
  /** User-connected key (nc_live_… / nc_test_…). */
  userKey: string | null;
  settings: Settings;
  credits: StoredCredits | null;
  lastSolve: StoredLastSolve | null;
  stats: StoredStats | null;
  /** Override for the API base URL; null = production default. */
  apiBase: string | null;
};

export type StorageKey = keyof StorageShape;

const STORAGE_KEYS: readonly StorageKey[] = [
  'extKey',
  'userKey',
  'settings',
  'credits',
  'lastSolve',
  'stats',
  'apiBase',
] as const;

/** Merge a possibly-partial/missing stored settings value with the defaults. */
export function mergeSettings(stored: unknown): Settings {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  const partial = stored as Partial<Settings>;
  return {
    autoSolve: partial.autoSolve ?? DEFAULT_SETTINGS.autoSolve,
    style: partial.style ?? DEFAULT_SETTINGS.style,
    showOverlay: partial.showOverlay ?? DEFAULT_SETTINGS.showOverlay,
    grid: partial.grid ?? DEFAULT_SETTINGS.grid,
    drag: partial.drag ?? DEFAULT_SETTINGS.drag,
    blocklist: Array.isArray(partial.blocklist) ? [...partial.blocklist] : [...DEFAULT_SETTINGS.blocklist],
    pausedHosts: Array.isArray(partial.pausedHosts)
      ? [...partial.pausedHosts]
      : [...DEFAULT_SETTINGS.pausedHosts],
  };
}

function normalize(raw: Record<string, unknown>): StorageShape {
  return {
    extKey: (raw['extKey'] as string | null | undefined) ?? null,
    userKey: (raw['userKey'] as string | null | undefined) ?? null,
    settings: mergeSettings(raw['settings']),
    credits: (raw['credits'] as StoredCredits | null | undefined) ?? null,
    lastSolve: (raw['lastSolve'] as StoredLastSolve | null | undefined) ?? null,
    stats: (raw['stats'] as StoredStats | null | undefined) ?? null,
    apiBase: (raw['apiBase'] as string | null | undefined) ?? null,
  };
}

/** Read the entire typed storage shape, with settings deep-merged with defaults. */
export async function getAll(): Promise<StorageShape> {
  const raw = await chrome.storage.local.get(null);
  return normalize(raw);
}

/** Read a single key, with settings deep-merged with defaults. */
export async function get<K extends StorageKey>(key: K): Promise<StorageShape[K]> {
  const raw = await chrome.storage.local.get(key);
  return normalize(raw)[key];
}

/** Write a partial set of keys. */
export async function set(partial: Partial<StorageShape>): Promise<void> {
  await chrome.storage.local.set(partial);
}

/**
 * Subscribe to storage changes. The callback receives a typed partial with
 * the new values of the keys that changed (settings merged with defaults).
 * Returns an unsubscribe function.
 */
export function subscribe(cb: (changes: Partial<StorageShape>) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const partial: Partial<StorageShape> = {};
    let any = false;
    for (const key of STORAGE_KEYS) {
      if (!(key in changes)) continue;
      any = true;
      const next = changes[key]?.newValue;
      if (key === 'settings') {
        partial.settings = mergeSettings(next);
      } else {
        // Removed keys surface as undefined → normalize to null.
        (partial as Record<string, unknown>)[key] = next ?? null;
      }
    }
    if (any) cb(partial);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
