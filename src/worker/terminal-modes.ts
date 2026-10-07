// Adapted from src/main/cubed/terminal-modes.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Tracks the DEC private modes a pty session has switched on, so a
 * reattach that replays only a trailing window of its output can put the
 * terminal back into the state the window assumes.
 *
 * The bug this exists for: a fullscreen TUI (Claude Code's `tui:
 * fullscreen`, vim, htop) enters the alternate screen with `CSI ? 1049 h`
 * exactly once, at boot. A reattach asks ptyd for the trailing 256 KiB and
 * forces `reset`, the client applies that as RIS + tail, and RIS drops
 * xterm back to the normal buffer — so the replayed repaints land in the
 * wrong buffer, every newline-terminated frame pushes a row into
 * scrollback, and a touch drag on the phone scrolls into that garbage
 * instead of reaching the TUI. The same loss applies to every other
 * mode a TUI sets once and relies on afterwards: mouse tracking, bracketed
 * paste, application cursor keys, a hidden cursor.
 *
 * This is the same repair tmux performs on client attach. It is a byte
 * scanner, not a terminal emulator: it recognises `CSI ? Pm h|l`, RIS
 * (`ESC c`) and DECSTR (`CSI ! p`), keeps parser state across chunk
 * boundaries so a sequence split by a frame edge still counts, and
 * ignores everything else. `restore()` is the byte string a client should
 * parse ahead of a resetting tail.
 */

/**
 * The modes worth restoring, with the state a freshly reset terminal has.
 * Only a state that differs from that default is re-emitted. Order here is
 * emission order, and the alternate screen must come first: xterm clears
 * the alternate buffer on entry, so anything emitted before it is safe,
 * but a mode that the alternate screen switch itself touches (cursor
 * visibility, on 1049's save/restore) has to be re-applied after it.
 *
 * Deliberately absent: 2026 (synchronized output — transient by design,
 * and an app mid-frame at attach time would leave the client stuck), and
 * anything that isn't a mode at all (colours, title, cursor position —
 * the replayed tail carries those).
 */

/** Same shape session-records.ts accepts: a file name, never a path. */

const TRACKED: ReadonlyArray<{ mode: number; defaultOn: boolean }> = [
  { mode: 1049, defaultOn: false }, // alternate screen, with cursor save/restore and clear
  { mode: 1047, defaultOn: false }, // alternate screen, with clear
  { mode: 47, defaultOn: false }, // alternate screen
  { mode: 1, defaultOn: false }, // DECCKM — application cursor keys
  { mode: 7, defaultOn: true }, // DECAWM — auto-wrap
  { mode: 25, defaultOn: true }, // DECTCEM — cursor visible
  { mode: 1000, defaultOn: false }, // mouse: press/release
  { mode: 1002, defaultOn: false }, // mouse: button motion
  { mode: 1003, defaultOn: false }, // mouse: any motion
  { mode: 1004, defaultOn: false }, // focus in/out reports
  { mode: 1005, defaultOn: false }, // mouse: UTF-8 encoding
  { mode: 1006, defaultOn: false }, // mouse: SGR encoding
  { mode: 1015, defaultOn: false }, // mouse: urxvt encoding
  { mode: 2004, defaultOn: false }, // bracketed paste
];

/** The three alternate-screen aliases: setting one clears the others. */
const ALT_SCREEN = new Set([1049, 1047, 47]);

/** What DECSTR (`CSI ! p`) puts back — it leaves the alternate screen alone. */
const SOFT_RESET: ReadonlyArray<number> = [1, 7, 25];

const DEFAULTS = new Map(TRACKED.map((m) => [m.mode, m.defaultOn]));

const ESC = 0x1b;

type Parser =
  | { kind: "ground" }
  | { kind: "esc" }
  | { kind: "csi"; params: string; intermediates: string };

export class TerminalModeTracker {
  /** Current state of every tracked mode; absent means default. */
  private readonly state = new Map<number, boolean>();
  private parser: Parser = { kind: "ground" };

  /**
   * Scans one chunk of pty output. Returns true when the set of modes
   * to restore changed, so a caller persisting the state knows when to
   * write.
   */
  feed(chunk: Uint8Array): boolean {
    let changed = false;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      switch (this.parser.kind) {
        case "ground":
          if (byte === ESC) this.parser = { kind: "esc" };
          break;
        case "esc":
          if (byte === 0x5b) {
            this.parser = { kind: "csi", params: "", intermediates: "" };
          } else {
            if (byte === 0x63) changed = this.resetAll() || changed; // ESC c — RIS
            this.parser = byte === ESC ? { kind: "esc" } : { kind: "ground" };
          }
          break;
        case "csi":
          if (byte >= 0x30 && byte <= 0x3f && this.parser.intermediates === "") {
            this.parser.params += String.fromCharCode(byte);
          } else if (byte >= 0x20 && byte <= 0x2f) {
            this.parser.intermediates += String.fromCharCode(byte);
          } else if (byte >= 0x40 && byte <= 0x7e) {
            changed = this.applyCsi(this.parser.params, this.parser.intermediates, byte) || changed;
            this.parser = { kind: "ground" };
          } else if (byte === ESC) {
            this.parser = { kind: "esc" };
          } else if (byte >= 0x20) {
            // Not a CSI sequence after all; a C0 control (BEL, LF, CR) is
            // allowed inside one and does not end it.
            this.parser = { kind: "ground" };
          }
          break;
      }
    }
    return changed;
  }

  /**
   * The bytes that re-establish every non-default mode, in `TRACKED`
   * order — empty when the terminal is already in its reset state.
   */
  restore(): string {
    let out = "";
    for (const { mode, defaultOn } of TRACKED) {
      const on = this.state.get(mode);
      if (on === undefined || on === defaultOn) continue;
      out += `\x1b[?${mode}${on ? "h" : "l"}`;
    }
    return out;
  }

  toJSON(): { modes: Record<string, boolean> } {
    const modes: Record<string, boolean> = {};
    for (const [mode, on] of this.state) {
      if (on !== DEFAULTS.get(mode)) modes[String(mode)] = on;
    }
    return { modes };
  }

  /** Rebuilds a tracker from `toJSON()` output; anything unrecognisable is an empty tracker. */
  static fromJSON(value: unknown): TerminalModeTracker {
    const tracker = new TerminalModeTracker();
    const modes = (value as { modes?: unknown } | null)?.modes;
    if (!modes || typeof modes !== "object") return tracker;
    for (const [key, on] of Object.entries(modes as Record<string, unknown>)) {
      const mode = Number(key);
      if (typeof on === "boolean" && DEFAULTS.has(mode)) tracker.state.set(mode, on);
    }
    return tracker;
  }

  private applyCsi(params: string, intermediates: string, final: number): boolean {
    if (intermediates === "!" && final === 0x70 && params === "") {
      // CSI ! p — DECSTR
      let changed = false;
      for (const mode of SOFT_RESET) changed = this.set(mode, DEFAULTS.get(mode)!) || changed;
      return changed;
    }
    if (intermediates !== "" || !params.startsWith("?")) return false;
    if (final !== 0x68 && final !== 0x6c) return false; // h | l
    const on = final === 0x68;
    let changed = false;
    for (const part of params.slice(1).split(";")) {
      if (!/^\d+$/.test(part)) continue;
      const mode = Number(part);
      if (!DEFAULTS.has(mode)) continue;
      if (ALT_SCREEN.has(mode)) {
        // One alternate screen, three names: whichever alias the app used
        // is the one restored, and leaving by any of them leaves.
        for (const alias of ALT_SCREEN) changed = this.set(alias, alias === mode && on) || changed;
      } else {
        changed = this.set(mode, on) || changed;
      }
    }
    return changed;
  }

  private resetAll(): boolean {
    const changed = this.restore() !== "";
    this.state.clear();
    return changed;
  }

  /** Returns true when the restore output changes as a result. */
  private set(mode: number, on: boolean): boolean {
    const before = this.state.get(mode) ?? DEFAULTS.get(mode);
    this.state.set(mode, on);
    return before !== on;
  }
}

