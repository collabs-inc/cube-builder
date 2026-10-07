// Adapted from packages/components/src/Terminal/dictation-sync.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * iOS dictation into xterm, without the transcript repeating itself.
 *
 * Mobile Safari's speech-to-text does not type: it REPLACES the field's
 * provisional text with the whole utterance so far on every recognition
 * update — "so", then "so this", then "so this is" — and fires an `input`
 * event of type `insertText` whose `data` is that whole string each time.
 * xterm's own input handler forwards `data` verbatim (it is the emoji-
 * picker path, where each event really is one new character), so the pty
 * received every cumulative transcript concatenated: "soso thisso this
 * is…". A late correction ("testing this speech to" → "testing  to") got
 * appended too instead of replacing anything.
 *
 * The textarea's VALUE is the truth here, not the event's `data`: xterm
 * never clears the helper textarea on this path, so between two events
 * its value goes from the last transcript to the new one. This module
 * plans the bytes that move the pty's line from the text already synced
 * to the text now in the field — the unsynced tail when the new value
 * extends the old, DEL (0x7f, xterm's own Backspace) for each code point
 * past the common prefix plus the new tail when it revises it. Only
 * one-character-per-event input ever comes through with `value` equal to
 * `data` and nothing synced, and that case falls out as "send the tail",
 * which is what xterm did.
 *
 * DEL edits a LINE editor — a shell prompt or an agent's input box, the
 * places anyone dictates into. A full-screen program would see stray
 * backspaces on a correction; it already saw the duplicated transcript.
 *
 * `synced` is state the caller keeps per textarea and resets whenever
 * xterm empties the field behind our back (blur, and the Enter / Ctrl+C
 * keydowns): a stale prefix would otherwise turn into backspaces against
 * text that is no longer there. Even then the plan is bounded — with NO
 * common prefix it sends only the event's own `data`, never a DEL.
 */

export interface InsertPlan {
  /** Bytes for the pty; empty when the field did not change. */
  send: string;
  /** The field text now synced — the caller's next `synced`. */
  synced: string;
}

const DEL = "\x7f";

function commonPrefix(a: string, b: string): string {
  const ac = Array.from(a);
  const bc = Array.from(b);
  let i = 0;
  while (i < ac.length && i < bc.length && ac[i] === bc[i]) i++;
  return ac.slice(0, i).join("");
}

export function planInsert(synced: string, value: string, data: string): InsertPlan {
  if (value === "") return { send: data, synced: "" };
  if (value.startsWith(synced)) return { send: value.slice(synced.length), synced: value };
  const prefix = commonPrefix(synced, value);
  if (prefix === "") return { send: data, synced: value };
  const erase = Array.from(synced).length - Array.from(prefix).length;
  return { send: DEL.repeat(erase) + value.slice(prefix.length), synced: value };
}
