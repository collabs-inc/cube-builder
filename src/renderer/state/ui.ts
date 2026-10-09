/**
 * App-wide UI flags that don't belong to the workspace or repos domain
 * models — whether the settings modal is open, and whether the active pane
 * is zoomed. Same plain module-store shape as workspace.ts: a private
 * module-level state object, a subscriber Set, and a useSyncExternalStore
 * hook.
 *
 * Shortcut gate: while the settings modal is open, every other shortcut
 * handler must no-op (mirroring the old shell's gate, renderer.js:1015-1018
 * — `if (settingsModalOpen && action !== "toggle-settings") { focusSurface
 * ("settings"); return; }`). Consumers read `uiStore.getSnapshot()`
 * directly inside their onShortcut callback rather than subscribing via
 * `useUiState()`, since they only need the value at the moment a shortcut
 * fires, not a re-render when it changes — see Desktop.tsx's "add-repo"/
 * "sidebar-files" handlers. shortcuts.ts's central handleShortcut
 * (which replaces this per-component onShortcut wiring) consults the same
 * flag for every action other than "toggle-settings".
 *
 * `paneZoomed` is view state only — a temporary fullscreen of the active
 * pane within the rail, not persisted and not part of the layout model in
 * workspace.ts/layout-ops.ts. It follows focus within the current screen;
 * Rail.tsx clears it when switching screens or when no active tile remains.
 */



import { useSyncExternalStore } from "react";

export type NarrowView = "home" | "item";

export interface UiState {
  settingsModalOpen: boolean;
  settingsPane: string | null;
  /** Explicit pane requests can repeat while the Settings app stays mounted. */
  settingsRequestId: number;
  paneZoomed: boolean;
  /** Tab-to-sidebar correspondence; transient and never persisted. */
  hoveredCheckoutId: string | null;
  /**
   * Whether Settings shows its hidden Developer section (daemon state and
   * the two kill switches). Revealed by a chord inside the modal and held
   * here rather than in the modal's own state so it survives closing and
   * reopening within a run — but never persisted, so it re-hides on the
   * next launch.
   */
  developerUnlocked: boolean;
  /**
   * Which screen the list-first narrow projection shows: the home list or
   * the active item. Meaningless above the breakpoint. Initial value is
   * "item" on purpose: a desktop window dragged under the breakpoint
   * keeps showing the thing it was showing; `effectiveNarrowView` sends a
   * viewport with no active item to "home" regardless, which is what a
   * phone's first launch hits. App.tsx resets this to "item" while wide,
   * so every narrow *entry* starts from the same place.
   *
   * Persisted per device (localStorage, `loadNarrowView`) since
   * 2026-09-04: the workspace's `activeItemId` survives a relaunch, so a
   * phone that was closed on the home list came back on that item every
   * time. Reading it back at module load is what makes the installed PWA
   * reopen on the screen it was on. The wide-mode reset above writes
   * "item" too, which is harmless — a desktop never reads it narrow.
   */
  narrowView: NarrowView;
  /**
   * Set when a surface outside Billing (the Machine tab's specs row) asks
   * Billing to open its switch-to-prepaid confirmation. Billing clears it
   * once it opens the dialog, or when it unmounts without being able to.
   */
  prepaidSwitchRequested: boolean;
  /**
   * Which machine the sidebar's tree shows: the panel shows one machine
   * section at a time, chosen by the switch in its titlebar strip. Client-
   * local and per device, like `narrowView` — which panel you are looking
   * at is not a fact about the machine. Defaults to cloud, where the agents
   * that run unattended live.
   */
  sidebarMachine: SidebarMachine;
}

export type SidebarMachine = "cloud" | "local";

const NARROW_VIEW_KEY = "cube_narrow_view";
const SIDEBAR_MACHINE_KEY = "cube_sidebar_machine";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // the accessor itself throws where site data is blocked
  }
}

/** The persisted narrow screen, or "item" when unset, unreadable or foreign. */
export function loadNarrowView(store: StorageLike | null = storage()): NarrowView {
  try {
    const v = store?.getItem(NARROW_VIEW_KEY);
    return v === "home" || v === "item" ? v : "item";
  } catch {
    return "item";
  }
}

function saveNarrowView(view: NarrowView, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(NARROW_VIEW_KEY, view);
  } catch {
    // Storage full or blocked: the view still changes for this run.
  }
}

/** The persisted sidebar machine, or "cloud" when unset, unreadable or foreign. */
export function loadSidebarMachine(store: StorageLike | null = storage()): SidebarMachine {
  try {
    const v = store?.getItem(SIDEBAR_MACHINE_KEY);
    return v === "cloud" || v === "local" ? v : "cloud";
  } catch {
    return "cloud";
  }
}

function saveSidebarMachine(machine: SidebarMachine, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(SIDEBAR_MACHINE_KEY, machine);
  } catch {
    // Storage full or blocked: the choice still holds for this run.
  }
}

let state: UiState = {
  settingsModalOpen: false,
  settingsPane: null,
  settingsRequestId: 0,
  paneZoomed: false,
  hoveredCheckoutId: null,
  developerUnlocked: false,
  narrowView: loadNarrowView(),
  prepaidSwitchRequested: false,
  sidebarMachine: loadSidebarMachine(),
};
const subscribers = new Set<() => void>();

function notify(): void {
  for (const callback of subscribers) callback();
}

/**
 * Sets the settings-modal-open flag and which pane it should show. A no-op
 * if `open` already matches and no pane was requested — but a non-null
 * `pane` always re-renders, even while already open, so it can retarget an
 * open modal to a different pane (e.g. the unpaired-Cloud empty state).
 */
export function setSettingsModalOpen(open: boolean, pane: string | null = null): void {
  if (state.settingsModalOpen === open && !pane) return;
  state = { ...state, settingsModalOpen: open, settingsPane: pane, settingsRequestId: state.settingsRequestId + 1 };
  notify();
}

/** Records a request for Billing to open its switch-to-prepaid confirmation. */
export function setPrepaidSwitchRequested(requested: boolean): void {
  if (state.prepaidSwitchRequested === requested) return;
  state = { ...state, prepaidSwitchRequested: requested };
  notify();
}

/** Toggles the active pane's temporary fullscreen zoom (view state only). */
export function togglePaneZoom(): void {
  state = { ...state, paneZoomed: !state.paneZoomed };
  notify();
}

/** Sets the zoom flag. A no-op if it already matches. */
export function setPaneZoomed(zoomed: boolean): void {
  if (state.paneZoomed === zoomed) return;
  state = { ...state, paneZoomed: zoomed };
  notify();
}

export function setHoveredCheckoutId(checkoutId: string | null): void {
  if (state.hoveredCheckoutId === checkoutId) return;
  state = { ...state, hoveredCheckoutId: checkoutId };
  notify();
}

/** Reveals (or re-hides) Settings' Developer section. A no-op if unchanged. */
export function setDeveloperUnlocked(unlocked: boolean): void {
  if (state.developerUnlocked === unlocked) return;
  state = { ...state, developerUnlocked: unlocked };
  notify();
}

/** Sets which narrow screen shows. A no-op if it already matches. */
export function setSidebarMachine(machine: SidebarMachine): void {
  if (state.sidebarMachine === machine) return;
  state = { ...state, sidebarMachine: machine };
  saveSidebarMachine(machine);
  notify();
}

export function setNarrowView(view: NarrowView): void {
  if (state.narrowView === view) return;
  state = { ...state, narrowView: view };
  saveNarrowView(view);
  notify();
}

/**
 * The screen the narrow projection actually shows. Pure: with no active
 * item there is nothing to zoom (reconcileColumns nulls activeItemId when
 * another client closes it), so "home" wins regardless of narrowView —
 * this is also what replaces ItemSwitcher's old re-pick-an-active-item
 * effect: instead of picking a survivor, the projection falls back to the
 * list.
 */
export function effectiveNarrowView(
  view: NarrowView,
  activeItemId: string | null,
): NarrowView {
  return activeItemId === null ? "home" : view;
}

export const uiStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): UiState {
    return state;
  },
};

/** Subscribes a React component to the ui store. */
export function useUiState(): UiState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot);
}
