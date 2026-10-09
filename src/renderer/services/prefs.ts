// src/windows/web/shim/prefs.ts
//
// The prefs/config slice of `AppApi`, over `localStorage` instead of main's
// `config.json` (`src/main/config.ts`). `getPref`/`setPref` mirror
// `getPref`/`setPref` there — `config.ui[key] ?? null` becomes
// `localStorage["pref:"+key]`, JSON-encoded so a pref can hold any
// JSON-safe value, not just a string. `getWorkspacePref`/`setWorkspacePref`
// do the same for `workspace-config.ts`'s per-workspace file, keyed by
// `workspacePath` instead of a directory on disk.
//
// `getConfig` has no `localStorage` counterpart: main's `AppConfig` carries
// `window_state` (native window geometry) and `ui` (a legacy catch-all a
// couple of call sites still read through `getConfig()` rather than
// `getPref`), neither of which means anything in a browser tab — there is
// no window to save geometry for, and nothing here ever wrote to `ui`
// directly. The constant below is what a freshly-installed desktop app
// would also see on its very first launch, before a window has ever moved.
//
// `getAppVersion` reads `packageInfo.version`, a vite `define`
// (vite.config.web.ts) rather than `app.getVersion()` — there is no Electron
// `app` in a browser tab. It is declared once, globally, in
// src/windows/web/env.d.ts.
//
// `getDeviceId` mirrors `analytics.ts`'s `getDeviceId`: mint a
// `crypto.randomUUID()` once and persist it, instead of writing a
// `device-id` file under `CUBE_DIR`.
//
// Every `setItem` here goes through `safeSetItem`: a storage-blocked
// context (Safari private browsing throws synchronously on `setItem`
// rather than no-opping) must not turn a pref write into a rejected
// promise — `setPref`/`setWorkspacePref` fire on a debounce tick, so a
// throw there would otherwise repeat on every one. Logged once per
// `createPrefsApi` instance, not once per call.
//
// The default `storage` is `defaultStorage()`, not `globalThis.localStorage`:
// the property ACCESS itself throws on a storage-blocked origin, which would
// take the whole `installWindowApi()` down. See storage.ts.
import type { AppConfig } from "@port/shared/types";
import type { DesktopService, PrefsService } from './types';
import packageInfo from '../../../package.json';
type AppApi = Pick<DesktopService, 'getConfig' | 'getAppVersion' | 'getDeviceId'> & {
 getPref: PrefsService['get']; setPref: PrefsService['set']; getWorkspacePref: PrefsService['getWorkspace']; setWorkspacePref: PrefsService['setWorkspace'];
};
import { defaultStorage } from "./storage";

const PREF_PREFIX = "pref:";
const WORKSPACE_PREF_PREFIX = "wpref:";
const DEVICE_ID_KEY = "device_id";

export interface PrefsApiDeps {
  storage?: Storage;
}

/** Re-parses `raw` as JSON, defaulting to `null` on absence or corruption — matches main's `getPref`'s `?? null`. */
function readJsonPref(storage: Storage, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createPrefsApi({ storage = defaultStorage() }: PrefsApiDeps = {}): Pick<
  AppApi,
  | "getConfig"
  | "getAppVersion"
  | "getDeviceId"
  | "getPref"
  | "setPref"
  | "getWorkspacePref"
  | "setWorkspacePref"
> {
  let loggedSetItemFailure = false;

  function safeSetItem(key: string, value: string): void {
    try {
      storage.setItem(key, value);
    } catch (err) {
      if (loggedSetItemFailure) return;
      loggedSetItemFailure = true;
      console.error(`[prefs] localStorage.setItem failed (storage blocked?): ${String(err)}`);
    }
  }

  return {
    getConfig: () => Promise.resolve({ window_state: null, ui: {} } satisfies AppConfig),

    getAppVersion: () => Promise.resolve(packageInfo.version),

    getDeviceId: () => {
      const existing = storage.getItem(DEVICE_ID_KEY);
      if (existing) return Promise.resolve(existing);
      const minted = crypto.randomUUID();
      safeSetItem(DEVICE_ID_KEY, minted);
      return Promise.resolve(minted);
    },

    getPref: (key) => Promise.resolve(readJsonPref(storage, PREF_PREFIX + key)),
    setPref: (key, value) => {
      safeSetItem(PREF_PREFIX + key, JSON.stringify(value));
      return Promise.resolve();
    },

    getWorkspacePref: (key, workspacePath) =>
      Promise.resolve(readJsonPref(storage, WORKSPACE_PREF_PREFIX + workspacePath + ":" + key)),
    setWorkspacePref: (key, value, workspacePath) => {
      safeSetItem(WORKSPACE_PREF_PREFIX + workspacePath + ":" + key, JSON.stringify(value));
      return Promise.resolve();
    },
  } satisfies Pick<
    AppApi,
    | "getConfig"
    | "getAppVersion"
    | "getDeviceId"
    | "getPref"
    | "setPref"
    | "getWorkspacePref"
    | "setWorkspacePref"
  >;
}
