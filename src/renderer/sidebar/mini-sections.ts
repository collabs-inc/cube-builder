/**
 * The mini sidebar's fold: one repo, its terminals flat beneath it. A
 * repo's worktrees are not rows, so their items join the repo's list, in
 * catalog document order — the order the repo-items reorder scope permutes.
 */



import type { CatalogItem } from "@port/shared/catalog";
import { isSiteItem } from "@port/shared/site";
import type { GroupableEntry, RepoInfo, RepoSection } from "./group-entries";

/**
 * Which catalog items draw a row in the mini sidebar: terminals,
 * conversations (never personas — they have their own surface) and artifact
 * files. Live sites draw only on a phone: on desktop the forwarded-ports
 * readout at the sidebar's foot is where a running server shows.
 */
export function listedInMini(item: CatalogItem, phone: boolean): boolean {
  if (item.type === "term") return true;
  if (item.type === "agent") return item.role !== "persona";
  if (item.type !== "artifact") return false;
  return phone || !isSiteItem(item);
}

export interface MiniRepoSection<T> {
  repo: RepoInfo;
  entries: T[];
}

export function miniRepoSections<T extends GroupableEntry>(
  sections: readonly RepoSection<T>[],
  documentIndex: ReadonlyMap<string, number>,
): MiniRepoSection<T>[] {
  const position = (id: string) => documentIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  return sections.map((section) => ({
    repo: section.repo,
    entries: section.checkouts
      .flatMap((checkout) => checkout.entries)
      .sort((a, b) => position(a.id) - position(b.id)),
  }));
}

/**
 * A repo drawn in the worktree view: main's nested checkouts, each item
 * under the checkout it works in (`checkoutOf`, the same answer as its
 * worktree label) rather than the one it was filed under — an agent that
 * made its own worktree is almost always filed under the primary. An item
 * whose checkout is unknown or not in this repo stays where it was filed.
 * Each checkout lists its items in catalog document order.
 */
export function worktreeViewSection<T extends GroupableEntry>(
  section: RepoSection<T>,
  checkoutOf: (id: string) => string | null,
  documentIndex: ReadonlyMap<string, number>,
): RepoSection<T> {
  const position = (id: string) => documentIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  const byId = new Map(section.checkouts.map((checkout) => [checkout.repo.id, [] as T[]]));
  for (const checkout of section.checkouts) {
    for (const entry of checkout.entries) {
      const working = checkoutOf(entry.id);
      byId.get(working !== null && byId.has(working) ? working : checkout.repo.id)!.push(entry);
    }
  }
  return {
    repo: section.repo,
    checkouts: section.checkouts.map((checkout) => ({
      ...checkout,
      entries: byId.get(checkout.repo.id)!.sort((a, b) => position(a.id) - position(b.id)),
    })),
  };
}
