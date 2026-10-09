// Which repos the mini sidebar draws in the worktree view: main's nested
// checkouts (repo → worktree rows → terminals) instead of the flat list,
// so a worktree has a row to right-click and remove. Per repo, per
// computer: a viewing preference, kept in this client's localStorage and
// never on the machine.
import { useSyncExternalStore } from "react";

const KEY = "cube_sidebar_worktree_view";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // the accessor itself throws where site data is blocked
  }
}

/** The saved repo ids, or none when unset, unreadable or malformed. */
export function loadWorktreeView(store: Pick<Storage, "getItem"> | null = storage()): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function save(ids: ReadonlySet<string>): void {
  try {
    storage()?.setItem(KEY, JSON.stringify([...ids]));
  } catch (error) {
    console.warn("[sidebar] could not save the worktree view", error);
  }
}

let state: ReadonlySet<string> = loadWorktreeView();
const listeners = new Set<() => void>();

export const worktreeViewStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
};

/** Turns the worktree view on or off for one repo. */
export function toggleWorktreeView(repoId: string): void {
  const next = new Set(state);
  if (!next.delete(repoId)) next.add(repoId);
  state = next;
  save(next);
  for (const listener of listeners) listener();
}

export function useWorktreeView(): ReadonlySet<string> {
  return useSyncExternalStore(worktreeViewStore.subscribe, worktreeViewStore.getSnapshot);
}

/** Test-only: every repo back on the flat list. */
export function _resetWorktreeViewForTest(): void {
  state = new Set();
  for (const listener of listeners) listener();
}
