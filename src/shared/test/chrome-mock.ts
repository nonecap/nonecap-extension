/** Minimal in-memory chrome.storage.local mock for unit tests. */

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type ChangeListener = (changes: Record<string, StorageChange>, areaName: string) => void;

export type ChromeMock = {
  /** Direct access to the backing store for assertions/seeding. */
  store: Record<string, unknown>;
  /** Wipe the store without firing change events. */
  reset(): void;
  /** Remove the global. */
  uninstall(): void;
};

export function installChromeMock(): ChromeMock {
  let store: Record<string, unknown> = {};
  const listeners = new Set<ChangeListener>();

  const emit = (changes: Record<string, StorageChange>): void => {
    for (const listener of [...listeners]) listener(changes, 'local');
  };

  const local = {
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      if (keys === null || keys === undefined) return { ...store };
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) {
        if (key in store) out[key] = store[key];
      }
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Record<string, StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store[key], newValue: value };
        store[key] = value;
      }
      emit(changes);
    },
    async remove(keys: string | string[]): Promise<void> {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, StorageChange> = {};
      for (const key of wanted) {
        if (!(key in store)) continue;
        changes[key] = { oldValue: store[key] };
        delete store[key];
      }
      emit(changes);
    },
  };

  const chromeMock = {
    storage: {
      local,
      onChanged: {
        addListener(fn: ChangeListener): void {
          listeners.add(fn);
        },
        removeListener(fn: ChangeListener): void {
          listeners.delete(fn);
        },
      },
    },
  };

  (globalThis as Record<string, unknown>)['chrome'] = chromeMock;

  return {
    get store() {
      return store;
    },
    reset() {
      store = {};
    },
    uninstall() {
      delete (globalThis as Record<string, unknown>)['chrome'];
    },
  };
}
