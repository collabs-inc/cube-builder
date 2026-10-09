/**
 * Collapsible sidebar rows (spec §2.2). Keys are typed because a repo and
 * its primary checkout share an id. Pure: no store, no DOM.
 */



import type { OwnedItem, OwnedRepo } from "@port/shared/catalog";

export type DisclosureKey = `machine:${string}` | `repo:${string}` | `checkout:${string}` | `directory:${string}` | "unscoped";

export const machineKey = (machineId: string): DisclosureKey => `machine:${machineId}`;
export const repoKey = (repoId: string): DisclosureKey => `repo:${repoId}`;
export const checkoutKey = (repoId: string): DisclosureKey => `checkout:${repoId}`;
/** The directory identity is a machine/path tuple; encode it for a safe, distinct DOM region id. */
export const directoryKey = (identity: string): DisclosureKey => `directory:${encodeURIComponent(identity)}`;
export const UNSCOPED_KEY: DisclosureKey = "unscoped";

type RepoShape = Pick<OwnedRepo, "id" | "worktreeOf">;

/**
 * The keys whose collapse would hide this item's row, outermost first. An
 * item renders in a checkout only when repoDisplayOrder would emit that
 * checkout. A repo has its own row, and so its own key, only while it has a
 * worktree to list; alone, it is one combined row governed by its checkout.
 */
export function itemAncestorKeys(item: Pick<OwnedItem, "machineId" | "repoId" | "role">, repos: readonly RepoShape[]): DisclosureKey[] {
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  const checkout = item.repoId === undefined ? undefined : byId.get(item.repoId);
  if (!checkout) return [UNSCOPED_KEY];
  const parentId = checkout.worktreeOf?.repoId;
  if (parentId !== undefined && !byId.has(parentId)) return [UNSCOPED_KEY];
  const topId = parentId ?? checkout.id;
  const hasRepoRow = repos.some((repo) => repo.worktreeOf?.repoId === topId);
  return [machineKey(item.machineId), ...(hasRepoRow ? [repoKey(topId)] : []), checkoutKey(checkout.id)];
}

/** The mini layout's keys: a repo row governs its primary and worktree items alike. */
export function miniAncestorKeys(item: Pick<OwnedItem, "machineId" | "repoId">, repos: readonly RepoShape[]): DisclosureKey[] {
  const byId = new Map(repos.map((repo) => [repo.id, repo]));
  const filed = item.repoId === undefined ? undefined : byId.get(item.repoId);
  if (!filed) return [UNSCOPED_KEY];
  const topId = filed.worktreeOf?.repoId ?? filed.id;
  if (!byId.has(topId)) return [UNSCOPED_KEY];
  return [machineKey(item.machineId), repoKey(topId)];
}

export function isHiddenBy(keys: readonly DisclosureKey[], collapsed: ReadonlySet<DisclosureKey>): boolean {
  return keys.some((key) => collapsed.has(key));
}

export function hiddenSummary<T extends { id: string; status: string | null }>(
  key: DisclosureKey,
  entries: readonly T[],
  ancestorsOf: (entry: T) => readonly DisclosureKey[],
): { count: number; waiting: boolean } {
  let count = 0;
  let waiting = false;
  for (const entry of entries) {
    if (!ancestorsOf(entry).includes(key)) continue;
    count++;
    if (entry.status === "waiting") waiting = true;
  }
  return { count, waiting };
}
