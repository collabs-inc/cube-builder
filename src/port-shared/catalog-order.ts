/**
 * Hand-arranged order in a machine catalog is array order (spec §1). A scope
 * is catalog membership, never what a client draws; these helpers are shared
 * by cubed, which validates and applies a permutation, and by the renderer,
 * which builds one from the rows it displays.
 */
import type { CatalogDocument, CatalogItem } from "./catalog";

export type ReorderScope =
  | { kind: "items"; repoId: string | null }
  | { kind: "repo-items"; repoId: string }
  | { kind: "worktrees"; parentId: string }
  | { kind: "repos" };

export type ReorderRefusal = "scope-unknown" | "membership-changed";

type Rows = Pick<CatalogDocument, "repos" | "items">;

/** The scope an item belongs to in `doc`: its repo if present, else unscoped. */
export function itemScopeOf(doc: Pick<CatalogDocument, "repos">, item: Pick<CatalogItem, "repoId">): ReorderScope {
  const present = item.repoId !== undefined && doc.repos.some((repo) => repo.id === item.repoId);
  return { kind: "items", repoId: present ? item.repoId! : null };
}

/** Member ids of `scope` in document order, or null when the scope names a missing row. */
export function scopeMemberIds(doc: Rows, scope: ReorderScope): string[] | null {
  if (scope.kind === "repos") return doc.repos.filter((repo) => !repo.worktreeOf).map((repo) => repo.id);
  if (scope.kind === "worktrees") {
    if (!doc.repos.some((repo) => repo.id === scope.parentId)) return null;
    return doc.repos.filter((repo) => repo.worktreeOf?.repoId === scope.parentId).map((repo) => repo.id);
  }
  if (scope.kind === "repo-items") {
    const top = doc.repos.find((repo) => repo.id === scope.repoId);
    if (!top || top.worktreeOf) return null;
    const family = new Set([top.id]);
    for (const repo of doc.repos) if (repo.worktreeOf?.repoId === top.id) family.add(repo.id);
    return doc.items.filter((item) => item.repoId !== undefined && family.has(item.repoId)).map((item) => item.id);
  }
  if (scope.repoId !== null) {
    if (!doc.repos.some((repo) => repo.id === scope.repoId)) return null;
    return doc.items.filter((item) => item.repoId === scope.repoId).map((item) => item.id);
  }
  const known = new Set(doc.repos.map((repo) => repo.id));
  return doc.items.filter((item) => item.repoId === undefined || !known.has(item.repoId)).map((item) => item.id);
}

export function isPermutationOf(ids: readonly string[], members: readonly string[]): boolean {
  if (ids.length !== members.length) return false;
  const pool = new Set(members);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!pool.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Writes the rows named by `orderedIds` back into the indices those rows
 * already occupy, in the new order; every other row keeps its index. Same
 * reference back when nothing moves, so a caller can skip a write.
 */
export function applyScopeOrder<T extends { id: string }>(rows: readonly T[], orderedIds: readonly string[]): T[] {
  const members = new Set(orderedIds);
  const byId = new Map(rows.filter((row) => members.has(row.id)).map((row) => [row.id, row]));
  let next = 0;
  let changed = false;
  const result = rows.map((row) => {
    if (!members.has(row.id)) return row;
    const replacement = byId.get(orderedIds[next++]!)!;
    if (replacement !== row) changed = true;
    return replacement;
  });
  return changed ? result : (rows as T[]);
}

/**
 * The full-membership order for a scope whose displayed subset was reordered
 * (spec §1.2): displayed ids fill the slots displayed ids already held, in
 * their new order; undisplayed members stay where they are.
 */
export function expandDisplayedOrder(members: readonly string[], displayedOrder: readonly string[]): string[] {
  const displayed = new Set(displayedOrder);
  let next = 0;
  return members.map((id) => (displayed.has(id) ? displayedOrder[next++]! : id));
}

/** Wire validation for `catalog:reorder`'s scope. */
export function isReorderScope(value: unknown): value is ReorderScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  if (scope.kind === "repos") return true;
  if (scope.kind === "worktrees") return typeof scope.parentId === "string";
  if (scope.kind === "repo-items") return typeof scope.repoId === "string";
  if (scope.kind === "items") return scope.repoId === null || typeof scope.repoId === "string";
  return false;
}

/** Which rows a scope permutes: item scopes reorder items, the others repos. */
export function scopeRows(scope: ReorderScope): "items" | "repos" {
  return scope.kind === "items" || scope.kind === "repo-items" ? "items" : "repos";
}
