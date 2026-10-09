/**
 * Which sidebar rows this client has collapsed (spec §2.3, §2.4). Client-local,
 * persisted through prefs, and opened only by this client's own intent: a
 * chevron toggle, or a reveal fired by focusItem. Same plain module-store
 * shape as ui.ts.
 */



import { useSyncExternalStore } from "react";
import { services } from "../services";
import { itemAncestorKeys, miniAncestorKeys, type DisclosureKey } from "../sidebar/disclosure";
import { catalogStore, checkoutWasRemoved, machineWasRemoved } from "./catalog";
import { onSidebarReveal } from "./sidebar-reveal";

export const SIDEBAR_COLLAPSED_PREF = "sidebar-collapsed";

export interface DisclosureState {
  collapsed: ReadonlySet<DisclosureKey>;
  hydrated: boolean;
}

const KEY = /^(?:(?:machine|repo|checkout|directory):.+|unscoped)$/;
const isKey = (value: unknown): value is DisclosureKey => typeof value === "string" && KEY.test(value);

let state: DisclosureState = { collapsed: new Set(), hydrated: false };
/** Local decisions made before prefs resolved; true means collapsed. */
const decisions = new Map<DisclosureKey, boolean>();
/** Reveals for items the catalog has not delivered yet. */
const pendingReveals = new Set<string>();
const subscribers = new Set<() => void>();

function publish(collapsed: Set<DisclosureKey>, persist: boolean): void {
  state = { ...state, collapsed };
  if (persist && state.hydrated) void services.prefs.set(SIDEBAR_COLLAPSED_PREF, [...collapsed]);
  for (const callback of subscribers) callback();
}

/** Keys whose rows are authoritatively gone; null when nothing is. */
function withoutRemoved(collapsed: ReadonlySet<DisclosureKey>): Set<DisclosureKey> | null {
  const localRepos = services.desktop.capabilities.localRepos;
  let pruned = false;
  const next = new Set<DisclosureKey>();
  for (const key of collapsed) {
    const repoId = /^(?:repo|checkout):(.+)$/.exec(key)?.[1];
    const machineId = /^machine:(.+)$/.exec(key)?.[1];
    const gone = (repoId !== undefined && checkoutWasRemoved(repoId, undefined, localRepos))
      || (machineId !== undefined && machineWasRemoved(machineId));
    if (gone) pruned = true;
    else next.add(key);
  }
  return pruned ? next : null;
}

function apply(changes: ReadonlyMap<DisclosureKey, boolean>): void {
  if (!state.hydrated) for (const [key, value] of changes) decisions.set(key, value);
  let next: Set<DisclosureKey> | null = null;
  for (const [key, value] of changes) {
    if (state.collapsed.has(key) === value) continue;
    next ??= new Set(state.collapsed);
    if (value) next.add(key);
    else next.delete(key);
  }
  if (next) publish(next, true);
}

export function toggleCollapsed(key: DisclosureKey): void {
  apply(new Map([[key, !state.collapsed.has(key)]]));
}

export function expandKeys(keys: readonly DisclosureKey[]): void {
  apply(new Map(keys.map((key) => [key, false])));
}

function revealItem(itemId: string): boolean {
  const snapshot = catalogStore.getSnapshot();
  const item = snapshot.items.find((candidate) => candidate.id === itemId);
  if (!item) return false;
  expandKeys([...itemAncestorKeys(item, snapshot.repos), ...miniAncestorKeys(item, snapshot.repos)]);
  return true;
}

function hydrateFrom(stored: unknown): void {
  const merged = new Set<DisclosureKey>(Array.isArray(stored) ? stored.filter(isKey) : []);
  for (const [key, value] of decisions) {
    if (value) merged.add(key);
    else merged.delete(key);
  }
  const pruned = withoutRemoved(merged);
  const changed = decisions.size > 0 || pruned !== null;
  decisions.clear();
  state = { ...state, hydrated: true };
  publish(pruned ?? merged, changed);
}

function onCatalogChange(): void {
  for (const itemId of Array.from(pendingReveals)) {
    if (revealItem(itemId)) pendingReveals.delete(itemId);
  }
  const pruned = withoutRemoved(state.collapsed);
  if (pruned) publish(pruned, true);
}

/** Started once at launch, before anything can call focusItem (App.tsx). */
export function startSidebarDisclosure(): () => void {
  let active = true;
  const stopReveal = onSidebarReveal((itemId) => {
    if (!revealItem(itemId)) pendingReveals.add(itemId);
  });
  const stopCatalog = catalogStore.subscribe(onCatalogChange);
  services.prefs.get(SIDEBAR_COLLAPSED_PREF).then(
    (stored) => { if (active) hydrateFrom(stored); },
    () => { if (active) hydrateFrom(undefined); },
  );
  return () => {
    active = false;
    stopReveal();
    stopCatalog();
  };
}

export const disclosureStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): DisclosureState {
    return state;
  },
};

export function useDisclosure(): DisclosureState {
  return useSyncExternalStore(disclosureStore.subscribe, disclosureStore.getSnapshot);
}

export function _resetDisclosureForTest(): void {
  state = { collapsed: new Set(), hydrated: false };
  decisions.clear();
  pendingReveals.clear();
}
