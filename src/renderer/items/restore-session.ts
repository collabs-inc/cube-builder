/**
 * The terminal service surface accepted by `attemptReconnect`, kept as
 * an explicit interface (rather than `window.api`
 * directly, now that this module lives under services-only app code) so
 * tests can supply minimal fakes without modeling `services.pty`'s full
 * `PtySession`/`PtyDiscoverEntry` shapes. `services.pty` itself satisfies
 * this structurally (its `discover`/`reconnect` methods return richer
 * objects that are a superset of what's used here), so callers just pass
 * `services.pty` straight through. Method names match `services.pty`'s own
 * naming — the old terminal-tile guest's `window.api.ptyDiscover`/
 * `ptyReconnect` names, stripped of their `pty` prefix now that they're
 * grouped under `services.pty.*`.
 */



import { DEAD_SESSION_MARKER } from "@port/shared/types";
import type { PtyReconnectOptions } from "../services/types";

/**
 * A term:open/reconnect response, per terminals.ts's `SessionInfo` — `seq`
 * is optional here (not on the wire) purely so existing test doubles that
 * predate Task 9 don't all need updating to supply one; every real
 * response carries it. `exited`/`exitCode` mean the session ptyd still
 * retains past its exit (Task 9's term:list/term:open change): this is a
 * normal resolved result, not a thrown error — `isDeadSessionError` never
 * matches it, and the caller renders `scrollback` as the session's final
 * output rather than falling back to a fresh create.
 */
export interface ReconnectResult {
  scrollback?: string;
  seq?: number;
  reset?: boolean;
  scrollbackStart?: number;
  exited?: boolean;
  exitCode?: number;
}

export interface ReconnectDeps {
  discover: () => Promise<Array<{ sessionId: string }>>;
  reconnect: (
    sessionId: string,
    cols: number,
    rows: number,
    repoId: string | undefined,
    options?: PtyReconnectOptions,
  ) => Promise<ReconnectResult>;
}

/**
 * Attempts to reattach a restored terminal session.
 *
 * Every tile reconnects directly to its saved session. Discovery is a
 * best-effort aggregate: local and cloud endpoints alike can be absent
 * while socket admission or a cubed hot update is pending. An absent
 * discovery entry therefore cannot prove that ptyd lost the session.
 * Only cubed's own `session-not-found` response authorizes replacement.
 *
 * The remote flag remains in the call signature for existing callers;
 * both locations now follow the same restoration policy.
 */
export async function attemptReconnect(
  deps: ReconnectDeps,
  sessionId: string,
  cols: number,
  rows: number,
  repoId: string | undefined,
  _isRemoteRepo: boolean,
  options?: PtyReconnectOptions,
): Promise<ReconnectResult> {
  return deps.reconnect(sessionId, cols, rows, repoId, options);
}

/**
 * Whether a reconnect failure definitively means the session is gone —
 * cubed's own `session-not-found` (possibly wrapped by Electron's
 * "Error invoking remote method" prefix on its way through IPC).
 * Anything else — `request timed out (…)`,
 * `not connected (…)`, `connection lost` — is a transport failure: the
 * session may be alive behind it (a sprite waking from cold takes 60-90s
 * during which every request times out), so treating it as dead both
 * abandons a live session and spawns an orphan replacement server-side.
 */
export function isDeadSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(DEAD_SESSION_MARKER);
}

export interface RetryOptions {
  /**
   * Total elapsed-time budget across attempts. Default 180s: a sprite
   * cold-wake window is ~60-90s, and the main process's own term:open
   * timeout is 120s, so one in-flight attempt can legitimately take that
   * long before the first retry is even scheduled.
   */
  maxWaitMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  now?: () => number;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const DEFAULT_MAX_WAIT_MS = 180_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `attemptReconnect`, retried with backoff across transport failures.
 * A dead-session error (see `isDeadSessionError`) rethrows immediately —
 * retrying cannot revive it, and the caller's fresh-create fallback is the
 * right response. A transport error retries until the elapsed-time budget
 * runs out, then rethrows the last error so the caller can render the
 * failure WITHOUT falling back (the session may still be alive; keeping
 * the item's ptySessionId lets the next app launch reattach it). An
 * `exited: true` result (see ReconnectResult) is not an error at all —
 * it resolves through on the first attempt like any other success.
 *
 * `options` trails `opts` rather than sitting next to the other
 * connection params, so every existing call passing an options object
 * positionally stays valid unchanged.
 */
export async function reconnectWithRetry(
  deps: ReconnectDeps,
  sessionId: string,
  cols: number,
  rows: number,
  repoId: string | undefined,
  isRemoteRepo: boolean,
  opts: RetryOptions = {},
  options?: PtyReconnectOptions,
): Promise<ReconnectResult> {
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const start = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptReconnect(
        deps, sessionId, cols, rows, repoId, isRemoteRepo, options,
      );
    } catch (err) {
      if (isDeadSessionError(err)) throw err;
      const backoff = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] as number;
      if (now() - start + backoff > maxWaitMs) throw err;
      await sleep(backoff);
    }
  }
}
