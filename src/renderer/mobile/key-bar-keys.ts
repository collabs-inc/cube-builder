/**
 * The narrow item screen's terminal key bar — what each button sends, and
 * how it reaches the terminal.
 *
 * A phone keyboard has no Esc, no arrows, no Tab and no Ctrl, and Mobile
 * Safari's long-press paste never reaches xterm's hidden textarea. The bar
 * (MobileKeyBar.tsx) fills the strip under the terminal that the home
 * indicator's safe-area inset used to leave empty.
 *
 * Keys are delivered as synthetic `keydown` events on xterm's own helper
 * textarea rather than written to the pty as fixed byte strings, because
 * the bytes an arrow key means are a terminal MODE, not a constant: a
 * full-screen program (vim, less, an agent's TUI) turns on application
 * cursor keys (DECCKM) and expects `ESC O A`, while a shell line editor
 * expects `ESC [ A`. xterm tracks that mode and its keydown handler
 * already maps by it — the same path a hardware keyboard takes — so a
 * synthetic event gets the right bytes for free, and any custom key
 * handler TerminalTab attaches (Shift+Enter, Option-as-Meta) still sees
 * it. Chromium and WebKit both honour `keyCode` from the init dictionary,
 * which is what xterm's mapper reads.
 *
 * Paste is the same idea: a synthetic `paste` ClipboardEvent on the
 * textarea takes exactly the path a native paste does, so TerminalTab's
 * own capture-phase handler (text to the pty, images stashed for a remote
 * pty) stays the one implementation. Reading the clipboard is the only
 * part that needs a user gesture, which the tap supplies.
 */

/** One key event: `KeyboardEvent.key` / `.code` / legacy `keyCode` xterm's mapper reads. */
export interface KeyPress {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey?: boolean;
}

export interface KeyBarKey {
  /** Button label. */
  label: string;
  /** Accessible name — the label is a glyph for the arrows. */
  name: string;
  /** Word labels get a wider key than glyphs (MobileKeyBar.css). */
  wide?: boolean;
  /** Pressed in order; one entry for a plain key, more for a chord. */
  presses: readonly KeyPress[];
}

const ctrl = (letter: string): KeyPress => ({
  key: letter,
  code: `Key${letter.toUpperCase()}`,
  keyCode: letter.toUpperCase().charCodeAt(0),
  ctrlKey: true,
});
const arrow = (dir: "Left" | "Up" | "Down" | "Right", keyCode: number): KeyPress => ({
  key: `Arrow${dir}`,
  code: `Arrow${dir}`,
  keyCode,
});

export const KEY_BAR_KEYS: readonly KeyBarKey[] = [
  { label: "esc", name: "Escape", presses: [{ key: "Escape", code: "Escape", keyCode: 27 }] },
  { label: "tab", name: "Tab", presses: [{ key: "Tab", code: "Tab", keyCode: 9 }] },
  { label: "^C", name: "Control C", presses: [ctrl("c")] },
  { label: "←", name: "Arrow left", presses: [arrow("Left", 37)] },
  { label: "↑", name: "Arrow up", presses: [arrow("Up", 38)] },
  { label: "↓", name: "Arrow down", presses: [arrow("Down", 40)] },
  { label: "→", name: "Arrow right", presses: [arrow("Right", 39)] },
];

/**
 * Ctrl+E then Ctrl+U: end of line, then kill back to its start. Every
 * line editor anyone types into here agrees on that pair — bash and zsh
 * (zsh's ^U kills the whole line anyway), the agents' own input boxes,
 * vim's insert mode — where a "clear line" key per program does not
 * exist. Rendered past Paste, away from the arrows: it is destructive,
 * and a thumb working the arrows must not be able to graze it.
 */
export const CLEAR_KEY: KeyBarKey = {
  label: "clear",
  name: "Clear line",
  wide: true,
  presses: [ctrl("e"), ctrl("u")],
};

/**
 * xterm's hidden textarea inside the narrow screen's one visible pane.
 * The zoomed slot is the active item's (Rail.tsx's NARROW_ZOOM_STYLE), so
 * scoping to it never picks a hidden pane's terminal.
 */
export function findTerminalTextarea(root: ParentNode = document): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>(".rail-pane-zoomed .xterm-helper-textarea");
}

/** Sends a key (or chord) through xterm's keyboard path. False when no terminal is showing. */
export function sendKeyBarKey(k: KeyBarKey, root: ParentNode = document): boolean {
  const textarea = findTerminalTextarea(root);
  if (!textarea) return false;
  for (const p of k.presses) {
    const init: KeyboardEventInit = {
      key: p.key,
      code: p.code,
      keyCode: p.keyCode,
      which: p.keyCode,
      ctrlKey: p.ctrlKey ?? false,
      bubbles: true,
      cancelable: true,
    };
    textarea.dispatchEvent(new KeyboardEvent("keydown", init));
    textarea.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  return true;
}

/**
 * Reads the clipboard (gesture-gated; Safari answers with its own Paste
 * pill) and replays it as a paste on the terminal's textarea. Resolves
 * false when there was no terminal, no text, or no permission.
 */
export async function pasteIntoTerminal(root: ParentNode = document): Promise<boolean> {
  const textarea = findTerminalTextarea(root);
  if (!textarea) return false;
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return false;
  }
  if (!text) return false;
  const data = new DataTransfer();
  data.setData("text/plain", text);
  textarea.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
  return true;
}
