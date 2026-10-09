import { useSyncExternalStore } from "react";

export interface StudioRepoView {
  showWorktrees: boolean;
  showArtifacts: boolean;
}

export const STUDIO_REPO_VIEW_KEY = "cube_studio_repo_view";
const DEFAULT_VIEW: StudioRepoView = { showWorktrees: false, showArtifacts: true };

export function loadStudioRepoView(store?: Pick<Storage, "getItem"> | null): StudioRepoView {
  try {
    const saved: unknown = JSON.parse((store === undefined ? localStorage : store)?.getItem(STUDIO_REPO_VIEW_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return DEFAULT_VIEW;
    const value = saved as Partial<StudioRepoView>;
    return {
      showWorktrees: typeof value.showWorktrees === "boolean" ? value.showWorktrees : DEFAULT_VIEW.showWorktrees,
      showArtifacts: typeof value.showArtifacts === "boolean" ? value.showArtifacts : DEFAULT_VIEW.showArtifacts,
    };
  } catch { return DEFAULT_VIEW; }
}

let state = loadStudioRepoView();
const listeners = new Set<() => void>();
export const studioRepoViewStore = {
  getSnapshot: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

/** Studio-only presentation preferences; catalog and workspace state stay intact. */
export function toggleStudioRepoView(key: keyof StudioRepoView): void {
  state = { ...state, [key]: !state[key] };
  try { localStorage.setItem(STUDIO_REPO_VIEW_KEY, JSON.stringify(state)); } catch { /* Storage may be blocked. */ }
  for (const listener of listeners) listener();
}

export function useStudioRepoView(): StudioRepoView {
  return useSyncExternalStore(studioRepoViewStore.subscribe, studioRepoViewStore.getSnapshot);
}

export function _resetStudioRepoViewForTest(): void {
  state = DEFAULT_VIEW;
  for (const listener of listeners) listener();
}
