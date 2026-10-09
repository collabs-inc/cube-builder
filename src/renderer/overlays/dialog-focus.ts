/**
 * Focus mechanics for the Dialog primitive, kept out of the component so
 * they can be unit-tested without a React tree.
 *
 * Every dialog in this app used to decide these for itself, which is how
 * AddLocalRepoModal shipped with an Escape handler bound to a
 * non-focusable <div> that nothing ever focused — the key never reached it
 * (#58). Focus entry, cycling and restore are now one implementation.
 */

/**
 * Elements that can hold focus. `:not([disabled])` matters for dialogs in
 * particular: a primary action is routinely disabled until the form is
 * valid, and Tab must skip it rather than park on a dead control.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Focusable descendants of `root`, in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.getAttribute("aria-hidden") !== "true" && el.getAttribute("tabindex") !== "-1",
  );
}

/**
 * Where focus goes when the dialog opens: an element the dialog explicitly
 * marked, else the first focusable one, else the dialog itself (which
 * carries tabIndex={-1} for exactly this case — a dialog with no controls
 * still has to take focus off whatever is behind it, or Escape and the
 * trap have nothing to act on).
 */
export function initialFocusTarget(root: HTMLElement): HTMLElement {
  const marked = root.querySelector<HTMLElement>("[data-dialog-autofocus]");
  if (marked && !marked.hasAttribute("disabled")) return marked;
  return focusableWithin(root)[0] ?? root;
}

/**
 * The element Tab (or Shift+Tab) should move to, given where focus is now.
 * Returns null when there is nothing to trap — the caller then leaves the
 * key alone rather than swallowing it.
 *
 * Focus that has escaped the dialog entirely (or was never in it) is pulled
 * back to the first/last element rather than left outside: the app behind a
 * dialog is blurred but not inert, so without this Tab walks into controls
 * the user cannot see.
 */
export function nextFocusTarget(
  root: HTMLElement,
  active: Element | null,
  shift: boolean,
): HTMLElement | null {
  const focusable = focusableWithin(root);
  if (focusable.length === 0) return root;
  const index = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
  if (index === -1) return shift ? focusable[focusable.length - 1]! : focusable[0]!;
  const next = shift ? index - 1 : index + 1;
  return focusable[(next + focusable.length) % focusable.length]!;
}
