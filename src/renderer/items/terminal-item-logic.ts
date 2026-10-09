/**
 * Pure decision logic extracted from TerminalItem.tsx so it's testable
 * without mounting xterm (not worth doing in happy-dom — see TerminalItem's
 * own doc comment). Four concerns live here:
 *  - deriveRestored: the old terminal-tile guest's `restored=1` URL param,
 *    now derived from the catalog item instead of a query string.
 *  - computeMetaSyncPatch: renderer.js's `syncTerminalTileMeta`, now a
 *    catalog patch (`services.catalog.updateItem`) instead of a direct tile
 *    mutation.
 *  - resumeTargetFor: what a dead session's respawn should resume, read
 *    straight off the item's own `agentSessionId` — authoritative on the
 *    catalog item now, so there is no more `readMeta`/session-record
 *    lookup to fall back on (that whole three-way branch — `decideResume`,
 *    `isRecordLookupUnsupported`, `decideRespawn` — is gone along with it).
 */



import { MACHINE_NEEDS_UPDATE_PREFIX } from "@port/shared/agent-protocol";
import { HARNESS_MISSING_PREFIX } from "@port/shared/types";
import type { OwnedItem } from "@port/shared/catalog";
import type { CatalogUpdateItemPatch, PtyMeta } from "../services/types";

/**
 * What a tile says when its session never started, or ended.
 *
 * "Session ended" is right for the ordinary case — a shell that exited, a
 * reconnect that gave up — and says all there is to say. A missing agent
 * harness is the one failure the user can act on, so the main process marks
 * it (HARNESS_MISSING_PREFIX) and the rest of that message is shown as
 * written. The prefix is searched for rather than matched at position 0:
 * by the time an Error crosses Electron's IPC boundary it has picked up an
 * "Error invoking remote method 'pty:create': Error: " wrapper.
 */
export function sessionEndedMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const at = message.indexOf(HARNESS_MISSING_PREFIX);
  if (at === -1) return "Session ended";
  return message.slice(at + HARNESS_MISSING_PREFIX.length);
}

/**
 * What a FAILED LAUNCH says — a `catalog:add-item` (or `agent:resume`)
 * that never produced a session at all, as opposed to one that ended.
 *
 * Two failures are the user's to act on and are marked at the source:
 * `machine-needs-update` (a ptyd too old to spawn a conversation adapter —
 * @port/shared/agent-protocol) and `harness-not-installed` (no CLI on
 * PATH). Both carry their own sentence after the marker, written for the
 * user; anything else is shown as it came. The markers are searched for
 * rather than matched at position 0 for the same reason
 * `sessionEndedMessage` searches: by the time an Error crosses Electron's
 * IPC boundary it has picked up an "Error invoking remote method '…':
 * Error: " wrapper.
 *
 * These messages remain text. The cloud machine header independently
 * offers the confirmed image update after its connection capability probe
 * finds that ptyd cannot launch conversations.
 */
export function launchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  for (const prefix of [MACHINE_NEEDS_UPDATE_PREFIX, HARNESS_MISSING_PREFIX]) {
    const at = message.indexOf(prefix);
    if (at !== -1) return message.slice(at + prefix.length);
  }
  return message;
}

/**
 * Whether a workspace item's terminal session should be treated as a
 * restore (reattach with scrollback, skip the "Starting..." banner) rather
 * than a fresh start. Must be read once, at TerminalItem's first render —
 * callers should capture this in a `useState` lazy initializer, not
 * recompute it on every render: once a freshly created session's id lands
 * in the store via `updateItem`, the item looks identical to a genuinely
 * restored one, but it wasn't restored this app session. Mirrors the old
 * terminal-tile guest's `restored=1` URL param, which was likewise fixed at
 * page load and never re-derived from later state.
 */
export function deriveRestored(item: Pick<OwnedItem, "ptySessionId">): boolean {
  return !!item.ptySessionId;
}

/** What a destroyed terminal instance left behind for its successor:
 * its serialized rendered state, and the output cursor it ended at. */
export interface SessionSnapshot {
  snapshot: string;
  seq: number;
}

/**
 * The scrollback patch a REMOUNT applies — a new, empty xterm taking over
 * a live session, unlike `attachScrollback`'s same-instance re-attach.
 * Always resets (there is nothing on the screen worth keeping), and
 * composes the previous instance's serialized snapshot with the delta the
 * reconnect fetched from the snapshot's own cursor — which is what spares
 * a view switch from replaying ptyd's whole retained ring buffer (8 MB a
 * session, over the cloud socket, per terminal). A server `reset` means
 * that cursor fell off the retained buffer: the reply is already a full
 * replay, and the snapshot it overlaps must be discarded, not prepended.
 */
export function remountScrollback(
  stash: SessionSnapshot | undefined,
  result: { seq: number; scrollback?: string; reset?: boolean },
): ScrollbackPatch {
  const replay = result.scrollback ?? "";
  if (!stash || result.reset) return { data: replay, reset: true };
  return { data: stash.snapshot + replay, reset: true };
}

/**
 * The `sinceSeq` a reconnect should ask for: the tile's held cursor, or 0
 * on a first attach (no cursor yet — replay everything retained). Named
 * separately from a plain `?? 0` so the "first attach" rule has one place
 * to read and test, matching `SessionInfo.sinceSeq`'s own documented
 * default in terminals.ts.
 */
export function sinceSeqFor(lastSeq: number | undefined): number {
  return lastSeq ?? 0;
}

/** What TerminalTab needs to apply a term:open/reconnect response's output. */
export interface ScrollbackPatch {
  data: string;
  reset: boolean;
  redraw?: boolean;
}

/**
 * Maps a term:open/reconnect response onto TerminalTab's `scrollbackData`
 * prop. `reset: true` (the requested `sinceSeq` fell off the retained
 * buffer) always produces a patch — even with no `scrollback` bytes back —
 * so the tile clears whatever it rendered from a cursor the server can no
 * longer honor, rather than leaving stale content on screen. Otherwise
 * (an ordinary incremental re-attach), an empty `scrollback` means there is
 * nothing new to show and this returns null: a no-op re-attach must not
 * clear a live tile's screen.
 *
 * Deliberately does NOT derive the new cursor from `scrollback`'s length —
 * see `sinceSeqFor`'s caller in TerminalItem.tsx, which takes the
 * response's own `seq` instead. A `reset` reply's `scrollback` and `seq`
 * are not offset by the same `sinceSeq` the caller asked for (that's the
 * whole point of `reset`), so only the server's own count is correct here.
 */
export function attachScrollback(
  result: { seq: number; scrollback?: string; reset?: boolean },
): ScrollbackPatch | null {
  const reset = result.reset ?? false;
  if (!reset && !result.scrollback) return null;
  return { data: result.scrollback ?? "", reset };
}

/**
 * The exited-tile banner text — shown alongside (not instead of) the
 * terminal once a reconnect reports `exited: true`, so the session's final
 * output (rendered by TerminalTab from the same response's `scrollback`)
 * stays visible under it.
 */
export function exitedMessage(exitCode: number): string {
  return `Session ended (exit code ${exitCode})`;
}

/**
 * Maps a post-create `pty:discover` meta entry onto a workspace item patch:
 * `cwdHostPath` (falling back to `cwd`), which corrects the item's cwd if
 * the requested directory didn't exist and the pty opened its nearest
 * existing parent instead. Returns an empty patch if `meta` is absent.
 *
 * It deliberately does NOT patch `agentSessionId`. That field has exactly
 * two writers now — the router stamps claude's minted id when the item is
 * created, and cubed's discovery sweep corrects it from the running
 * process thereafter (see cubed/agent-discovery.ts). The sticky-once
 * rule that used to live here could not be made correct once codex
 * arrived: codex cannot be told what id to use, so its id is only ever
 * learned by discovery, and sticky-once would pin the item to whichever
 * thread the first sweep happened to see — permanently, including after
 * the user started a new one.
 */
export function computeMetaSyncPatch(
  meta: PtyMeta | null | undefined,
): CatalogUpdateItemPatch {
  if (!meta) return {};
  const patch: CatalogUpdateItemPatch = {};
  const cwd = meta.cwdHostPath || meta.cwd;
  if (cwd) patch.cwd = cwd;
  return patch;
}

export type ResumeTarget = { kind: "resume"; agentSessionId: string } | { kind: "fresh" };

/**
 * What a dead session's respawn should resume, read straight off the
 * item's own `agentSessionId`. Before Task 10 this required an async
 * `readMeta` round trip against cubed's durable session-record store,
 * with a three-way branch (resume / spawn fresh / keep the dead session
 * and render a failure) to tell "no record" apart from "the lookup
 * failed" — see the deleted `decideResume`/`isRecordLookupUnsupported`/
 * `decideRespawn` for that history. None of that applies anymore:
 * `agentSessionId` is authoritative on the catalog item itself, so there
 * is nothing to look up and therefore no lookup that can fail — this is a
 * plain, synchronous read with no keep-session branch to speak of.
 */
export function resumeTargetFor(item: OwnedItem): ResumeTarget {
  if (item.agentSessionId) return { kind: "resume", agentSessionId: item.agentSessionId };
  return { kind: "fresh" };
}

/** The facts `decideHeal` needs — see its own doc comment for each one's role. */
export interface HealDecisionInput {
  /** The create response's own `resumed` echo — never the request. */
  resumed: boolean;
  /** Elapsed ms since the `pty:create` result that armed the heal resolved. */
  msSinceCreate: number;
  /** The heal window — RESUME_HEAL_WINDOW_MS in TerminalItem.tsx. */
  windowMs: number;
  /** Whether this mount has already spent its one retry. */
  healUsed: boolean;
  /** Whether this exit was caused by this client's own close, not the session dying. */
  selfInitiated: boolean;
}

/**
 * Whether a resumed session's exit should trigger the fast-exit heal — the
 * single decision TerminalItem.tsx's onHealExit exists to make, extracted
 * here so a regression collapsing it — healing on every exit, or losing
 * the self-initiated exemption — fails a test at the branch point instead
 * of only slipping past every existing one. Unchanged by Task 10's catalog
 * rewiring: this signature never referenced the deleted `resumeHealArmed`
 * store flag (that flag only ever protected the item from live-status.ts's
 * old unconditional removal-on-exit, which no longer exists either — see
 * TerminalItem.tsx's own doc comments).
 *
 * A session that never actually spawned with resume arguments (`resumed`
 * false) has nothing to heal. Output can't discriminate a failed resume
 * from a successful one — a failed one prints its error to the pty before
 * exiting, a successful one paints its TUI in the same window — so only the
 * exit does, and only within `windowMs` of the create resolving
 * (`msSinceCreate`); past it, an exit is just an ordinary session ending.
 * `healUsed` enforces one retry per mount. `selfInitiated` exempts a close
 * this client itself initiated (see `closing`, state/live-status.ts) — the
 * case that must never heal, since it's the user closing a tile that
 * resumed successfully, not a resume that failed.
 */
export function decideHeal(input: HealDecisionInput): boolean {
  if (!input.resumed) return false;
  if (input.selfInitiated) return false;
  if (input.healUsed) return false;
  if (input.msSinceCreate > input.windowMs) return false;
  return true;
}

/**
 * Which session id a respawn's `createFreshSession` should forget once its
 * new session exists — the predecessor it supersedes, and only that one.
 * Extracted as its own function (mirroring `decideHeal` above) because the
 * failure mode is silent and permanent: `sessionId` is keyed only by the
 * item's `ptySessionId`, so forgetting the new id (or nothing) instead of
 * the old one stops looking wrong immediately — the tile keeps working —
 * and only shows up later as a durable record with no item left able to
 * name it. `supersededSessionId` must be the id captured *before* the
 * respawn's `create()` call (the item's own `ptySessionId` at that
 * moment), never read back off the item afterward: by the time this runs,
 * `ptySessionId` has already moved to `newSessionId`, so a live read here
 * would forget the wrong session. Returns `undefined` for a first-ever
 * create (no predecessor) or the degenerate case of a respawn
 * "superseding" itself.
 *
 * Kept unchanged by Task 10 despite `agentSessionId` moving onto the
 * catalog item: nothing reads session-records for a resume decision
 * anymore (`resumeTargetFor` above reads the item directly), so
 * `forgetRecord` is no longer load-bearing for correctness — but it's
 * still valid hygiene (an un-forgotten record is otherwise only reclaimed
 * by cubed's periodic `sweepRecords`), and removing the call would only
 * shift that cleanup cost onto the daemon for no behavioral gain. See the
 * task report for the full reasoning.
 */
export function forgetTargetForRespawn(
  supersededSessionId: string | undefined,
  newSessionId: string,
): string | undefined {
  if (supersededSessionId === undefined) return undefined;
  if (supersededSessionId === newSessionId) return undefined;
  return supersededSessionId;
}

/**
 * The display host of a URL an open-URL request names (TerminalItem's
 * consent banner) — what the user actually judges before clicking Open.
 * Falls back to the raw string when unparsable, so a weird-but-validated
 * request is still shown rather than hidden behind an empty banner.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
