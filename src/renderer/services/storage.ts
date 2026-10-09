// src/windows/web/shim/storage.ts
//
// Where every `localStorage`-backed group in this shim gets its `Storage`
// from, and the reason it is a function rather than `globalThis.localStorage`
// written four times.
//
// TOUCHING `globalThis.localStorage` CAN THROW. Not `getItem` — the property
// ACCESS itself. A browser configured to block site data for this origin
// (Chrome's "Block third-party cookies"/"Don't allow sites to save data",
// Firefox's cookie blocking, a Safari private window in some versions, an
// iframe with no storage access) raises `SecurityError` the moment the
// property is read. Every store here resolved its default eagerly in its
// factory, so ONE such browser turned `installWindowApi()` into a throw —
// which the entry did not catch, so the tab painted the index gradient and
// nothing else, forever. That is strictly worse than the app running with no
// persistence: a blocked profile can still sign in, open a terminal, and work
// for the length of the tab's life.
//
// So: probe once per call, in a try/catch, and fall back to a Map that
// implements the same interface. The fallback is a MODULE-LEVEL SINGLETON on
// purpose — the four stores (prefs, workspace, registry, the supabase session)
// share one `localStorage` namespace on a normal profile and must keep sharing
// one namespace here, or the account layer would write a session that the
// registry's own view of storage cannot see.
//
// What is deliberately NOT done: caching the probe's result. A test stubs
// `globalThis.localStorage` (registry.test.ts does, via defineProperty) and a
// cached first answer would outlive the stub; the probe is two property reads,
// and it runs once per store construction, not once per get.

/**
 * `globalThis.localStorage`, or null when the browser refuses it. The access
 * itself is what throws — see this module's header.
 */
export function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A `Storage` over a `Map`. Same interface, no persistence past this tab. */
export function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

let fallback: Storage | null = null;
let loggedFallback = false;

/**
 * The default every store here uses: the real `localStorage` when this origin
 * has one, otherwise the one shared in-memory stand-in. Logged once per page,
 * not once per store, so a blocked profile gets one honest line rather than
 * four identical ones.
 */
export function defaultStorage(): Storage {
  const real = getStorage();
  if (real) return real;
  if (!loggedFallback) {
    loggedFallback = true;
    console.warn(
      "[storage] localStorage is unavailable (site data blocked?) — "
        + "falling back to in-memory storage: nothing will survive a reload",
    );
  }
  fallback ??= createMemoryStorage();
  return fallback;
}
