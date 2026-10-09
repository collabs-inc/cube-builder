//
// The frozen interface between cubed and ptyd. ADDITIVE ONLY, FOREVER:
// never change an existing field or signature, only add. ptyd cannot be
// updated without a machine restart, so an older cubed must keep working
// against a newer ptyd indefinitely.
//
// Governing rule: nothing belongs here if cubed can derive it from data
// it already has. No defaults, no parsing, no platform branching, no naming.
// 3 (2026-09-05): pipe sessions — `SpawnParams.stdio`, `SessionSnapshot.stdio`,
// `SessionSnapshot.stderrTail`. Additive; an older cubed never sends
// `stdio` and gets a pty exactly as before.
export const PTYD_INTERFACE_VERSION = 3;
// SHA-256 of sorted, newline-separated name@version entries (no final newline):
// bun.lock-resolved closure of CUBED_RUNTIME_DEPS plus node-pty, electron@major
// from bun.lock, and node@major from package.json engines.node lower bound.
// Baseline 2026-09-10; bump PTYD_INTERFACE_VERSION and this marker together
// when the envelope changes, then roll the image. See scripts/runtime-envelope.mjs.
export const RUNTIME_ENVELOPE_HASH = "54119de0ba389c24d063318e9c08453f2a4c6d883329dcdd3e1f1de65ae5ab6a";

/**
 * The first ptyd interface that can spawn a pipe session. cubed checks the
 * attached ptyd's hello against this before an `agent` launch and refuses
 * with `machine-needs-update` rather than raising
 * CUBED_REQUIRES_PTYD_INTERFACE — see that constant's docstring for why a
 * bundle-wide floor would strand the fleet.
 */
export const PTYD_PIPE_INTERFACE = 3;

/**
 * What a cubed BUNDLE declares it needs from ptyd, written into its
 * manifest and checked by `../../src/main/ptyd/supervisor.ts`'s
 * `verifyBundle` before a bundle is ever spawned.
 *
 * Deliberately NOT `PTYD_INTERFACE_VERSION`. That constant moves whenever
 * ptyd gains a channel; this one moves only when a bundle genuinely cannot
 * run on the older ptyd. Tying the two together would mark every
 * app-built cubed as requiring the newest ptyd the moment ptyd gained a
 * channel, and every cloud machine that had not been rolled yet would
 * refuse the bundle and strand — a fleet-wide outage caused by a constant.
 */
// 2 (2026-08-24): the Cube rename changed the env ptyd hands its child
// (COLLABD_TOKEN -> CUBED_TOKEN, …); a renamed bundle exits at startup
// under a collab-era ptyd, so the pre-check must strand those machines
// instead of letting a doomed hot swap revert.
export const CUBED_REQUIRES_PTYD_INTERFACE = 2;

export interface SpawnParams {
  /** Fully resolved by cubed. ptyd adds nothing and rewrites nothing. */
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /**
   * Passed straight through to the pty as its `TERM`. Required rather than
   * defaulted: ptyd cannot be updated without a machine restart, so any
   * default baked in here would be frozen on every machine forever. cubed
   * picks the value (`xterm-256color` today) and can change its mind later
   * without ptyd ever needing to move.
   */
  term: string;
  /** Opaque to ptyd: stored, persisted, and returned, never parsed. */
  meta: string;
  /**
   * "pty" (or absent) spawns on a pseudo-terminal as always. "pipe" spawns
   * on plain pipes: no echo, no TERM, `cols`/`rows`/`term` ignored, and the
   * session's ring holds BOTH directions as pipe records (see
   * @port/shared/pipe-records) with stdout split one record per line.
   */
  stdio?: "pty" | "pipe";
}

export interface SessionSnapshot {
  id: string;
  pid: number;
  meta: string;
  /** Lifetime bytes written by this session's pty. */
  seq: number;
  alive: boolean;
  /** Absent from a ptyd older than PTYD_PIPE_INTERFACE, which only ever has ptys. */
  stdio?: "pty" | "pipe";
  /**
   * Pipe sessions only, and carried ONLY when the session has exited
   * (`alive === false`). The last 16 KiB the child wrote to stderr. Live
   * sessions omit this field because `list()` runs every 5 s from cubed's
   * record sweep and must stay small.
   */
  stderrTail?: string;
}

export interface ExitRecord {
  id: string;
  code: number;
  at: string;
}

export interface ReadArgs {
  id: string;
  sinceSeq: number;
  /**
   * Caps the response to at most this many trailing bytes. Optional so an
   * older cubed (built before this field existed) still gets a response
   * at all — but every current caller sets it: an unbounded read crosses
   * the wire as a JSON byte array, which expands 3.5-4x over the raw
   * buffer size and can exceed the framing layer's frame-size limit,
   * destroying the connection instead of just failing the one request.
   * When the requested range holds more than `maxBytes`, ptyd returns the
   * last `maxBytes` bytes with `reset: true` — the same "you cannot be
   * brought up to date incrementally" signal a wrapped ring buffer already
   * produces for `readSince`, extended to mean "or you asked for more than
   * this fits."
   */
  maxBytes?: number;
}

export interface ReadResult {
  data: Buffer;
  seq: number;
  /** True when `sinceSeq` fell off the tail: the client must clear first. */
  reset: boolean;
}

export interface HelloPayload {
  interfaceVersion: number;
  ptydVersion: string;
}

export const PTYD_CHANNELS = {
  hello: "ptyd:hello",
  /** Child -> ptyd: "my startup completed" — the supervisor's promotion
   *  signal. Fire-and-forget: an older ptyd answers "Unknown channel" and
   *  the child ignores it. */
  ready: "ptyd:ready",
  spawn: "ptyd:spawn",
  resize: "ptyd:resize",
  kill: "ptyd:kill",
  list: "ptyd:list",
  read: "ptyd:read",
  output: "ptyd:output",
  exit: "ptyd:exit",
  desync: "ptyd:desync",
} as const;
