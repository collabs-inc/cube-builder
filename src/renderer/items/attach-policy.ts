/**
 * The attach-size policy, pure: how big a cold attach is, what window of
 * a session's output a tile holds, and how a scroll-up walks that window
 * back toward the retained start. Spec:
 * docs/superpowers/specs/2026-09-04-terminal-attach-cost-design.md.
 *
 * ptyd facts this rests on: a read is always the TRAILING window ending
 * at the ring's current end (`seq`), never "N bytes from sinceSeq"; the
 * daemon reports `scrollbackStart`, the exact first byte of the reply;
 * a reply was truncated exactly when scrollbackStart > sinceSeq.
 */

/** What a first attach asks for: many screens of a TUI, under a second on a slow link. */
export const COLD_TAIL_BYTES = 256 * 1024;
/** cubed's ceiling on any one reply; mirrored here so the ladder stops asking. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface HeldWindow {
  /** Byte cursor of the first byte the tile holds. */
  start: number;
  /** Byte cursor just past the last byte the tile holds (the reply's seq). */
  end: number;
  /** False against an old daemon (no scrollbackStart): estimated, never backfilled. */
  exact: boolean;
}

export function windowFromReply(reply: {
  seq: number;
  scrollback?: string;
  scrollbackStart?: number;
}): HeldWindow {
  if (reply.scrollbackStart !== undefined) {
    return { start: reply.scrollbackStart, end: reply.seq, exact: true };
  }
  const byteLength = new TextEncoder().encode(reply.scrollback ?? "").length;
  return { start: reply.seq - byteLength, end: reply.seq, exact: false };
}

export interface BackfillState {
  window: HeldWindow;
  /** Bytes the next step reaches back by; doubles per step. */
  step: number;
  /** True once no further backfill can add history. */
  done: boolean;
}

export function initialBackfill(window: HeldWindow): BackfillState {
  return { window, step: COLD_TAIL_BYTES, done: !window.exact || window.start === 0 };
}

/**
 * The next request, or null when the ladder is done. `received` is the
 * tile's live received-bytes cursor — the read's window ends at the
 * ring's CURRENT end, so sizing from the stale window end would slide
 * forward on a busy session and never reach back to sinceSeq.
 */
export function backfillRequest(
  state: BackfillState,
  received: number,
): { sinceSeq: number; maxBytes: number } | null {
  if (state.done) return null;
  const sinceSeq = Math.max(0, state.window.start - state.step);
  const maxBytes = Math.min(MAX_READ_BYTES, Math.max(1, received - sinceSeq));
  return { sinceSeq, maxBytes };
}

export function afterBackfillReply(
  state: BackfillState,
  request: { sinceSeq: number },
  reply: { seq: number; scrollbackStart: number; reset?: boolean },
): BackfillState {
  const window: HeldWindow = { start: reply.scrollbackStart, end: reply.seq, exact: true };
  const atRingStart = reply.scrollbackStart === 0;
  const wholeRing = reply.reset === true && reply.scrollbackStart <= request.sinceSeq;
  const atCeiling = reply.seq - reply.scrollbackStart >= MAX_READ_BYTES;
  return { window, step: state.step * 2, done: atRingStart || wholeRing || atCeiling };
}

/**
 * cubed forwards a session's live frames synchronously but sends the
 * term:open reply a few microtasks later, so a frame can overtake the
 * reply. If the tile has received past the reply's seq when it lands,
 * the in-band reset would wipe those bytes: ask for them again.
 */
export function followUpDelta(received: number, replySeq: number): { sinceSeq: number } | null {
  return received > replySeq ? { sinceSeq: replySeq } : null;
}
