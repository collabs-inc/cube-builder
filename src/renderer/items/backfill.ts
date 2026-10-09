/**
 * Walks a tile's held window back toward the retained start, one
 * gesture at a time (spec §3). Owns the ladder state; applies replies in
 * band through the tab (never the scrollbackData effect); never touches
 * the session cursor maps — a backfill changes what the tile HOLDS, not
 * what it has RECEIVED.
 */



import { afterBackfillReply, backfillRequest, followUpDelta, initialBackfill, type BackfillState, type HeldWindow } from "./attach-policy";

export interface BackfillDeps {
  reconnect: (options: { sinceSeq: number; maxBytes?: number }) => Promise<{
    seq: number;
    scrollback?: string;
    scrollbackStart?: number;
    reset?: boolean;
  }>;
  /** `reset: true` for a window (clears first), `reset: false` for the follow-up delta (appends). */
  apply: (patch: { id: number; data: string; reset: boolean }) => void;
  /** The tile's live received-bytes cursor. */
  received: () => number;
}

export interface BackfillController {
  start(window: HeldWindow): void;
  /**
   * Drops the ladder without arming a new one — the session this tile
   * was walking back is gone (a respawn, a lost-session recovery). Any
   * step already in flight for the OLD epoch is left to resolve on its
   * own time; the epoch bump makes it a no-op (see `step()`) instead of
   * applying a stale window over whatever session comes next.
   */
  invalidate(): void;
  onHistoryTop(): void;
  onApplied(id: number): void;
  busy(): boolean;
}

export function createBackfillController(deps: BackfillDeps): BackfillController {
  let state: BackfillState | null = null;
  let inFlight = false;
  let pendingApply = new Set<number>();
  let nextId = 1;
  // Bumped by `start`/`invalidate`. A step captures it once, before its
  // first await, and refuses to touch `state`/`pendingApply` or call
  // `deps.apply` if it no longer matches after any await — the session
  // this step was reaching back for may have gone away (or a new one
  // already re-initialised the ladder) while the reply was in flight.
  let epoch = 0;

  const step = async (): Promise<void> => {
    if (!state || inFlight || pendingApply.size > 0) return;
    const request = backfillRequest(state, deps.received());
    if (!request) return;
    const stepEpoch = epoch;
    inFlight = true;
    try {
      const reply = await deps.reconnect(request);
      if (epoch !== stepEpoch) return;
      if (reply.scrollbackStart === undefined) {
        // An old daemon mid-session: stop the ladder for good.
        state = state && { ...state, done: true };
        return;
      }
      state = afterBackfillReply(state!, request, { ...reply, scrollbackStart: reply.scrollbackStart });
      const id = nextId++;
      pendingApply.add(id);
      deps.apply({ id, data: reply.scrollback ?? "", reset: true });
      const delta = followUpDelta(deps.received(), reply.seq);
      if (delta) {
        const more = await deps.reconnect({ sinceSeq: delta.sinceSeq });
        if (epoch !== stepEpoch) return;
        const deltaId = nextId++;
        pendingApply.add(deltaId);
        deps.apply({ id: deltaId, data: more.scrollback ?? "", reset: false });
        state = state && { ...state, window: { ...state.window, end: more.seq } };
      }
    } catch (err) {
      // A failed step produces no write, so nothing re-arms the tab's
      // history-top gate through the usual path (a completed patch
      // write). The controller still has no channel to re-arm it
      // directly — the retry is the user's: TerminalTab re-arms on a
      // scroll-DOWN gesture, so scrolling away and back retries this
      // step. The ladder state is untouched here, so the retry asks for
      // the same window at the same step.
      console.warn("[backfill] step failed:", err);
    } finally {
      inFlight = false;
    }
  };

  return {
    start(window) {
      epoch++;
      state = initialBackfill(window);
      inFlight = false;
      pendingApply = new Set();
    },
    invalidate() {
      epoch++;
      state = null;
      pendingApply = new Set();
    },
    onHistoryTop() {
      void step();
    },
    onApplied(id) {
      pendingApply.delete(id);
    },
    busy() {
      return inFlight || pendingApply.size > 0;
    },
  };
}
