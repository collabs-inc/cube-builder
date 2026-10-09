/**
 * Shared guard for a sidebar's document-level keyboard shortcuts (arrow-key
 * row navigation, F2/Delete/Escape, ...). These used to live in an isolated
 * `<webview>` document, where a window-level keydown listener could only
 * ever fire while that webview held OS focus — the shell's own webview
 * routing guaranteed the isolation for free. Now that a sidebar shares one
 * document with everything else the app renders (and, later, terminals and
 * editors), a document-level listener has to opt out explicitly instead:
 *
 * - never steal keystrokes typed into a text input, textarea, or
 *   contenteditable element (typing "j"/pressing Escape there shouldn't
 *   also navigate rows or clear a selection).
 * - never fire while some *other* element outside this sidebar's own
 *   container holds focus (a terminal, an editor). Rows in the tree aren't
 *   natively focusable, so the common case of nothing more specific than
 *   `body` holding focus is treated as "focus is still here" — only an
 *   explicit focus elsewhere disqualifies the event.
 *
 * `activeElement`/`bodyElement` are passed in (rather than read from a
 * global `document`) so this stays a pure function callers can unit-test
 * without a DOM environment — call sites pass `document.activeElement` and
 * `document.body`.
 */
export function shouldHandleSidebarKey(
  container: HTMLElement | null,
  activeElement: Element | null,
  bodyElement: Element | null,
): boolean {
  if (activeElement) {
    if (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA") return false;
    if ((activeElement as HTMLElement).isContentEditable) return false;
  }
  if (container && activeElement && activeElement !== bodyElement && !container.contains(activeElement)) {
    return false;
  }
  return true;
}
