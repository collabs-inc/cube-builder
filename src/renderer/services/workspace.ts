// src/windows/web/shim/workspace.ts
//
// The single-renderer workspace-arrangement slice of `AppApi`
// (`workspaceLoad`/`workspaceSave`), over one `localStorage` key instead of
// main's `workspace-state.json` (`src/main/workspace-persistence.ts`).
//
// Main quarantines an unreadable file by renaming it to
// `workspace-state.json.corrupt`, so a later save never overwrites the
// evidence and a later load doesn't keep re-discovering it. The
// `localStorage` counterpart: a JSON parse failure — OR a shape main would
// also reject (neither version 3, 4, nor 5, `columns` not an array, matching
// `workspace-persistence.ts`'s `loadOwnWorkspaceState`) — moves the bad
// value aside to `WORKSPACE_STATE_KEY + ".corrupt"` and `workspaceLoad`
// resolves `null` — same outward behaviour (an unreadable state degrades to
// "start empty", not a thrown error), reached by renaming a key instead of
// a file. Unlike main, this stops at that coarse shape check — it does not
// repair individual columns/panes the way the renderer's own `hydrate` does
// downstream, same division of labor main draws.
//
// `workspaceSave` stamps `version: 5` on write, mirroring main's
// `saveWorkspace` (the renderer's `getPersistable()` hands over state
// without a `version` field either way, so the shim's own write must not
// fail its own load's shape check).
//
// `setItem` is wrapped in try/catch (`safeSetItem`): a storage-blocked
// context — Safari private browsing throws synchronously on `setItem`
// rather than silently no-opping — must not turn a debounced autosave into
// a rejected promise on every tick. Logged once per `createWorkspaceApi`
// instance rather than on every call, so a genuinely blocked browser
// doesn't spam the console for the lifetime of the tab.
//
// The default `storage` is `defaultStorage()`, not `globalThis.localStorage`:
// the property ACCESS itself throws on a storage-blocked origin, which would
// take the whole `installWindowApi()` down. See storage.ts.
type AppApi = { workspaceLoad(): Promise<unknown>; workspaceSave(state: WorkspaceSaveInput): Promise<void> };
import { defaultStorage } from "./storage";

const WORKSPACE_STATE_KEY = "workspace_state";

export interface WorkspaceApiDeps {
  storage?: Storage;
  storageKey?: string;
}

interface ParsedWorkspaceState {
  version: 3 | 4 | 5;
  columns: unknown[];
  [key: string]: unknown;
}

/** The shape `getPersistable()` hands `workspaceSave` — no `version`, mirroring
 * main's `WorkspaceSaveInput` (`Omit<WorkspaceState, "version">`). */
interface WorkspaceSaveInput {
  columns: unknown[];
  activeItemId: string | null;
  defaultWidthPx: number;
  mountedItemIds: string[];
  activeView: string;
  canvasTiles: unknown[];
  canvasViewport: unknown;
  canvasTileSizes: unknown;
  treePanes: unknown;
  machineStatusPanes?: unknown;
  screens: unknown[];
  selectedScreenIds?: unknown;
  openCheckoutIds?: unknown;
  itemMachineIds?: unknown;
}

function isWorkspaceStateShape(value: unknown): value is ParsedWorkspaceState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // Versions 3 and 4 are earlier shapes — load fine, the renderer's hydrate
  // defaults the missing canvas and screen fields (same policy as main's loader).
  return (v.version === 3 || v.version === 4 || v.version === 5) &&
    Array.isArray(v.columns);
}

export function createWorkspaceApi({ storage = defaultStorage(), storageKey = WORKSPACE_STATE_KEY }: WorkspaceApiDeps = {}): Pick<
  AppApi,
  "workspaceLoad" | "workspaceSave"
> {
  let loggedSetItemFailure = false;

  function safeSetItem(key: string, value: string): void {
    try {
      storage.setItem(key, value);
    } catch (err) {
      if (loggedSetItemFailure) return;
      loggedSetItemFailure = true;
      console.error(`[workspace] localStorage.setItem failed (storage blocked?): ${String(err)}`);
    }
  }

  /** The quarantine's other half: it runs on the LOAD path, so a throw here would break boot. */
  function safeRemoveItem(key: string): void {
    try {
      storage.removeItem(key);
    } catch (err) {
      console.error(`[workspace] localStorage.removeItem failed (storage blocked?): ${String(err)}`);
    }
  }

  return {
    workspaceLoad: () => {
      const raw = storage.getItem(storageKey);
      if (raw === null) return Promise.resolve(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.error(`[workspace] ${storageKey} unreadable: ${String(err)}`);
        safeSetItem(`${storageKey}.corrupt`, raw);
        safeRemoveItem(storageKey);
        return Promise.resolve(null);
      }
      if (!isWorkspaceStateShape(parsed)) {
        console.error(
          `[workspace] ${storageKey} unsupported shape (version=${String(
            (parsed as { version?: unknown } | null)?.version,
          )})`,
        );
        safeSetItem(`${storageKey}.corrupt`, raw);
        safeRemoveItem(storageKey);
        return Promise.resolve(null);
      }
      return Promise.resolve(parsed);
    },

    workspaceSave: (state) => {
      const input = state as WorkspaceSaveInput;
      safeSetItem(
        storageKey,
        JSON.stringify({
          version: 5,
          columns: input.columns,
          activeItemId: input.activeItemId,
          defaultWidthPx: input.defaultWidthPx,
          mountedItemIds: input.mountedItemIds,
          activeView: input.activeView,
          canvasTiles: input.canvasTiles,
          canvasViewport: input.canvasViewport,
          canvasTileSizes: input.canvasTileSizes,
          treePanes: input.treePanes,
          machineStatusPanes: input.machineStatusPanes,
          screens: input.screens,
          selectedScreenIds: input.selectedScreenIds,
          openCheckoutIds: input.openCheckoutIds,
          itemMachineIds: input.itemMachineIds,
        }),
      );
      return Promise.resolve();
    },
  } satisfies Pick<AppApi, "workspaceLoad" | "workspaceSave">;
}
