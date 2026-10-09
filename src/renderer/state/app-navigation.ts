// App navigation belongs to this client, independently of workspace placement
// and daemon-owned items. Switching a view never closes the thing inside it.
import { useSyncExternalStore } from "react";
import type { AppNavigationSource } from "@port/shared/analytics";

export const BUILTIN_APP_IDS = ["workspace", "files", "market", "agents", "tools", "machine", "settings", "automations"] as const;
export type BuiltinAppId = (typeof BUILTIN_APP_IDS)[number];
export type AppTarget = { kind: "builtin"; id: BuiltinAppId } | { kind: "installed"; id: string };
export interface AppLocation { machineId: string; target: AppTarget }
type NavigationTransition =
  | { kind: "configure"; restored: boolean }
  | { kind: "open"; source: AppNavigationSource }
  | { kind: "reorder"; from: number; to: number; count: number }
  | { kind: "reconcile" };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
interface Preferences { sidebarOpen: boolean; sidebarWidth: number; studioSidebarOpen: boolean; studioSidebarWidth: number; finderSidebarWidth: number; selections: Record<string, AppTarget>; appOrders: Record<string, AppTarget[]> }
export interface AppNavigationState extends Preferences {
  enabled: boolean;
  accountId: string | null;
  machineId: string;
  active: AppTarget;
  visited: AppLocation[];
  /** Transient: Home keeps the last app selected, so relaunch resumes it. */
  mobileHomeOpen: boolean;
  /** Committed intent for store observers; never persisted or replayed. */
  transition: NavigationTransition | null;
}
const WORKSPACE: AppTarget = { kind: "builtin", id: "workspace" };
const defaults = (): Preferences => ({ sidebarOpen: true, sidebarWidth: 240, studioSidebarOpen: true, studioSidebarWidth: 256, finderSidebarWidth: 320, selections: {}, appOrders: {} });
const preferenceKey = (accountId: string | null) => `cube_app_navigation_v1:${accountId ?? "anonymous"}`;
export const appLocationKey = ({ machineId, target }: AppLocation): string =>
  JSON.stringify([target.kind === "builtin" && target.id === "settings" ? "global" : machineId, target.kind, target.id]);
export const appTargetKey = (target: AppTarget): string => JSON.stringify([target.kind, target.id]);

/** Builtins stay in registry order; saved installed positions survive partial catalogs. */
export function orderedAppTargets<T extends AppTarget>(available: readonly T[], saved: readonly AppTarget[] = []): T[] {
  const remaining = new Map(available.map(target => [appTargetKey(target), target]));
  const ordered: T[] = [];
  for (const [key, target] of remaining) {
    if (target.kind === "builtin") { ordered.push(target); remaining.delete(key); }
  }
  for (const target of saved) {
    const key = appTargetKey(target);
    const current = remaining.get(key);
    if (current) { ordered.push(current); remaining.delete(key); }
  }
  return [...ordered, ...remaining.values()];
}

function targetOf(value: unknown): AppTarget | null {
  if (!value || typeof value !== "object") return null;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  if (kind === "builtin" && BUILTIN_APP_IDS.includes(id as BuiltinAppId)) return { kind, id: id as BuiltinAppId };
  if (kind === "installed" && typeof id === "string" && id.length > 0 && id.length < 512) return { kind, id };
  return null;
}

function readPreferences(storage: StorageLike | null, accountId: string | null): Preferences {
  const prefs = defaults();
  try {
    const raw = JSON.parse(storage?.getItem(preferenceKey(accountId)) ?? "null");
    if (!raw || raw.version !== 1) return prefs;
    if (typeof raw.sidebarOpen === "boolean") prefs.sidebarOpen = raw.sidebarOpen;
    if (typeof raw.studioSidebarOpen === "boolean") prefs.studioSidebarOpen = raw.studioSidebarOpen;
    if (Number.isFinite(raw.sidebarWidth) && raw.sidebarWidth >= 200 && raw.sidebarWidth <= 400) prefs.sidebarWidth = raw.sidebarWidth;
    for (const key of ["studioSidebarWidth", "finderSidebarWidth"] as const) {
      if (Number.isFinite(raw[key]) && raw[key] >= 160 && raw[key] <= 480) prefs[key] = raw[key];
    }
    if (raw.selections && typeof raw.selections === "object" && !Array.isArray(raw.selections)) {
      for (const [machineId, candidate] of Object.entries(raw.selections)) {
        const target = targetOf(candidate);
        if (target && machineId && machineId !== "__proto__") prefs.selections[machineId] = target;
      }
    }
    if (raw.appOrders && typeof raw.appOrders === "object" && !Array.isArray(raw.appOrders)) {
      for (const [machineId, candidates] of Object.entries(raw.appOrders)) {
        if (!machineId || machineId === "__proto__" || !Array.isArray(candidates)) continue;
        const targets = candidates.map(targetOf).filter((target): target is AppTarget => target !== null);
        prefs.appOrders[machineId] = orderedAppTargets(targets);
      }
    }
  } catch { /* Corrupt or unavailable preferences do not prevent navigation. */ }
  return prefs;
}

export function createAppNavigation(storage: StorageLike | null) {
  let configured = false;
  let state: AppNavigationState = { ...defaults(), enabled: false, accountId: null, machineId: "machine", active: WORKSPACE, visited: [], mobileHomeOpen: true, transition: null };
  const listeners = new Set<() => void>();
  const set = (next: AppNavigationState) => {
    if (next === state) return;
    state = next;
    if (configured) {
      const { sidebarOpen, sidebarWidth, studioSidebarOpen, studioSidebarWidth, finderSidebarWidth, selections, appOrders } = state;
      try { storage?.setItem(preferenceKey(state.accountId), JSON.stringify({ version: 1, sidebarOpen, sidebarWidth, studioSidebarOpen, studioSidebarWidth, finderSidebarWidth, selections, appOrders })); } catch { /* Session remains usable. */ }
    }
    for (const listener of listeners) listener();
  };
  const visit = (next: AppNavigationState): AppNavigationState => {
    if (!next.enabled) return next;
    const location = { machineId: next.machineId, target: next.active };
    const key = appLocationKey(location);
    return next.visited.some(view => appLocationKey(view) === key) ? next : { ...next, visited: [...next.visited, location] };
  };
  const open = (target: AppTarget, machineId = state.machineId, source: AppNavigationSource = "programmatic") => {
    if (!state.enabled) return;
    if (!state.mobileHomeOpen && machineId === state.machineId && target.kind === state.active.kind && target.id === state.active.id) return;
    set(visit({ ...state, machineId, active: target, mobileHomeOpen: false, selections: { ...state.selections, [machineId]: target }, transition: { kind: "open", source } }));
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    configure(context: { enabled: boolean; machineId: string; accountId: string | null }) {
      const changedAccount = !configured || state.accountId !== context.accountId;
      if (!changedAccount && state.enabled === context.enabled && state.machineId === context.machineId) return;
      const prefs = changedAccount ? readPreferences(storage, context.accountId) : state;
      configured = true;
      set(visit({ ...state, ...prefs, ...context, active: prefs.selections[context.machineId] ?? WORKSPACE, visited: changedAccount ? [] : state.visited,
        mobileHomeOpen: changedAccount ? !prefs.selections[context.machineId] : state.mobileHomeOpen,
        transition: { kind: "configure", restored: Boolean(prefs.selections[context.machineId]) } }));
    },
    openBuiltin: (id: BuiltinAppId, machineId?: string, source?: AppNavigationSource) => open({ kind: "builtin", id }, machineId, source),
    openInstalled: (machineId: string, id: string, source?: AppNavigationSource) => open({ kind: "installed", id }, machineId, source),
    revealWorkspace: () => open(WORKSPACE, state.machineId, "workspace"),
    workspaceVisible: () => !state.enabled || (state.active.kind === "builtin" && state.active.id === "workspace"),
    setMobileHomeOpen(mobileHomeOpen: boolean) { if (state.mobileHomeOpen !== mobileHomeOpen) set({ ...state, mobileHomeOpen }); },
    setSidebarOpen(sidebarOpen: boolean) { if (state.sidebarOpen !== sidebarOpen) set({ ...state, sidebarOpen }); },
    setStudioSidebarOpen(studioSidebarOpen: boolean) { if (state.studioSidebarOpen !== studioSidebarOpen) set({ ...state, studioSidebarOpen }); },
    setSidebarWidth(width: number, viewportWidth: number) {
      if (!Number.isFinite(width) || !Number.isFinite(viewportWidth)) return;
      const sidebarWidth = Math.min(Math.max(200, width), 400, Math.max(0, viewportWidth - 320));
      if (sidebarWidth !== state.sidebarWidth) set({ ...state, sidebarWidth });
    },
    setContentSidebarWidth(app: "workspace" | "files", width: number) {
      if (!Number.isFinite(width)) return;
      const key = app === "workspace" ? "studioSidebarWidth" : "finderSidebarWidth";
      const next = Math.max(160, Math.min(480, width));
      if (state[key] !== next) set({ ...state, [key]: next });
    },
    reorderApps(machineId: string, activeKey: string, overKey: string, available: readonly AppTarget[]) {
      if (!configured || !state.enabled || state.machineId !== machineId || activeKey === overKey) return;
      const saved = state.appOrders[machineId] ?? [];
      // Only installed apps can move or receive a drop. In particular, stale
      // drag events and old saved Studio positions cannot cross the fixed apps.
      const movable = available.filter(target => target.kind === "installed");
      const visible = orderedAppTargets(movable, saved);
      const from = visible.findIndex(target => appTargetKey(target) === activeKey);
      const to = visible.findIndex(target => appTargetKey(target) === overKey);
      if (from < 0 || to < 0) return;
      const [moved] = visible.splice(from, 1);
      visible.splice(to, 0, moved!);
      // Only rewrite the displayed slots, keeping absent app ids where they
      // were. Reordering while a catalog is loading must not forget its apps.
      const visibleKeys = new Set(visible.map(appTargetKey));
      let index = 0;
      const order = orderedAppTargets([...saved, ...movable]).map(target => visibleKeys.has(appTargetKey(target)) ? visible[index++]! : target);
      set({ ...state, appOrders: { ...state.appOrders, [machineId]: order }, transition: { kind: "reorder", from, to, count: visible.length } });
    },
    reconcileInstalled(machineId: string, ids: ReadonlySet<string>, authoritative: boolean) {
      if (!authoritative) return;
      const missing = (target: AppTarget) => target.kind === "installed" && !ids.has(target.id);
      const selection = state.selections[machineId];
      const visited = state.visited.filter(view => view.machineId !== machineId || !missing(view.target));
      if ((!selection || !missing(selection)) && visited.length === state.visited.length) return;
      const selections = selection && missing(selection) ? { ...state.selections, [machineId]: WORKSPACE } : state.selections;
      set(visit({ ...state, selections, visited, active: selections[state.machineId] ?? WORKSPACE, transition: { kind: "reconcile" } }));
    },
    reset() { configured = false; set({ ...defaults(), enabled: false, accountId: null, machineId: "machine", active: WORKSPACE, visited: [], mobileHomeOpen: true, transition: null }); },
  };
}

// Read storage lazily: services and test DOMs can be installed after import.
const storage: StorageLike = {
  getItem: key => typeof localStorage === "undefined" ? null : localStorage.getItem(key),
  setItem: (key, value) => { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); },
};
const navigation = createAppNavigation(storage);
export const appNavigationStore = { subscribe: navigation.subscribe, getSnapshot: navigation.getSnapshot };
export const configureAppNavigation = navigation.configure;
export const openBuiltinApp = navigation.openBuiltin;
export const openInstalledApp = navigation.openInstalled;
export const revealWorkspace = navigation.revealWorkspace;
export const workspaceIsVisible = navigation.workspaceVisible;
export const setMobileAppHomeOpen = navigation.setMobileHomeOpen;
export const setAppSidebarOpen = navigation.setSidebarOpen;
export const setStudioSidebarOpen = navigation.setStudioSidebarOpen;
export const setAppSidebarWidth = navigation.setSidebarWidth;
export const setContentSidebarWidth = navigation.setContentSidebarWidth;
export const reorderApps = navigation.reorderApps;
export const reconcileInstalledApps = navigation.reconcileInstalled;
export const _resetAppNavigationForTests = navigation.reset;
export function useAppNavigation(): AppNavigationState { return useSyncExternalStore(navigation.subscribe, navigation.getSnapshot); }
