/**
 * Order for sidebar rows (spec §1.2, §1.3, §2.6, §2.8). Pure: the component
 * supplies what it renders and what the machine holds; nothing here reads a
 * store or the DOM.
 */



import { closestCenter, type ClientRect, type CollisionDetection } from "@dnd-kit/core";
import type { CatalogDocument, MergedCatalog } from "@port/shared/catalog";
import { expandDisplayedOrder, itemScopeOf, scopeMemberIds, type ReorderScope } from "@port/shared/catalog-order";

export interface RowScope {
  machineId: string;
  scope: ReorderScope;
}

export type ReorderPlan = { machineId: string; scope: ReorderScope; ids: string[] };

export function scopeId({ machineId, scope }: RowScope): string {
  if (scope.kind === "repos") return `${machineId}|repos`;
  if (scope.kind === "worktrees") return `${machineId}|worktrees|${scope.parentId}`;
  if (scope.kind === "repo-items") return `${machineId}|repo-items|${scope.repoId}`;
  return `${machineId}|items|${scope.repoId ?? ""}`;
}

export function itemRowScope(merged: MergedCatalog, itemId: string): RowScope | null {
  const item = merged.items.find((candidate) => candidate.id === itemId);
  if (!item) return null;
  const repos = merged.repos.filter((repo) => repo.machineId === item.machineId);
  return { machineId: item.machineId, scope: itemScopeOf({ repos }, item) };
}

export function repoRowScope(merged: MergedCatalog, repoId: string): RowScope | null {
  const repo = merged.repos.find((candidate) => candidate.id === repoId);
  if (!repo) return null;
  const scope: ReorderScope = repo.worktreeOf ? { kind: "worktrees", parentId: repo.worktreeOf.repoId } : { kind: "repos" };
  return { machineId: repo.machineId, scope };
}

/** Membership from the held document, never the filtered snapshot. */
export function scopeMembers(doc: Pick<CatalogDocument, "repos" | "items"> | undefined, row: RowScope): string[] | null {
  return doc === undefined ? null : scopeMemberIds(doc, row.scope);
}

/** One checkout's sibling set within a repo-wide scope, as the mini worktree view draws it. */
export function worktreeViewGroup(row: RowScope, checkoutId: string): string {
  return `${scopeId(row)}@${checkoutId}`;
}

export function buildSiblingIndex(rows: readonly { id: string; scopeId: string }[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    const ids = index.get(row.scopeId);
    if (ids) ids.push(row.id);
    else index.set(row.scopeId, [row.id]);
  }
  return index;
}

export interface FrozenDrag {
  row: RowScope;
  displayedIds: readonly string[];
  members: readonly string[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false;
  const pool = new Set(a);
  return b.every((id) => pool.has(id));
};

function moved(displayedIds: readonly string[], from: number, to: number): string[] {
  const next = [...displayedIds];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id!);
  return next;
}

export function planDrop(
  frozen: FrozenDrag,
  activeId: string,
  overId: string,
  current: { displayedIds: readonly string[]; members: readonly string[] | null },
): ReorderPlan | null {
  if (activeId === overId || current.members === null) return null;
  if (!sameSet(current.displayedIds, frozen.displayedIds) || !sameSet(current.members, frozen.members)) return null;
  const from = current.displayedIds.indexOf(activeId);
  const to = current.displayedIds.indexOf(overId);
  if (from < 0 || to < 0) return null;
  const ids = expandDisplayedOrder(current.members, moved(current.displayedIds, from, to));
  return { machineId: frozen.row.machineId, scope: frozen.row.scope, ids };
}

export function planMove(
  row: RowScope,
  id: string,
  direction: "up" | "down",
  displayedIds: readonly string[],
  members: readonly string[],
): ReorderPlan | null {
  const from = displayedIds.indexOf(id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= displayedIds.length) return null;
  return { machineId: row.machineId, scope: row.scope, ids: expandDisplayedOrder(members, moved(displayedIds, from, to)) };
}

export interface DragControllerDeps {
  rowScope(id: string): RowScope | null;
  /** The sibling rows drawn with `id`, in order — a subset of its scope when the view groups it. */
  displayedIds(id: string): readonly string[];
  members(row: RowScope): readonly string[] | null;
  reorder(machineId: string, scope: ReorderScope, ids: string[]): Promise<{ ok: true } | { ok: false; reason: string }>;
  warn(reason: string): void;
}

/** The sidebar's drag lifecycle (spec §2.8): freeze at start, plan fresh at end. */
export function createDragController(deps: DragControllerDeps) {
  let frozen: FrozenDrag | null = null;
  return {
    start(activeId: string): void {
      const row = deps.rowScope(activeId);
      const members = row === null ? null : deps.members(row);
      frozen = row === null || members === null ? null : { row, displayedIds: [...deps.displayedIds(activeId)], members: [...members] };
    },
    async end(activeId: string, overId: string | null): Promise<"sent" | "refused" | "cancelled"> {
      const held = frozen;
      frozen = null;
      if (held === null || overId === null) return "cancelled";
      const plan = planDrop(held, activeId, overId, { displayedIds: deps.displayedIds(activeId), members: deps.members(held.row) });
      if (plan === null) return "cancelled";
      const result = await deps.reorder(plan.machineId, plan.scope, plan.ids);
      if (!result.ok) {
        deps.warn(result.reason);
        return "refused";
      }
      return "sent";
    },
    cancel(): void {
      frozen = null;
    },
  };
}

const contains = (rect: ClientRect, x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
const scopeOf = (data: unknown) => (data as { scopeId?: string } | undefined)?.scopeId;

/**
 * Scope-aware collision (spec §2.6). The decision is about the set of
 * droppables under the pointer, because sortable nodes nest: a pointer on a
 * sibling item is also inside ancestor wrappers of other scopes.
 */
export const scopedCollisionDetection: CollisionDetection = (args) => {
  const activeData = args.active.data.current as { scopeId?: string; getContainerRect?: () => ClientRect | null } | undefined;
  const activeScope = activeData?.scopeId;
  const pointer = args.pointerCoordinates;
  if (activeScope === undefined || pointer === null) return [];
  const inScope = args.droppableContainers.filter((container) => scopeOf(container.data.current) === activeScope);
  const under = args.droppableContainers.filter((container) => {
    const rect = args.droppableRects.get(container.id);
    return rect !== undefined && contains(rect, pointer.x, pointer.y);
  });
  const rank = () => closestCenter({ ...args, droppableContainers: inScope });
  if (under.some((container) => scopeOf(container.data.current) === activeScope)) return rank();
  if (under.length > 0) return [];
  const bounds = activeData?.getContainerRect?.() ?? null;
  return bounds !== null && contains(bounds, pointer.x, pointer.y) ? rank() : [];
};
