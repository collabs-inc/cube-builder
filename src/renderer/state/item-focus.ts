/**
 * A one-way signal from a surface that lists items to whichever view is
 * showing them: "the user picked this item and means to use it — put the
 * caret in it."
 *
 * Separate from activation, which is a store change (`focusItem`) and
 * nothing more: the pane takes the focus ring while the DOM caret stays
 * wherever it was, so a terminal picked from the sidebar looked focused
 * and swallowed every keystroke until it was clicked a second time.
 *
 * Fired by POINTER activation or an explicit create-and-type command,
 * never by activation in general. Arrowing through the sidebar list activates rows
 * as it goes, and pulling the caret into a pane on the first ArrowDown
 * would end the traversal on the spot — the sidebar's own arrow handler
 * bails as soon as focus has left it (`shouldHandleSidebarKey`). That is
 * the same line `focusEntry` vs `handleClick` already draws for the narrow
 * drawer: only a click means "I'm done here".
 *
 * Its own module for the reason canvas-reveal.ts is — the store must not
 * reach into a view's DOM, and a "the user asked for this" event has no
 * sensible resting state to keep in the store. The canvas answers the same
 * question through canvas-reveal instead, which it needs anyway to pan to
 * the tile (see tile-manager.js's focusCanvasTile).
 */

type ItemFocusListener = (itemId: string) => void;

const listeners = new Set<ItemFocusListener>();

export function onItemFocus(cb: ItemFocusListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function requestItemFocus(itemId: string): void {
  for (const cb of listeners) cb(itemId);
}
