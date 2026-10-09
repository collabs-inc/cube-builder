/**
 * Whether the file tree's click-highlight is still telling the truth.
 *
 * `selectedPath` is set the moment a row is clicked, but the pane it opens
 * arrives asynchronously (open-file.ts's addItem round trip) and can later
 * leave the rail — hidden from a pane's ✕, or closed outright, which also
 * deletes the catalog item. A highlight that survives its pane reads as
 * "this file is open" when it isn't (#98 review).
 *
 * The `wasDisplayed` latch is what makes clearing safe: during the open
 * round trip there is no item yet, and clearing then would kill the
 * highlight the instant it was set. So the selection must first be SEEN
 * displayed once; only after that does "not displayed" mean the pane went
 * away rather than "not there yet".
 */



import type { OwnedItem } from "@port/shared/catalog";

export function selectionDisplayed(
  selectedPath: string,
  items: readonly OwnedItem[],
  panedItemIds: ReadonlySet<string>,
): boolean {
  const item = items.find((i) => i.filePath === selectedPath);
  return item !== undefined && panedItemIds.has(item.id);
}

export function shouldClearSelection(
  selectedPath: string | null,
  items: readonly OwnedItem[],
  panedItemIds: ReadonlySet<string>,
  wasDisplayed: boolean,
): boolean {
  if (selectedPath === null) return false;
  return wasDisplayed && !selectionDisplayed(selectedPath, items, panedItemIds);
}
