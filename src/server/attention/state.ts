// Adapted from src/main/cubed/attention/state.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * One state machine per session. Events mutate DATA; the published state is
 * a pure function of that data.
 *
 * That distinction is the whole design. Earlier revisions of the spec wrote
 * a target state into every cell of a transition table, and it produced
 * contradictions immediately: a turn ending while a second turn's
 * permission was still pending selected `running`, and a new turn opening
 * retired a set that still had unanswered requests in it. Nothing here can
 * select `running` while a request is pending, because nothing selects at
 * all — `derive` reads the pending sets and answers.
 *
 * A request is retired by an authoritative hook or explicit user
 * cancellation, never inferred from output. A bell or a
 * silence is evidence that output stopped, which is exactly what an agent
 * waiting for an answer looks like. The floor may observe that a turn is
 * over; it may never conclude that a question was answered.
 */

export type AttentionState = "idle" | "running" | "blocked";

/**
 * What a session's hook lane can report. Claude's hooks report both a turn
 * opening and ending; codex's `notify` program reports only the end; a
 * session launched without injection (a shell-typed agent, or one that
 * predates this feature) reports neither and lives on the floor alone.
 */
export interface HarnessProfile {
  opens: boolean;
  ends: boolean;
}

export const NO_HOOKS: HarnessProfile = { opens: false, ends: false };

export interface Limits {
  /** Bytes of sustained output that open an inferred turn. */
  openBytes: number;
  /** How long a turn's lease survives without fresh output or reports. */
  leaseMs: number;
  /** How long a hook report keeps the lane healthy. */
  laneHealthMs: number;
  /** Cap on retained pending requests before the conservative collapse. */
  maxRequests: number;
  /** Cap on remembered ended turn ids, for stale-report rejection. */
  maxEndedTurns: number;
  /** Output this soon after client input is echo, not agent work. */
  echoMs: number;
  /** No turn is inferred this soon after an authoritative end: trailing redraw. */
  graceMs: number;
  /**
   * Extra silence a hook-opened turn tolerates before the floor ends it,
   * when the lane also reports ends. The harness will say when it is done;
   * the floor only covers an end the harness never reports (an interrupt).
   */
  hookQuietMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  openBytes: 256,
  leaseMs: 3_000,
  laneHealthMs: 120_000,
  maxRequests: 64,
  maxEndedTurns: 32,
  echoMs: 250,
  graceMs: 2_000,
  hookQuietMs: 30_000,
};

export type AttentionEvent =
  | { kind: "turn-opened"; turn: string | null; at: number }
  | { kind: "permission-requested"; turn: string | null; key: string; at: number }
  | { kind: "permission-settled"; turn: string | null; key: string | null; at: number }
  | { kind: "turn-ended"; turn: string | null; at: number }
  | { kind: "bell"; at: number }
  | { kind: "quiet"; at: number }
  | { kind: "output"; cursor: number; bytes: number; at: number }
  | { kind: "input"; at: number; typed: boolean }
  | { kind: "interrupted"; at: number; turn?: string }
  | { kind: "gone"; at: number }
  | { kind: "dismissed"; at: number };

const HOOK_KINDS = new Set(["turn-opened", "permission-requested", "permission-settled", "turn-ended"]);

export interface SessionData {
  /**
   * Turn id to its unsettled request keys. NEVER holds the unattributed
   * bucket: keeping them in one map is how an earlier draft let a turn-less
   * end wipe requests no turn could claim.
   */
  pending: Map<string, Set<string>>;
  /**
   * Requests whose report carried no turn id. Retired only by `gone` or
   * `dismissed` — no turn can speak for them.
   */
  unattributed: Set<string>;
  pendingCount: number;
  /**
   * The cap was hit and the sets were collapsed into one conservative
   * marker meaning "blocked, count unknown". Because the marker is
   * unscoped, it deliberately does NOT clear on a turn ending.
   */
  overflowed: boolean;
  openTurn: { id: string | null; authoritative: boolean } | null;
  /** Bounded FIFO of turns already ended, so a late report is rejected. */
  endedTurns: string[];
  /** Sustained output accumulated across chunks; reset by quiet. */
  outputRun: number;
  /** Renewed by output AND by hook reports. */
  leaseUntil: number;
  lastHookAt: number | null;
  /** A turn's lease lapsed without the report it was due. */
  laneFailed: boolean;
  gone: boolean;
  profile: HarnessProfile;
  lastInputAt: number | null;
  /**
   * A user keystroke arrived since the last turn ended (or since launch).
   * A lane that cannot report opens infers a turn only then: an agent tile
   * does not start working unprompted, so output with no keystroke behind
   * it — a startup banner, trailing redraw, a harness's own background
   * turn — is never the user's turn.
   */
  typedSinceEnd: boolean;
  lastEndAt: number | null;
  /**
   * A `blocked` row this daemon inherited from a previous one. The request
   * behind it is unknowable, so the next authoritative turn boundary
   * retires it rather than an exit alone.
   */
  restoredBlock: boolean;
}

export function emptySession(profile: HarnessProfile = { opens: true, ends: false }): SessionData {
  return {
    pending: new Map(),
    unattributed: new Set(),
    pendingCount: 0,
    overflowed: false,
    openTurn: null,
    endedTurns: [],
    outputRun: 0,
    leaseUntil: 0,
    lastHookAt: null,
    laneFailed: false,
    gone: false,
    profile,
    lastInputAt: null,
    typedSinceEnd: false,
    lastEndAt: null,
    restoredBlock: false,
  };
}

function hasPending(d: SessionData): boolean {
  return d.overflowed || d.restoredBlock || d.pendingCount > 0 || d.unattributed.size > 0;
}

/** A lane that reports both a turn opening and ending. */
function fullLane(d: SessionData): boolean {
  return d.profile.opens && d.profile.ends;
}

function laneHealthy(d: SessionData, now: number, limits: Limits): boolean {
  if (d.lastHookAt === null || d.laneFailed) return false;
  return now - d.lastHookAt <= limits.laneHealthMs;
}

export function derive(
  d: SessionData,
  now: number,
  limits: Limits,
): { state: AttentionState; stale: boolean } {
  if (d.gone) return { state: "idle", stale: false };
  if (hasPending(d)) {
    // Stale says the block is real but unconfirmed. Presentation only; it
    // never retires anything.
    return { state: "blocked", stale: d.lastHookAt !== null && !laneHealthy(d, now, limits) };
  }
  if (d.openTurn) return { state: "running", stale: false };
  return { state: "idle", stale: false };
}

function clone(d: SessionData): SessionData {
  return {
    ...d,
    pending: new Map([...d.pending].map(([k, v]) => [k, new Set(v)])),
    unattributed: new Set(d.unattributed),
    endedTurns: [...d.endedTurns],
  };
}

function collapse(d: SessionData): void {
  d.pending = new Map();
  d.unattributed = new Set();
  d.pendingCount = 0;
  d.overflowed = true;
}

function rememberEnded(d: SessionData, turn: string, limits: Limits): void {
  if (!d.endedTurns.includes(turn)) d.endedTurns.push(turn);
  while (d.endedTurns.length > limits.maxEndedTurns) d.endedTurns.shift();
}

/**
 * Closes the open turn and REMEMBERS it, however it closed.
 *
 * An earlier draft recorded only hook-sourced ends, which left a hole the
 * floor could walk through: a turn the floor ended could be reopened by a
 * late report, or have a permission attached to it, blocking a finished row
 * forever — and `open(A) → quiet → open(A) → end(A)` stamped twice.
 */
export function endOpenTurn(d: SessionData, limits: Limits, remember = true): boolean {
  if (!d.openTurn) return false;
  const { id, authoritative } = d.openTurn;
  if (id !== null && remember) rememberEnded(d, id, limits);
  d.openTurn = null;
  d.outputRun = 0;
  d.typedSinceEnd = false;
  return authoritative;
}

export function reduce(
  prev: SessionData,
  event: AttentionEvent,
  limits: Limits,
): { data: SessionData; stamp: boolean } {
  const d = clone(prev);

  // A report naming a turn this session has already ended is stale and
  // changes nothing at all — not the pending sets, not lane health. Without
  // this, a late permission for a finished turn blocks the row forever.
  if (HOOK_KINDS.has(event.kind) || (event.kind === "interrupted" && event.turn !== undefined)) {
    const turn = (event as { turn?: string | null }).turn ?? null;
    if (turn !== null && d.endedTurns.includes(turn)) return { data: prev, stamp: false };
    d.lastHookAt = event.at;
    d.laneFailed = false;
    d.leaseUntil = Math.max(d.leaseUntil, event.at + limits.leaseMs);
  }

  let stamp = false;

  switch (event.kind) {
    case "turn-opened": {
      // No set is retired here. A genuinely new turn arriving while an older
      // turn's requests are unanswered must keep the row blocked, and a
      // duplicate open must be idempotent. An inferred turn already open is
      // ADOPTED: same turn, now authoritative.
      // A full lane's harness takes one prompt at a time (claude cannot
      // accept a new prompt over an open permission dialog), so a new
      // turn proves every earlier one is over — answered, denied or
      // interrupted, and interrupts report no Stop. Without this an
      // interrupted question keeps the row blocked through every later
      // turn until exit.
      if (fullLane(d) && event.turn !== null) {
        for (const turn of [...d.pending.keys()]) {
          if (turn === event.turn) continue;
          d.pending.delete(turn);
          rememberEnded(d, turn, limits);
        }
        if (d.openTurn?.id && d.openTurn.id !== event.turn) rememberEnded(d, d.openTurn.id, limits);
        d.pendingCount = d.unattributed.size + [...d.pending.values()].reduce((n, s) => n + s.size, 0);
      }
      d.openTurn = { id: event.turn, authoritative: true };
      d.restoredBlock = false;
      break;
    }
    case "permission-requested": {
      if (d.overflowed) break;
      if (event.turn === null) {
        d.unattributed.add(event.key);
      } else {
        const set = d.pending.get(event.turn) ?? new Set<string>();
        set.add(event.key);
        d.pending.set(event.turn, set);
      }
      d.pendingCount = d.unattributed.size + [...d.pending.values()].reduce((n, s) => n + s.size, 0);
      // Collapse rather than grow. Over-reporting attention is preferred to
      // forgetting a question.
      if (d.pendingCount > limits.maxRequests) collapse(d);
      break;
    }
    case "permission-settled": {
      // A settle removes a request only when the harness supplies an
      // identity naming it. Claude's interactive tools use tool_use_id from
      // Pre/PostToolUse; ordinary PermissionRequest has no id and waits for
      // the turn's authoritative end. Matching on tool
      // name and input is unsound: a call already approved and executing is
      // not in the pending set, so its post-tool event can uniquely match a
      // DIFFERENT request still waiting.
      if (event.key === null) break;
      // A turn-less settle cannot clear an unattributed request: the spec
      // retires those by exit or explicit cancellation only. Nothing else is entitled
      // to decide that a question nobody could attribute was answered.
      if (event.turn === null) break;
      {
        const set = d.pending.get(event.turn);
        if (set?.delete(event.key) && set.size === 0) d.pending.delete(event.turn);
      }
      d.pendingCount = d.unattributed.size + [...d.pending.values()].reduce((n, s) => n + s.size, 0);
      break;
    }
    case "turn-ended": {
      // A turn-less end names no turn and therefore claims nothing: it may
      // not retire the unattributed bucket, and it may not close a turn.
      if (event.turn === null) break;
      rememberEnded(d, event.turn, limits);
      d.pending.delete(event.turn);
      d.pendingCount = d.unattributed.size + [...d.pending.values()].reduce((n, s) => n + s.size, 0);
      d.restoredBlock = false;
      d.lastEndAt = event.at;
      d.typedSinceEnd = false;
      // An open turn with no id — inferred from output, or inherited from a
      // previous daemon — is the turn this report is ending: there is only
      // ever one turn open. The end is authoritative whatever opened it.
      if (d.openTurn && (d.openTurn.id === event.turn || d.openTurn.id === null)) {
        endOpenTurn(d, limits);
        stamp = true;
      } else if (fullLane(d)) {
        // A full lane's Stop is a completion whether or not this daemon saw
        // the turn open: it may have opened before a restart, or the floor
        // may already have closed it on silence. Stale Stops never reach
        // here — a turn already ended is rejected above.
        stamp = true;
      }
      break;
    }
    case "bell":
    case "quiet": {
      // The floor's guard is SESSION-WIDE, not turn-scoped. It carries no
      // turn id, so it cannot reason about which question is outstanding,
      // and silence while anything is pending anywhere is not evidence that
      // this turn finished cleanly.
      if (event.kind === "quiet") {
        // A sweep landing while the lease is still live tells us nothing:
        // output was recent. Return without touching the accumulated run.
        // Zeroing it here was wrong twice over — it erased the evidence the
        // `owedReport` check below depends on, AND it broke inference for a
        // slow streamer, whose small chunks would be reset by every sweep
        // that happened to land between them and never reach the threshold.
        const patience = d.openTurn?.authoritative && d.profile.ends ? limits.hookQuietMs : 0;
        if (event.at <= d.leaseUntil + patience) break;
        // Did anything happen that a healthy lane should have reported?
        // An open turn owes a Stop; a pending request owes a settlement;
        // a sustained output run owes a prompt-submit. Silence after any of
        // those is not idleness, it is a lane that failed, and that is what
        // re-enables inference before the health window expires. Ordinary
        // silence on a session where nothing was owed is NOT failure, which
        // is why this is measured rather than assumed.
        // On a full lane, output alone owes nothing: the harness redraws its
        // own screen between turns, and that must not read as a failed lane.
        const owedReport = d.openTurn !== null || hasPending(d)
          || (!fullLane(d) && d.outputRun >= limits.openBytes);
        if (owedReport && d.lastHookAt !== null) d.laneFailed = true;
        // Real silence, so the run is genuinely broken.
        d.outputRun = 0;
      }
      if (hasPending(d)) break;
      // A full lane's turn closed by silence is provisional: it is not
      // remembered as ended, so the harness's own Stop still counts when it
      // comes, and a quiet turn that was really still working stamps again.
      stamp = endOpenTurn(d, limits, !fullLane(d));
      break;
    }
    case "input": {
      d.lastInputAt = event.at;
      if (event.typed) d.typedSinceEnd = true;
      break;
    }
    case "output": {
      d.leaseUntil = event.at + limits.leaseMs;
      // Echo of what the user just typed is not the agent working. It still
      // renews the lease, but never counts toward opening a turn.
      const echo = d.lastInputAt !== null && event.at - d.lastInputAt <= limits.echoMs;
      if (!echo) d.outputRun += event.bytes;
      // Who opens turns. A full lane this daemon injected (claude) is
      // trusted from its first byte: its silence before the first prompt
      // is not absence, and inferring there lights every tile at launch on
      // its startup banner. Only a lane seen failing hands opening back to
      // the floor. A partial or unknown lane is trusted only while healthy,
      // and one that cannot report opens at all (codex) never is.
      const laneOpens = fullLane(d) ? !d.laneFailed : d.profile.opens && laneHealthy(d, event.at, limits);
      const inGrace = d.lastEndAt !== null && event.at - d.lastEndAt < limits.graceMs;
      const prompted = d.profile.opens || d.typedSinceEnd;
      if (!d.openTurn && !laneOpens && !inGrace && prompted && d.outputRun >= limits.openBytes) {
        // An INFERRED turn. It may never stamp on its own end, so a false
        // start from input echo or a redraw costs a spurious `running` dot
        // and can never manufacture a `done` dot.
        d.openTurn = { id: null, authoritative: false };
      }
      break;
    }
    case "interrupted": {
      // Escape/Ctrl-C cancels the active work or question, not a completed
      // result. Remember its identities so delayed hooks cannot restore a
      // canceled question or manufacture a successful completion.
      for (const turn of d.pending.keys()) rememberEnded(d, turn, limits);
      if (event.turn) rememberEnded(d, event.turn, limits);
      endOpenTurn(d, limits);
      d.pending = new Map();
      d.unattributed = new Set();
      d.pendingCount = 0;
      d.overflowed = false;
      d.restoredBlock = false;
      d.outputRun = 0;
      d.typedSinceEnd = false;
      d.lastInputAt = event.at;
      d.lastEndAt = event.at;
      // Keep an injected Claude lane authoritative after interruption;
      // its redraw must not be treated as a missed prompt-submit hook.
      d.laneFailed = false;
      break;
    }
    case "gone":
    case "dismissed": {
      d.pending = new Map();
      d.unattributed = new Set();
      d.pendingCount = 0;
      d.overflowed = false;
      d.openTurn = null;
      d.outputRun = 0;
      d.restoredBlock = false;
      d.gone = event.kind === "gone";
      break;
    }
  }

  return { data: d, stamp };
}
