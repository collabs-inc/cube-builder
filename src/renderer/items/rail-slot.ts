/**
 * Pure per-slot helpers Rail.tsx needs — kept out of Rail.tsx so they are
 * testable with no DOM at all.
 */



import type { OwnedItem } from "@port/shared/catalog";
import type { ColumnLike } from "../state/layout-ops";
import { buildItemListEntry } from "../sidebar/build-item-entry";

/** Independent viewers have no editor draft, session, or runtime controller to share. */
export function canDuplicatePane(item: OwnedItem | undefined, isTree = false): boolean {
  if (!item) return isTree;
  return item.type === "image" || item.type === "pdf" || item.type === "artifact";
}

/**
 * Rail order: column by column, pane by pane — the order the paned slots
 * are drawn in. `ColumnLike` (not `Column`) because this also walks a
 * screen's `ScreenColumn[]` (screen-ops.ts) when a screen is active — it
 * only ever reads panes, never width.
 */
export function panedItemIds(columns: readonly ColumnLike[]): string[] {
  const ids: string[] = [];
  for (const column of columns) for (const pane of column.panes) ids.push(pane.itemId);
  return ids;
}

/**
 * Half the gap between two panes, in px — must match `--rail-gutter`
 * (App.css's `:root`). A tiled pane gets its own half from a transparent
 * border and never needs this number; a ZOOMED pane does, because the
 * other half lives on `.rail-content`'s transparent border and a zoomed
 * pane is edge-to-edge. That border shrinks the containing block the
 * panes resolve against, so both zoom styles below shift out by this and
 * grow by twice it to land back on the rail's own edges.
 */
export const RAIL_GUTTER_PX = 4;

/**
 * The width a screen's ratio columns are projected into: the rail's
 * client width minus both gutters (see RAIL_GUTTER_PX), never negative.
 */
export function fittedRailWidth(clientWidthPx: number): number {
  return Math.max(0, clientWidthPx - 2 * RAIL_GUTTER_PX);
}

/**
 * The title a pane header shows. Built against a fixed, empty live status:
 * `hidden` is always false for something that has a pane, and the live
 * foreground command / touched file / closing indicator are sidebar-row
 * concerns (ReposSidebar.tsx), not pane chrome.
 */
const PANE_HEADER_LIVE_STATUS = {
  liveCommand: null,
  touchedFile: null,
  hidden: false,
  closing: false,
};

export function paneTitle(item: OwnedItem): string {
  return buildItemListEntry(item, PANE_HEADER_LIVE_STATUS).title;
}

/**
 * Whether a slot's item component should be told it is visible. Extracted
 * from Rail's JSX so the narrow projection — "zoom held on, so only the
 * active item is visible" — has a test that does not depend on rendering a
 * terminal.
 */
export function slotVisible(displayed: boolean, zoomed: boolean, active: boolean): boolean {
  return displayed && (!zoomed || active);
}
