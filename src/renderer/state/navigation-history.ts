/**
 * Where you have been: a client-local history of places, walked by the
 * sidebar's back and forward arrows. A place is which screen shows and
 * which item is active.
 *
 * The history watches the workspace store that defines a place and records
 * a new entry whenever the place changes by anything other than the arrows
 * themselves; going back and then somewhere new drops the forward entries,
 * as a browser does. Never persisted — a relaunch starts a fresh history.
 */



import { requestInstantScreenNavigation } from "./screen-navigation";
import { setActiveItem, setActiveView, workspaceStore, type WorkspaceView } from "./workspace";

interface Place {
  view: WorkspaceView;
  itemId: string | null;
}

export interface NavigationHistoryState {
  canBack: boolean;
  canForward: boolean;
}

let entries: Place[] = [];
let index = -1;
let restoring = false;
let snapshot: NavigationHistoryState = { canBack: false, canForward: false };
const subscribers = new Set<() => void>();

function currentPlace(): Place {
  const workspace = workspaceStore.getSnapshot();
  return { view: workspace.activeView, itemId: workspace.activeItemId };
}

function samePlace(a: Place, b: Place): boolean {
  return a.view === b.view && a.itemId === b.itemId;
}

function publish(): void {
  const next = { canBack: index > 0, canForward: index < entries.length - 1 };
  if (next.canBack === snapshot.canBack && next.canForward === snapshot.canForward) return;
  snapshot = next;
  for (const callback of subscribers) callback();
}

function record(): void {
  if (restoring) return;
  const place = currentPlace();
  if (index >= 0 && samePlace(entries[index]!, place)) return;
  entries = [...entries.slice(0, index + 1), place];
  index = entries.length - 1;
  publish();
}

function restore(place: Place): void {
  restoring = true;
  try {
    const workspace = workspaceStore.getSnapshot();
    if (workspace.activeView !== place.view) {
      const id = place.view.startsWith("screen:") ? place.view.slice("screen:".length) : null;
      if (id) requestInstantScreenNavigation(id);
      setActiveView(place.view);
    }
    if (place.itemId) setActiveItem(place.itemId);
  } finally {
    restoring = false;
  }
}

export function back(): void {
  if (index <= 0) return;
  index -= 1;
  restore(entries[index]!);
  publish();
}

export function forward(): void {
  if (index >= entries.length - 1) return;
  index += 1;
  restore(entries[index]!);
  publish();
}

/** Begins watching the workspace store; records the current place as the first entry. Returns the stop function. */
export function startNavigationHistory(): () => void {
  record();
  const unsubscribeWorkspace = workspaceStore.subscribe(record);
  return () => { unsubscribeWorkspace(); };
}

export const navigationHistoryStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): NavigationHistoryState {
    return snapshot;
  },
};

export function _resetNavigationHistoryForTest(): void {
  entries = [];
  index = -1;
  restoring = false;
  snapshot = { canBack: false, canForward: false };
}
