/**
 * Which checkout of a repo a terminal is working in, for the mini sidebar's
 * worktree label. Pure and path-only: both sides are daemon-native (a repo
 * row's `root` and an item's `workingDir`), never the router's virtual paths.
 */
import type { OwnedItem, OwnedRepo } from "./catalog";

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Whether `path` is `root` or inside it, compared by whole segments. */
export function containsPath(root: string, path: string): boolean {
  const base = trimSlash(root);
  const target = trimSlash(path);
  return target === base || target.startsWith(`${base}/`);
}

function familyOf(repoId: string, machineId: string, repos: readonly OwnedRepo[]): OwnedRepo[] {
  const filed = repos.find((repo) => repo.id === repoId && repo.machineId === machineId);
  if (!filed) return [];
  const topId = filed.worktreeOf?.repoId ?? filed.id;
  return repos.filter((repo) => repo.machineId === machineId && (repo.id === topId || repo.worktreeOf?.repoId === topId));
}

/** A worktree's label: its branch, or its directory's name when HEAD is detached. */
export interface WorktreeLabel {
  name: string;
  detached: boolean;
}

function labelOf(checkout: OwnedRepo): WorktreeLabel {
  const branch = checkout.head?.branch;
  if (branch) return { name: branch, detached: false };
  const parts = trimSlash(checkout.root).split("/");
  return { name: parts[parts.length - 1] || checkout.name, detached: true };
}

type Placed = Pick<OwnedItem, "machineId" | "repoId" | "workingDir">;

/**
 * The checkout of its repo the item is working in: the deepest one whose
 * root holds its working directory (its filed checkout's root when it has
 * none yet). Null for an item outside any repo, or working outside every
 * checkout of its repo.
 */
function workingCheckout(item: Placed, repos: readonly OwnedRepo[]): OwnedRepo | null {
  if (item.repoId === undefined) return null;
  const family = familyOf(item.repoId, item.machineId, repos);
  if (family.length === 0) return null;
  const filed = family.find((repo) => repo.id === item.repoId)!;
  const path = item.workingDir ?? filed.root;
  let best: OwnedRepo | null = null;
  for (const checkout of family) {
    if (!containsPath(checkout.root, path)) continue;
    if (best === null || trimSlash(checkout.root).length > trimSlash(best.root).length) best = checkout;
  }
  return best;
}

/** The id of the checkout the item is working in; see workingCheckout. */
export function workingCheckoutId(item: Placed, repos: readonly OwnedRepo[]): string | null {
  return workingCheckout(item, repos)?.id ?? null;
}

/**
 * The label of the linked worktree the item is working in; null for the
 * primary checkout, an unknown place, or an item outside any repo.
 */
export function worktreeLabel(item: Placed, repos: readonly OwnedRepo[]): WorktreeLabel | null {
  const checkout = workingCheckout(item, repos);
  return checkout?.worktreeOf ? labelOf(checkout) : null;
}
