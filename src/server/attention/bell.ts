// Adapted from src/main/cubed/attention/bell.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * A bounded streaming control-sequence parser whose only job is answering
 * "was that BEL a bell".
 *
 * It has to be a parser and not a byte scan because BEL is a legal OSC
 * terminator, and this repo emits OSC terminated by BEL in at least two
 * places of its own — the browser shim's OSC 5522 (shell-wrappers.ts) and
 * the daemon's OSC 7 cwd report (terminals.ts). Scanning chunks for 0x07
 * would promote ordinary title, cwd and hyperlink traffic into a
 * completion. The existing URL sniffer already treats BEL this way.
 *
 * Two conservative choices are worth stating, because the obvious
 * alternatives are both wrong. A newline does NOT prove ground state: the
 * daemon's own OSC 7 interpolates `$PWD` without stripping newlines, so a
 * path containing one would resynchronize the parser mid-string. And
 * hitting the length cap does NOT return to ground: doing so would promote
 * the overlong string's own terminating BEL into a bell. Both cases go
 * unsynced, where only a sequence boundary — an ESC we can follow to its
 * end, or an explicit CAN/SUB cancel — restores confidence.
 *
 * Retained state is O(1): a mode plus a counter.
 */

const BEL = 0x07;
const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;

/** Bytes inside one string sequence before we assume it is malformed. */
const MAX_STRING_BYTES = 8192;

type Mode =
  | "ground"
  | "esc"
  | "csi"
  | "osc"
  | "string" // DCS/SOS/PM/APC — ST-terminated only
  | "st-esc" // saw ESC inside osc/string, awaiting the backslash
  | "unsynced"; // nothing is trustworthy until a boundary proves ground

export class BellParser {
  private mode: Mode = "ground";
  private stringBytes = 0;
  private stringReturn: Mode = "osc";

  /**
   * Called after a byte-stream gap or an explicit reset. A recovery tail can
   * begin partway through a control sequence, so resuming the previous mode
   * reconstructs nothing.
   */
  resync(): void {
    this.mode = "unsynced";
    this.stringBytes = 0;
  }

  /** Returns the number of ground-state BELs in this chunk. */
  feed(chunk: Uint8Array): number {
    let bells = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;

      // CAN and SUB cancel any sequence in progress, from any mode. This is
      // the one byte pair that is unambiguous everywhere.
      if (b === CAN || b === SUB) {
        this.mode = "ground";
        this.stringBytes = 0;
        continue;
      }

      // ESC ABANDONS whatever was in progress and starts a fresh sequence,
      // everywhere except inside a string, where it may be the first half
      // of an ST. Handling it per-mode instead is how an earlier draft
      // manufactured bells: ESC inside `esc` fell through to ground, and
      // ESC inside `csi` was not a final byte so the following `]` was
      // taken as one. Both left the parser in ground with an OSC's
      // terminating BEL still to come.
      if (b === ESC && this.mode !== "osc" && this.mode !== "string" && this.mode !== "st-esc") {
        this.mode = "esc";
        this.stringBytes = 0;
        continue;
      }

      switch (this.mode) {
        case "unsynced":
          // ESC is handled above; nothing else restores confidence.
          break;
        case "ground":
          if (b === BEL) bells += 1;
          break;
        case "esc":
          if (b === 0x5b /* [ */) this.mode = "csi";
          else if (b === 0x5d /* ] */) { this.mode = "osc"; this.stringBytes = 0; this.stringReturn = "osc"; }
          else if (b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f /* P X ^ _ */) {
            this.mode = "string"; this.stringBytes = 0; this.stringReturn = "string";
          } else this.mode = "ground";
          break;
        case "csi":
          // Parameter and intermediate bytes are 0x20-0x3f; a final byte
          // 0x40-0x7e ends the sequence.
          if (b >= 0x40 && b <= 0x7e) this.mode = "ground";
          break;
        case "osc":
          if (b === BEL) this.mode = "ground"; // terminator, NOT a bell
          else if (b === ESC) this.mode = "st-esc";
          else if (++this.stringBytes > MAX_STRING_BYTES) this.mode = "unsynced";
          break;
        case "string":
          if (b === ESC) this.mode = "st-esc";
          else if (++this.stringBytes > MAX_STRING_BYTES) this.mode = "unsynced";
          break;
        case "st-esc":
          if (b === 0x5c /* \ */) this.mode = "ground";
          else if (b === ESC) this.mode = "st-esc";
          else this.mode = this.stringReturn;
          break;
      }
    }
    return bells;
  }
}
