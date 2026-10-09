/**
 * A one-way signal from focusItem to the sidebar's disclosure state: "this
 * client asked to see this item, so open whatever rows hide it" (spec §2.4).
 *
 * Separate from the active item on purpose. The active item also moves when
 * reconciliation replaces a removed tile, when hydration restores a layout,
 * and when pane-direction focus steps; none of those is this client's intent,
 * and none of them may open a row the user closed. Only focusItem fires this.
 * Same shape as item-focus.ts: the store must not reach into a view, and a
 * reveal has no resting state worth keeping.
 */
type RevealListener = (itemId: string) => void;

const listeners = new Set<RevealListener>();

export function onSidebarReveal(cb: RevealListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function requestSidebarReveal(itemId: string): void {
  for (const cb of listeners) cb(itemId);
}
