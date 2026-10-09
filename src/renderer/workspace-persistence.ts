/**
 * Wires the workspace store to services.workspace: loads the persisted
 * state once on start, then debounce-saves the store on every subsequent
 * mutation (matching the old canvas tile-manager's 500ms debounce — see
 * src/windows/shell/src/tile-manager.js's saveCanvasDebounced/Immediate).
 *
 * Ignore notifications from hydration itself. If the store changes while
 * the asynchronous load is pending, keep and save those edits instead.
 *
 * Pure — no DOM/React — so it's testable directly against the store and a
 * fake services instance; App.tsx's useEffect only calls start()/dispose().
 */



import { services } from "./services";
import { hydrateScreens as hydrate, workspaceStore } from "./state/workspace";

const DEFAULT_SAVE_DEBOUNCE_MS = 500;

export interface WorkspacePersistenceOptions {
  /** Debounce interval before an auto-save fires after a mutation. Defaults to 500ms. */
  debounceMs?: number;
}

export interface WorkspacePersistence {
  /** Resolves after initial hydration or preservation of intervening edits. */
  ready: Promise<void>;
  /** Persists the current store state immediately, canceling any pending debounce. */
  saveNow(): void;
  /** Unsubscribes from the store and cancels any pending debounced save. */
  dispose(): void;
}

export function startWorkspacePersistence(
  options: WorkspacePersistenceOptions = {},
): WorkspacePersistence {
  const debounceMs = options.debounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
  let hydrating = false;
  let mutated = false;
  let loading = true;
  // React StrictMode double-mounts effects in dev, so dispose() can run
  // before the in-flight load() below resolves — without this flag, the
  // disposed instance's callback would still hydrate() the (module-global)
  // workspace store on top of whatever the second, live instance already
  // loaded.
  let disposed = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const saveNow = (): void => {
    if (loading && !mutated) return;
    clearTimeout(saveTimer);
    services.workspace.save(workspaceStore.getPersistable()).catch((err: unknown) => {
      console.error("[app] workspace save failed:", err);
    });
  };

  const saveDebounced = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, debounceMs);
  };

  const unsubscribe = workspaceStore.subscribe(() => {
    if (hydrating) return;
    mutated = true;
    saveDebounced();
  });

  const ready = services.workspace
    .load()
    .then((persisted) => {
      if (disposed) return;
      loading = false;
      if (mutated) { saveNow(); return; }
      hydrating = true;
      try { hydrate(persisted ?? { activeItemId: null }); }
      finally { hydrating = false; }
    })
    .catch((err: unknown) => {
      if (disposed) return;
      loading = false;
      console.error("[app] workspace load failed:", err);
      if (mutated) { saveNow(); return; }
      hydrating = true;
      try { hydrate({ activeItemId: null }); }
      finally { hydrating = false; }
    });

  return {
    ready,
    saveNow,
    dispose() {
      disposed = true;
      clearTimeout(saveTimer);
      unsubscribe();
    },
  };
}
