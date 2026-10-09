/**
 * Pure math for a screen: a viewport-fitted set of columns whose widths
 * are RATIOS of the rail width (summing to 1) rather than the pixel
 * widths the Columns rail uses. Pane stacking inside a screen column is
 * the same `PaneSlot` / height-ratio math as layout-ops.ts, and every
 * pane-level routine there (`columnOf`, `nextActiveAfterRemoval`,
 * `focusTarget`, `keyboardMoveTarget`, `adjustMoveTarget`) accepts a
 * `ScreenColumn[]` through `ColumnLike`. Rendering reuses the rail's
 * pixel geometry by projecting a screen through `screenToPixelColumns`.
 * No DOM, no React, no store access; functions return the same reference
 * on a no-op so callers can skip notify()/save. Spec:
 * docs/superpowers/specs/2026-09-05-screens-view-design.md
 */



import { adjustMoveTarget, columnOf, insertIntoStack, normalizeRatios, type Column, type MoveTarget, type PaneSlot } from "./layout-ops";

export interface ScreenColumn {
  id: string;
  widthRatio: number;
  panes: PaneSlot[];
}

export interface Screen {
  id: string;
  name: string;
  /** Distinguishes explicit names such as "Screen 2" from legacy generated labels. */
  customName?: boolean;
  columns: ScreenColumn[];
  checkoutId?: string;
  /** Catalog owner, retained so absence after reload can be distinguished from discovery. */
  checkoutMachineId?: string;
  /** Last discovered checkout membership; explicit hide/layout edits are separate. */
  checkoutItemIds?: string[];
  /** Runtime only: a worktree preview is discarded when another screen opens. */
  preview?: boolean;
  /** Latest discovered membership, separate from explicit layout edits. Runtime only. */
  previewItemIds?: string[];
}

export function screenDisplayName(screen: Screen): string {
  return screen.customName || !/^Screen(?: \d+)?$/.test(screen.name) ? screen.name : "";
}

/**
 * Where a sidebar click should travel for an item the active screen does not
 * show: the nearest other screen that places it, the left one on a tie.
 * Null when the active screen already shows it or no other screen does,
 * which are exactly the cases where the click opens it here instead.
 */
export function nearestScreenPlacing(screens: readonly Screen[], activeScreenId: string, itemId: string): string | null {
  const activeIndex = screens.findIndex((screen) => screen.id === activeScreenId);
  if (activeIndex < 0 || columnOf(screens[activeIndex]!.columns, itemId) !== null) return null;
  let nearest: string | null = null;
  let nearestDistance = Infinity;
  for (let index = 0; index < screens.length; index++) {
    if (index === activeIndex || columnOf(screens[index]!.columns, itemId) === null) continue;
    const distance = Math.abs(index - activeIndex);
    // Strictly nearer only, so a tie keeps the leftmost screen found first.
    if (distance < nearestDistance) {
      nearest = screens[index]!.id;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** The floor a divider drag can push a column to — the horizontal twin of MIN_PANE_RATIO. */
/** A screen moved to `toIndex`; the same array back when nothing would move. */
export function moveScreen(screens: readonly Screen[], id: string, toIndex: number): Screen[] {
  const from = screens.findIndex((screen) => screen.id === id);
  if (from < 0 || toIndex < 0 || toIndex >= screens.length || from === toIndex) return screens as Screen[];
  const next = [...screens];
  const [moved] = next.splice(from, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

export const MIN_COLUMN_RATIO = 0.1;

export interface ScreenViewportSize { width: number; height: number }

/** Prefer full-height columns unless stacking gives a clearly more usable shape. */
export function automaticScreenTarget(screen: Screen, viewport: ScreenViewportSize | null): MoveTarget {
  const column: MoveTarget = { kind: "column", railIndex: screen.columns.length };
  const last = screen.columns.at(-1);
  if (!last || !viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
    || viewport.width <= 0 || viewport.height <= 0) return column;
  const count = last.panes.length + 1;
  const newHeight = viewport.height / count;
  const smallestHeight = Math.min(newHeight, ...last.panes.map(p => viewport.height * p.heightRatio * (count - 1) / count));
  if (smallestHeight < 220) return column;
  // A mildly landscape pane works for both conversations and artifacts.
  // Penalize narrow panes further because their controls need room too.
  const cost = (width: number, height: number): number =>
    Math.abs(Math.log(width / height / 1.2)) + Math.max(0, Math.log(360 / width));
  const columnCost = cost(viewport.width / (screen.columns.length + 1), viewport.height);
  // Preserving vertical context is worth a factor of two in shape distortion.
  // The width penalty still favors stacking when another column gets too narrow.
  const stackCost = cost(viewport.width * last.widthRatio, newHeight) + Math.log(2);
  return stackCost < columnCost
    ? { kind: "seam", columnId: last.id, seamIndex: last.panes.length }
    : column;
}

const isUsableRatio = (r: number): boolean => Number.isFinite(r) && r > 0;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Width ratios rescaled to sum to 1; any unusable ratio resets the set to equal shares. */
export function normalizeWidthRatios(columns: ScreenColumn[]): ScreenColumn[] {
  if (columns.length === 0) return [];
  const total = columns.reduce((acc, c) => acc + c.widthRatio, 0);
  if (!isUsableRatio(total) || columns.some((c) => !isUsableRatio(c.widthRatio))) {
    return columns.map((c) => ({ ...c, widthRatio: 1 / columns.length }));
  }
  return columns.map((c) => ({ ...c, widthRatio: c.widthRatio / total }));
}

/**
 * Places `itemId` on the screen: a `column` target inserts a new column
 * taking `1/n` (existing columns scale by `(n-1)/n`); a `seam` target
 * stacks it into that column via `insertIntoStack`, widths untouched.
 */
export function insertScreenPane(
  screen: Screen,
  itemId: string,
  target: MoveTarget,
  newColumnId: string,
): Screen {
  if (target.kind === "column") {
    const n = screen.columns.length + 1;
    const scaled = screen.columns.map((c) => ({ ...c, widthRatio: c.widthRatio * ((n - 1) / n) }));
    const at = clamp(target.railIndex, 0, screen.columns.length);
    const column: ScreenColumn = {
      id: newColumnId,
      widthRatio: 1 / n,
      panes: [{ itemId, heightRatio: 1 }],
    };
    const columns = [...scaled.slice(0, at), column, ...scaled.slice(at)];
    return { ...screen, columns: normalizeWidthRatios(columns) };
  }
  if (!screen.columns.some((c) => c.id === target.columnId)) return screen;
  const columns = screen.columns.map((c) =>
    c.id === target.columnId
      ? { ...c, panes: insertIntoStack(c.panes, itemId, target.seamIndex) }
      : c,
  );
  return { ...screen, columns };
}

/** Removes a pane; an emptied column goes with it and the remaining widths renormalize. */
export function removeScreenPane(screen: Screen, itemId: string): Screen {
  if (columnOf(screen.columns, itemId) === null) return screen;
  const kept: ScreenColumn[] = [];
  for (const column of screen.columns) {
    const panes = column.panes.filter((p) => p.itemId !== itemId);
    if (panes.length === 0) continue;
    kept.push(
      panes.length === column.panes.length ? column : { ...column, panes: normalizeRatios(panes) },
    );
  }
  return { ...screen, columns: normalizeWidthRatios(kept) };
}

/**
 * Moves a pane within the screen (drag + keyboard) — the screen twin of
 * layout-ops's movePane.
 */
export function moveScreenPane(
  screen: Screen,
  itemId: string,
  target: MoveTarget,
  newColumnId: string,
): Screen {
  const effective = adjustMoveTarget(screen.columns, itemId, target);
  if (!effective) return screen;
  return insertScreenPane(removeScreenPane(screen, itemId), itemId, effective, newColumnId);
}

/**
 * Drags the divider on the right edge of `leftColumnId`: width moves
 * between it and its right neighbour, sum constant, both clamped to
 * MIN_COLUMN_RATIO. The last column has no divider.
 */
export function resizeScreenDivider(
  screen: Screen,
  leftColumnId: string,
  deltaRatio: number,
  minRatio = MIN_COLUMN_RATIO,
): Screen {
  const idx = screen.columns.findIndex((c) => c.id === leftColumnId);
  const left = screen.columns[idx];
  const right = screen.columns[idx + 1];
  if (!left || !right) return screen;
  const maxGrow = Math.max(0, right.widthRatio - minRatio);
  const maxShrink = Math.max(0, left.widthRatio - minRatio);
  const delta = clamp(deltaRatio, -maxShrink, maxGrow);
  if (delta === 0) return screen;
  const columns = screen.columns.map((c, i) => {
    if (i === idx) return { ...c, widthRatio: left.widthRatio + delta };
    if (i === idx + 1) return { ...c, widthRatio: right.widthRatio - delta };
    return c;
  });
  return { ...screen, columns };
}

/**
 * The screen as pixel columns for a given rail width, so Rail's geometry,
 * handle and drop-target code runs unchanged. Widths are rounded and the
 * last column takes the remainder, so the columns tile the viewport to
 * the pixel. Pane arrays are passed through by reference.
 */
export function screenToPixelColumns(screen: Screen, viewportWidthPx: number): Column[] {
  const out: Column[] = [];
  let used = 0;
  screen.columns.forEach((c, i) => {
    const last = i === screen.columns.length - 1;
    const widthPx = last ? viewportWidthPx - used : Math.round(c.widthRatio * viewportWidthPx);
    used += widthPx;
    out.push({ id: c.id, widthPx, panes: c.panes });
  });
  return out;
}

function repairPanes(raw: unknown, seen: Set<string>): PaneSlot[] {
  const out: PaneSlot[] = [];
  for (const rawPane of Array.isArray(raw) ? raw : []) {
    if (typeof rawPane !== "object" || rawPane === null) continue;
    const { itemId, heightRatio } = rawPane as Partial<PaneSlot>;
    if (typeof itemId !== "string" || seen.has(itemId)) continue;
    seen.add(itemId);
    const ratio =
      typeof heightRatio === "number" && isUsableRatio(heightRatio)
        ? heightRatio
        : 0;
    out.push({ itemId, heightRatio: ratio });
  }
  return normalizeRatios(out);
}

function repairScreenColumns(raw: unknown, nextColumnId: () => string): ScreenColumn[] {
  const seen = new Set<string>();
  const out: ScreenColumn[] = [];
  for (const rawColumn of Array.isArray(raw) ? raw : []) {
    if (typeof rawColumn !== "object" || rawColumn === null) continue;
    const { id, widthRatio, panes } = rawColumn as Partial<ScreenColumn>;
    const repairedPanes = repairPanes(panes, seen);
    if (repairedPanes.length === 0) continue;
    out.push({
      id: typeof id === "string" && id !== "" ? id : nextColumnId(),
      widthRatio:
        typeof widthRatio === "number" && isUsableRatio(widthRatio)
          ? widthRatio
          : 0,
      panes: repairedPanes,
    });
  }
  return normalizeWidthRatios(out);
}

/**
 * Shape repair for persisted screens — the screen twin of layout-ops's
 * `repairLayout`. Drops anything that is not an object with a string id,
 * defaults a missing name, mints column ids, resets unusable ratios, and
 * removes a pane that repeats WITHIN one screen (the same item on several
 * screens is legal). Nothing is pruned for referencing an unknown item —
 * that is `reconcileScreens`'s job once the catalog is known.
 */
export function repairScreens(raw: unknown, nextColumnId: () => string): Screen[] {
  const out: Screen[] = [];
  const ids = new Set<string>();
  for (const rawScreen of Array.isArray(raw) ? raw : []) {
    if (typeof rawScreen !== "object" || rawScreen === null) continue;
    const { id, name, customName, columns, checkoutId, checkoutMachineId, checkoutItemIds, preview } = rawScreen as Partial<Screen>;
    if (preview === true) continue;
    if (typeof id !== "string" || id === "" || ids.has(id)) continue;
    ids.add(id);
    out.push({
      id,
      name: typeof name === "string" ? name : "",
      ...(customName === true ? { customName: true } : {}),
      columns: repairScreenColumns(columns, nextColumnId),
      ...(typeof checkoutId === "string" ? { checkoutId } : {}),
      ...(typeof checkoutMachineId === "string" ? { checkoutMachineId } : {}),
      ...(Array.isArray(checkoutItemIds) ? { checkoutItemIds: checkoutItemIds.filter((id): id is string => typeof id === "string") } : {}),
    });
  }
  return out;
}

/**
 * Removes `itemId` from every screen; screens it is not on keep their
 * reference.
 */
export function removeFromAllScreens(screens: Screen[], itemId: string): Screen[] {
  let changed = false;
  const out = screens.map((s) => {
    const next = removeScreenPane(s, itemId);
    if (next !== s) changed = true;
    return next;
  });
  return changed ? out : screens;
}

/**
 * Prunes panes whose item the catalog no longer knows, across every
 * screen. An emptied screen stays (it is the user's named arrangement);
 * only its columns go. Same reference back when nothing was unknown.
 */
export function reconcileScreens(
  screens: Screen[],
  knownItemIds: Set<string>,
): Screen[] {
  let out = screens;
  for (const s of screens) {
    for (const c of s.columns) {
      for (const p of c.panes) {
        if (!knownItemIds.has(p.itemId))
          out = removeFromAllScreens(out, p.itemId);
      }
    }
  }
  return out;
}
