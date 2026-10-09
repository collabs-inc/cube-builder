/**
 * Where the caret goes when a pane is claimed by its chrome rather than by
 * its content. Clicking a title bar selects the tile (Rail's slot-level
 * capture handler), but selection is not DOM focus, so typing used to keep
 * going to whatever was focused before — usually another terminal.
 *
 * Each selector is the editable element one live item type owns: xterm's
 * hidden textarea, monaco's input area, blocknote's contenteditable body,
 * and the conversation composer. `querySelector` returns the first match in
 * DOM order rather than in this list's order, so a pane with exactly one of
 * them gets it whatever its type. Reaching for a foreign library's class
 * from here is the same reach `mobile/key-bar-keys.ts` already makes for
 * xterm's textarea.
 */
const PANE_CARET_SELECTOR = [
  ".xterm-helper-textarea",
  ".monaco-editor textarea.inputarea",
  '.ProseMirror[contenteditable="true"]',
  ".agent-composer-input",
].join(", ");

/** The element inside `root` that should take the caret, if any. */
export function paneCaretTarget(root: ParentNode | null | undefined): HTMLElement | null {
  return root?.querySelector<HTMLElement>(PANE_CARET_SELECTOR) ?? null;
}
