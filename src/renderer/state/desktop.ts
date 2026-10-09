/**
 * The navigator's panel (desktop/Desktop.tsx, desktop/system/SystemPanel.tsx).
 *
 * One panel, anchored to the shell's left, showing the surface picked in
 * the strip. What this store holds is whether it is open, which surface it
 * shows and how wide it is. Every one of those persists locally.
 */



import { useSyncExternalStore } from "react";

/** The navigator's surface ids; desktop/system/surfaces.tsx defines strip order. */
export const SURFACE_IDS = ["personas", "projects", "harnesses", "apps", "services", "automations", "machine", "settings"] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];
export type NavigatorCategory = "all" | "repos" | "artifacts" | "images";

export interface DesktopState {
  open: boolean;
  /** Closed, but shown as an overlay while the pointer rests at the window's edge. Never persisted. */
  peek: boolean;
  /** The navigator's width, as the panel's grip left it. */
  navigatorWidth: number;
  navigatorCategory: NavigatorCategory;
  /** The surface the navigator's panel shows. */
  surface: SurfaceId;
}

type NavigatorPreferences = Pick<DesktopState, "open" | "navigatorWidth" | "surface" | "navigatorCategory">;
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const NAVIGATOR_KEY = "cube_navigator";
const defaults: NavigatorPreferences = { open: false, navigatorWidth: 420, surface: "projects", navigatorCategory: "repos" };

function storage(): PreferenceStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export function loadNavigatorPreferences(store: PreferenceStorage | null = storage()): NavigatorPreferences {
  try {
    const saved = JSON.parse(store?.getItem(NAVIGATOR_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return { ...defaults };
    return {
      open: typeof saved.open === "boolean" ? saved.open : defaults.open,
      navigatorWidth: typeof saved.navigatorWidth === "number" && Number.isFinite(saved.navigatorWidth) && saved.navigatorWidth >= 240 ? saved.navigatorWidth : defaults.navigatorWidth,
      surface: SURFACE_IDS.includes(saved.surface) ? saved.surface : defaults.surface,
      navigatorCategory: ["all", "repos", "artifacts", "images"].includes(saved.navigatorCategory) ? saved.navigatorCategory : defaults.navigatorCategory,
    };
  } catch { return { ...defaults }; }
}

export function saveNavigatorPreferences(value: NavigatorPreferences, store: PreferenceStorage | null = storage()): void {
  const { open, navigatorWidth, surface, navigatorCategory } = value;
  try { store?.setItem(NAVIGATOR_KEY, JSON.stringify({ open, navigatorWidth, surface, navigatorCategory })); } catch { /* Keep working when storage is unavailable. */ }
}

function initial(restore = true): DesktopState {
  return { ...(restore ? loadNavigatorPreferences() : defaults), peek: false };
}

let state: DesktopState = initial();

const subscribers = new Set<() => void>();

function set(next: DesktopState): void {
  if (next.open !== state.open || next.navigatorWidth !== state.navigatorWidth || next.surface !== state.surface || next.navigatorCategory !== state.navigatorCategory) saveNavigatorPreferences(next);
  state = next;
  for (const callback of subscribers) callback();
}

/** Opens the panel on the surface it last showed. */
export function openPanel(): void {
  if (state.open) return;
  set({ ...state, open: true, peek: false });
}

export function closePanel(): void {
  if (!state.open) return;
  set({ ...state, open: false, peek: false });
}

/** The peek: the closed panel shown as an overlay while the pointer is on it or at the window's edge. */
export function setPanelPeek(peek: boolean): void {
  if (state.open || state.peek === peek) return;
  set({ ...state, peek });
}

/** Narrower than this the machine cards' labels and marks collide. */
export const NAVIGATOR_MIN_WIDTH = 300;
/** Keep at least 320px for the workspace. CSS applies the same cap on window resize. */
export function setNavigatorWidth(width: number, layerWidth: number): void {
  const next = Math.min(Math.max(NAVIGATOR_MIN_WIDTH, width), Math.max(0, layerWidth - 320));
  if (next === state.navigatorWidth) return;
  set({ ...state, navigatorWidth: next });
}

export function togglePanel(): void {
  if (state.open) closePanel();
  else openPanel();
}

export function setSurface(surface: SurfaceId): void {
  if (state.surface === surface) return;
  set({ ...state, surface });
}

export function setNavigatorCategory(navigatorCategory: NavigatorCategory): void {
  if (state.navigatorCategory !== navigatorCategory) set({ ...state, navigatorCategory });
}

export const desktopStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => { subscribers.delete(callback); };
  },
  getSnapshot(): DesktopState {
    return state;
  },
};

export function usePanel(): DesktopState {
  return useSyncExternalStore(desktopStore.subscribe, desktopStore.getSnapshot);
}

export function _resetDesktopForTest(): void {
  set(initial(false));
}

