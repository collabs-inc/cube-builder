import { terminalHost } from "../services/terminal-host";
import { isInstallationMachine } from "../services/machine";
/**
 * Renders a "term" catalog item's live terminal — the in-app replacement
 * for the terminal-tile webview guest this absorbs
 * (src/windows/terminal-tile/src/App.tsx). ItemHost mounts one of these,
 * keep-alive, for every displayed term item regardless of whether it's the
 * active one (Task 8's keep-alive design) — so, unlike the old guest
 * (whose webview only loaded once tile-manager.js decided to spawn it),
 * session creation here happens on mount even for a backgrounded item.
 * That's intentional: it matches ItemHost's "every displayed item is live"
 * model, and the pty itself doesn't care whether anything is drawing its
 * output yet.
 *
 * No component test: mounting this means mounting TerminalTab, which means
 * mounting real xterm (WebGL context, ResizeObserver, ...) — not worth
 * faking in happy-dom. The extractable pure logic (restored-flag
 * derivation, remote-flag lookup, meta-sync patch mapping, resume target)
 * lives in terminal-item-logic.ts and is unit-tested there instead.
 *
 * TerminalTab is pulled in via React.lazy, same as FileItem's monaco/
 * blocknote views — xterm (and its WebGL/Unicode11 addons) is heavy enough
 * to be worth its own chunk, separate from the app's entry bundle, even
 * though (unlike monaco/blocknote) nothing about TerminalTab.tsx itself
 * requires deferring the import: its one `window.api` read used to run at
 * module scope, which would have crashed any non-Electron import of this
 * file, but that's now read inside the component instead (see
 * TerminalTab.tsx's own `IS_MAC` comment).
 *
 * Item identity (this file's own concern, `item: OwnedItem`) is the
 * catalog's now, not this client's — see state/catalog.ts. Two things this
 * file used to own moved out with Task 10's rewiring:
 *  - `resumeHealArmed` is gone entirely. It only ever existed to stop
 *    live-status.ts's exit handler from deleting an item mid-heal; items
 *    are durable now (a pty exit stamps `exitedAt` on a surviving item,
 *    never removes it — see catalog.ts's `markExited`), so there is
 *    nothing left for the heal to be protected from.
 *  - `createTerminalItem` (below, exported) is the ONE place a brand-new
 *    term item gets created — via `services.catalog.addItem`, not from
 *    inside this component's own mount effect. Cubed broadcasts the
 *    durable item before its pty spawn finishes, so TerminalItem's outer
 *    gate may briefly render that pending row. The session controller only
 *    mounts once the row gains `ptySessionId`, or when `exitedAt` proves an
 *    older session needs recovery. Its mount effect reconnects or replaces
 *    a dead session on the SAME item via `services.catalog.updateItem` — it
 *    never mints a new item id.
 */



import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AGENT_HARNESS_IDS, LOCAL_MACHINE_ID } from "@port/shared/types";
import type { OwnedItem } from "@port/shared/catalog";
import { services } from "../services";
import { captureEvent } from "../analytics/capture";
import { useAppTheme } from "../hooks/useAppTheme";
import type { CatalogAddItemArgs, PtyReconnectOptions } from "../services/types";
import { catalogStore, repoRootsForMachine } from "../state/catalog";
import { getLiveState, setRecovering } from "../state/live-status";
import { planLaunch } from "./agent/create-agent-item";
import { attachScheduler } from "./attach-scheduler";
import { COLD_TAIL_BYTES, windowFromReply, type HeldWindow } from "./attach-policy";
import { createBackfillController, type BackfillController } from "./backfill";
import { isDeadSessionError, reconnectWithRetry } from "./restore-session";
import { repoForAbsPath } from "../state/repos";
import { openFile } from "./open-file";
import { resolveTerminalPath } from "./terminal-path-open";
import { createCommandDetector, terminalCommandProps } from "./terminal-command";

/** resolveTerminalPath with the tile's own machine context filled in —
 *  shared by the detection filter (canOpenPath) and the click handler,
 *  so a link never lights unless the same call would open it. */
function resolveTerminalItemPath(
  raw: string,
  item: { machineId: string; cwd?: string },
): string | null {
  const remote = item.machineId !== LOCAL_MACHINE_ID;
  return resolveTerminalPath(raw, {
    cwd: item.cwd,
    remote,
    ...(remote ? { repoRoots: repoRootsForMachine(item.machineId) } : {}),
  });
}
import { attachScrollback, computeMetaSyncPatch, decideHeal, deriveRestored, exitedMessage, hostOf, forgetTargetForRespawn, resumeTargetFor, sessionEndedMessage, remountScrollback, sinceSeqFor, type SessionSnapshot, type ScrollbackPatch } from "./terminal-item-logic";
import { dropHintText } from "../drag-drop";
import { useDropTarget } from "../state/drop-target";
import type { TerminalTransfer } from "@builder/components/Terminal";
import { LoadingPulse } from "@builder/components/LoadingPulse";
import "./TerminalItem.css";

const LazyTerminalTab = lazy(() =>
  import("@builder/components/Terminal").then((m) => ({ default: m.TerminalTab })),
);

/**
 * Only these targets' reported window titles are trusted — mirrors the old
 * host-side gate in tile-manager.js's spawnTerminalWebview. `onAgentTitle`
 * below is the only writer of `agentTitle`, and it's only ever wired when
 * `acceptTitles` is true, so this is the one gate now (the old
 * workspace-store `updateItem`'s own `item.target` check was defense in
 * depth on TOP of this one; there's no second layer left to defend now
 * that item mutation goes straight to `services.catalog.updateItem`,
 * which applies whatever patch it's given).
 */
const AGENT_TARGETS = new Set<string>(AGENT_HARNESS_IDS);

/**
 * How long a resumed session's exit still counts as "the resume failed" —
 * see the heal machinery below (armHeal/onHealExit/disarmHeal). A failed
 * resume prints its error to the pty *before* exiting, and a successful one
 * paints its TUI in the same window, so output can never tell them apart;
 * only the exit does. Measured from the `pty:create` result actually
 * resolving, not from the request: the renderer can't observe the
 * underlying spawn, and on a cold-waking machine the request can precede it
 * by up to two minutes.
 */
const RESUME_HEAL_WINDOW_MS = 5000;

/** Approximate terminal dimensions from the viewport before xterm mounts. */
function estimateTermSize(): { cols: number; rows: number } {
  const CHAR_WIDTH = 7.22; // Menlo 12px on macOS
  const CELL_HEIGHT = 17; // xterm line height at fontSize 12
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  return {
    cols: Math.max(80, Math.floor(w / CHAR_WIDTH)),
    rows: Math.max(24, Math.floor(h / CELL_HEIGHT)),
  };
}

export interface CreateTerminalItemOptions {
  machineId: string;
  personaId?: string;
  repoId?: string;
  cwd?: string;
  target?: string;
  view?: "conversation" | "terminal";
}

/**
 * Creates a terminal or an explicitly requested conversation.
 * The selected launch mode is independent of saved preferences.
 *
 * Target resolution (command/args/displayName, remote/
 * cloud routing, WSL, the harness-installed check) and the pty spawn
 * itself both live main-side now, in the router's own `catalog:add-item`
 * handling (`packages/router/src/router.ts`'s `catalogAddItem`) — this file
 * has no way to duplicate that logic and, per cubed's `openCatalogItem`,
 * must not try to: the catalog entry has to be persisted BEFORE the pty is
 * spawned (rolled back if the spawn fails), so nothing before that point
 * may create the pty on its own — a renderer-side pre-spawn (this
 * function's earlier design) inverts that ordering and reopens exactly the
 * invisible-live-pty-on-a-failed-write window `openCatalogItem` exists to
 * close.
 *
 * The returned item already carries whatever the router resolved
 * (`ptySessionId`, real `target`, real `cwd`) — this component's own mount
 * effect (`TerminalItem`, below) reconnects to it normally once a caller
 * places a pane for it, the same as any other existing item.
 *
 * Exported for whichever "new terminal"/"new agent" trigger needs it —
 * ReposSidebar.tsx today. Once created, the caller is responsible for
 * placing a pane for it (`focusItem` from state/workspace.ts) — this
 * function only creates the item, matching the ownership divide: what
 * exists is the catalog's, what's displayed is this client's.
 */
export async function createTerminalItem(options: CreateTerminalItemOptions): Promise<OwnedItem> {
  const plan = await planLaunch(options);
  if (!isInstallationMachine(options.machineId)) throw new Error("This workspace operates on the installation machine only");
  const args: CatalogAddItemArgs = { machineId: options.machineId, type: plan.type };
  if (options.repoId !== undefined) args.repoId = options.repoId;
  if (options.personaId !== undefined) args.personaId = options.personaId;
  if (options.cwd !== undefined) args.cwd = options.cwd;
  const target = plan.target ?? options.target;
  if (target !== undefined) args.target = target;
  const { item } = await services.catalog.addItem(args);
  return { ...item, machineId: options.machineId };
}

// Each session's output cursor — see terminal-item-logic.ts's `sinceSeqFor`
// (the sole reader: a same-instance re-attach, computing the `sinceSeq` to
// ask for) and `attachScrollback` (the response-side counterpart). Seeded
// from a create/reconnect response's own `seq` and kept current by
// TerminalTab's `onSeqAdvance` as live output arrives. Deliberately NOT
// read by the remount reattach: the cursor says what the previous,
// now-destroyed instance had rendered, and a remount's xterm is a new,
// empty one — it asks for a capped cold tail from 0 instead (see the
// remount branch in the effect below). The cursor stays meaningful for a
// same-instance re-attach, where
// the xterm keeps its content. Module-level rather than a ref, for the
// same reason attach-scheduler's own `started` guard is module-level (see
// its own doc comment): it must survive a genuine remount of a fresh
// component instance for the same item.id — React 18 StrictMode's
// mount->cleanup->mount double-invoke reuses the same fiber and would
// survive a ref too, but an error-boundary "reload" is a new fiber. Never
// cleared: item ids are minted server-side (randomUUID) and never reused,
// so a given id's entry only ever matters for that one item, for the app
// session's lifetime.
const lastSeqBySession = new Map<string, number>();

// What each unmounting TerminalTab leaves for its successor: the xterm's
// serialized rendered state, paired with the cursor it had reached — so a
// remount (a view switch, an error-boundary reload) restores the screen
// locally and reconnects for only the delta, instead of replaying ptyd's
// whole retained ring buffer (8 MB a session, over the cloud socket, per
// terminal, per switch). Module-level and never cleared for the same
// lifetime rule as the maps above; each unmount overwrites its session's
// entry, so at most one snapshot per session is ever held.
const sessionSnapshots = new Map<string, SessionSnapshot>();

// Recovery belongs to the catalog item, not the React instance that asked
// for it. A view recreated while a spawn is pending must await that same
// result, including its failure, instead of spawning twice or waiting for
// state updates addressed to its predecessor forever.
interface RecoveryResult {
  sessionId: string;
  resumed: boolean;
  target: string | undefined;
  cwd: string | undefined;
  createdAt: number;
}
const pendingRecoveries = new Map<string, Promise<RecoveryResult>>();

export interface TerminalItemProps {
  item: OwnedItem;
  /** Whether this item is on screen — TerminalTab uses it to refit on show. */
  visible: boolean;
  /** Whether this item is the workspace's active one — TerminalTab refits when it becomes so. */
  focused?: boolean;
}

function TerminalLoading() {
  return <LoadingPulse className="item-terminal-loading" label="Connecting terminal" />;
}

/**
 * A row with neither a pty nor an exit timestamp is not dead: it is the
 * first catalog broadcast from `openCatalogItem`, while cubed is still
 * spawning the brand-new pty. Keep the hookful controller unmounted so it
 * cannot mistake the row's newly-minted agentSessionId for a conversation
 * that needs resuming. When the completed row arrives, React mounts the
 * controller below and reconnects to cubed's pty exactly once.
 */
export function TerminalItem(props: TerminalItemProps) {
  if (!props.item.ptySessionId && props.item.exitedAt === undefined) {
    return <TerminalLoading />;
  }
  return <TerminalSessionController key={JSON.stringify([props.item.machineId, props.item.id])} {...props} />;
}

function TerminalSessionController({ item, visible, focused = false }: TerminalItemProps) {
  const theme = useAppTheme();
  // Always starts null, even when the item already carries a ptySessionId,
  // and even on a remount: TerminalTab must not mount until an attach
  // response has resolved with scrollback in hand — its [sessionId]-keyed
  // effect subscribes to the live stream, so mounting it early races
  // whatever the attach replays against bytes already streaming in. First
  // mounts resolve this through start(); remounts through the reattach
  // branch below (both set sessionId only alongside the scrollback patch,
  // in one batched render).
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Null until the session ends or fails to start; then the text the tile
  // shows in place of the terminal (see sessionEndedMessage).
  const [endedMessage, setEndedMessage] = useState<string | null>(null);
  // Lazy initializer: captured once at first render, see deriveRestored's
  // doc comment for why this must not be recomputed from `item` later.
  const [restored, setRestored] = useState(() => deriveRestored(item));
  // What a term:open/reconnect response contributes to the mounted
  // TerminalTab — see attachScrollback's doc comment for the reset/append
  // split. Replaces a write-once string: TerminalTab now applies this prop
  // whenever it changes, not just at its own mount (see its own
  // `[scrollbackData]` effect).
  const [scrollback, setScrollback] = useState<ScrollbackPatch | null>(null);
  // The output cursor `sessionId` starts from — passed to TerminalTab as
  // `initialSeq` so its own running cursor (reported via onSeqAdvance)
  // starts from the right place instead of 0.
  const [initialSeq, setInitialSeq] = useState(0);
  // Set only once a reconnect reports `exited: true` — the session died
  // (possibly mid-update) but ptyd still retained its final output, so
  // TerminalTab stays mounted and renders it; this only adds the "session
  // closed" indicator alongside it. Distinct from `endedMessage`, which
  // replaces the terminal entirely for a connection that never produced
  // any content to show.
  const [exitedInfo, setExitedInfo] = useState<{ exitCode: number } | null>(null);
  // A program in the pty asked for a URL to be opened on this machine
  // (the cloud cube-open shim, typically an auth flow). Held here until
  // the user acts — never auto-opened; the banner IS the consent step.
  // A newer request replaces an unacted-on older one.
  const [openUrlRequest, setOpenUrlRequest] = useState<string | null>(null);
  // Progress and failures for files dropped onto a remote terminal. The
  // tab reports; this layer renders, because a notice written into the
  // xterm buffer would garble a half-typed prompt and vanish on the next
  // reattach replay.
  const [transfer, setTransfer] = useState<TerminalTransfer | null>(null);
  // What dropping onto THIS terminal would do, while a file drag is over
  // it — the per-zone replacement for the old window-wide overlay, which
  // could only ever promise one thing for four different surfaces.
  const dropTarget = useDropTarget();
  const isRemote = true; // Browser file drops must upload to the installation machine.
  // One detector for the pane's lifetime, across reconnects: the
  // typed-since-Enter flag belongs to the user's train of thought, not
  // to any one pty attachment.
  const commandDetector = useRef(createCommandDetector());
  const dropHint =
    dropTarget?.zone === "terminal" && dropTarget.itemId === item.id
      ? dropHintText("terminal", { remote: isRemote })
      : null;
  // Heal bookkeeping — see armHeal/onHealExit/disarmHeal in the effect
  // below. Refs, not state: none of this should ever trigger a re-render.
  // Timestamp (Date.now()) the heal was armed at, or null when not armed.
  const healArmedAt = useRef<number | null>(null);
  // True once the CURRENT recovery has spent its one retry. Reset by
  // recoverDeadSession, not held for the life of the mount: a tile can lose
  // its session more than once in an app run (every ptyd restart does it),
  // and a budget that never refills leaves the second loss unhealed — the
  // tile sits on claude's "No conversation found" forever, which is exactly
  // what a second ptyd kill used to produce.
  const healUsed = useRef(false);
  // Unsubscribes armHeal's onAnyExit listener; null when not armed.
  const healOffExit = useRef<(() => void) | null>(null);
  // Cancels armHeal's window timer; null when not armed.
  const healTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The byte range of the session's output this tile currently holds, as
  // reported by the most recent attach reply — set in reattachExisting,
  // read by the backfill controller's `start()` below.
  const heldWindowRef = useRef<HeldWindow | null>(null);
  // Mirrors `sessionId` state for the backfill controller's `reconnect`,
  // which is created once (below) and needs the CURRENT session id at
  // call time, not the one closed over when the controller was built —
  // set alongside every `setSessionId` call.
  const currentSessionIdRef = useRef<string | null>(null);
  const followSessionRef = useRef<((id: string, recovery?: RecoveryResult) => void) | null>(null);
  // StrictMode restarts effects on the same instance; a true remount has
  // a different ref. Async creation may still serve the former, while a
  // destroyed instance must hand its heal subscription to the successor.
  const mountedRef = useRef(false);
  // The tile's live received-bytes cursor — mirrors `lastSeqBySession`'s
  // entry for this session, updated inside `onSeqAdvance` alongside it.
  // The backfill controller reads this instead of the map so a step
  // sizes from the running cursor, not a stale snapshot.
  const receivedRef = useRef(0);
  // A scroll-up patch to apply to the mounted TerminalTab in band —
  // through the data FIFO, never the scrollbackData effect (see
  // backfill.ts's own doc comment). Owned by the controller below;
  // `inband.id` is what `onInbandApplied` reports back as done.
  const [inband, setInband] = useState<{ id: number; data: string; reset: boolean } | null>(null);
  // Created once per mount. `reconnect` reads currentSessionIdRef/
  // receivedRef at CALL time (not closed over at creation time), since
  // the controller instance itself is stable across reconnects/remounts
  // within this component's lifetime.
  const backfill = useRef<BackfillController | null>(null);
  if (backfill.current === null) {
    backfill.current = createBackfillController({
      reconnect: (options) => {
        const { cols, rows } = estimateTermSize();
        return services.pty.reconnect(currentSessionIdRef.current!, cols, rows, item.repoId, { ...options, machineId: item.machineId });
      },
      apply: setInband,
      received: () => receivedRef.current,
    });
  }

  const writeSessionMeta = useRef<((session: string, patch: { agentTitle?: string; cwd?: string }) => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let retryAfterAdmission = false;
    let admissionRevision = 0;
    let attemptedAdmissionRevision = 0;
    let desiredSessionId = item.ptySessionId ?? null;
    let attachGeneration = 0;
    // One in-flight catalog write and one latest patch, owned by this mount
    // and live session. Metadata failure must never interrupt terminal I/O.
    let metadataRevision = 0;
    let metadataWriting = false;
    let metadataWarned = false;
    let pendingMetadata: { session: string; patch: { agentTitle?: string; cwd?: string } } | null = null;
    const flushMetadata = async (): Promise<void> => {
      if (metadataWriting) return;
      metadataWriting = true;
      try {
        while (pendingMetadata && !disposed) {
          const next = pendingMetadata;
          pendingMetadata = null;
          if (next.session !== currentSessionIdRef.current) continue;
          try { await services.catalog.updateItem(item.machineId, item.id, next.patch); }
          catch {
            if (!disposed && !metadataWarned) {
              metadataWarned = true;
              console.warn("[terminal-item] metadata update unavailable");
            }
          }
        }
      } finally { metadataWriting = false; }
    };
    writeSessionMeta.current = (session, patch) => {
      if (disposed || session !== currentSessionIdRef.current) return;
      metadataRevision++;
      pendingMetadata = { session, patch: { ...(pendingMetadata?.session === session ? pendingMetadata.patch : {}), ...patch } };
      void flushMetadata();
    };

    // Ports renderer.js's onTerminalSessionCreated + syncTerminalTileMeta:
    // once a session exists — freshly created OR successfully reconnected
    // — look up its own pty meta via discover() and fold the (possibly
    // host-corrected) cwd into the item. `agentSessionId` is deliberately
    // not synced here: cubed's discovery sweep owns that field, and a
    // second, per-client writer would race its corrections — see
    // computeMetaSyncPatch's own doc comment.
    const syncSessionMeta = (sessionIdToSync: string): void => {
      const revision = metadataRevision;
      services.pty
        .discover()
        .then((entries) => {
          if (disposed || revision !== metadataRevision || sessionIdToSync !== currentSessionIdRef.current) return;
          const found = entries.find((entry) => entry.sessionId === sessionIdToSync);
          const patch = computeMetaSyncPatch(found?.meta);
          if (Object.keys(patch).length > 0) writeSessionMeta.current?.(sessionIdToSync, patch);
        })
        .catch(() => {
          if (!disposed && !metadataWarned) {
            metadataWarned = true;
            console.warn("[terminal-item] metadata update unavailable");
          }
        });
    };

    // Clears the heal's timer/subscription — called once the heal fires,
    // its window elapses untouched, or this component unmounts. Idempotent,
    // and safe to call whether or not anything was ever armed. Unlike
    // before Task 10, this never touches the item: `resumeHealArmed` is
    // gone (see this file's own module doc comment for why).
    const disarmHeal = (): void => {
      if (healArmedAt.current === null) return;
      healArmedAt.current = null;
      if (healTimer.current !== null) {
        clearTimeout(healTimer.current);
        healTimer.current = null;
      }
      healOffExit.current?.();
      healOffExit.current = null;
    };

    // A thin adapter: gathers the facts (see `decideHeal`'s own doc comment
    // in terminal-item-logic.ts for what each one means and why) and
    // switches on the answer. `selfInitiated` reads live-status.ts's
    // ephemeral `closing` flag — set by ReposSidebar.tsx's close flow
    // before it calls `services.catalog.removeItem` — which is how a
    // self-initiated exit is told apart from the session dying on its own.
    const onHealExit = (
      resumedSessionId: string,
      healTarget: string | undefined,
      healCwd: string | undefined,
    ): boolean => {
      const armedAt = healArmedAt.current;
      disarmHeal();
      if (armedAt === null) return false;
      const heal = decideHeal({
        resumed: true,
        msSinceCreate: Date.now() - armedAt,
        windowMs: RESUME_HEAL_WINDOW_MS,
        healUsed: healUsed.current,
        selfInitiated: getLiveState(item.id).closing,
      });
      if (!heal) return false;
      healUsed.current = true;
      // This is still a replacement: protect the tile from the rail's
      // exit sweep until the fresh session is bound, then forget the old
      // record through createFreshSession's normal handoff.
      createFreshSession(healTarget, healCwd, undefined, false, resumedSessionId);
      return true;
    };

    // Arms the fast-exit heal once a create response's own `resumed` echo
    // confirms a resume actually happened (never the request — see
    // PtySession.resumed). `healTarget`/`healCwd` are the values the resume
    // itself was attempted with, reused verbatim for the respawn so it
    // doesn't fall back to this item's original (possibly stale) props.
    const armHeal = (
      resumedSessionId: string,
      healTarget: string | undefined,
      healCwd: string | undefined,
      createdAt = Date.now(),
    ): void => {
      disarmHeal();
      const remaining = RESUME_HEAL_WINDOW_MS - (Date.now() - createdAt);
      if (remaining <= 0) return;
      healArmedAt.current = createdAt;
      healOffExit.current = services.pty.onAnyExit(({ sessionId: exitedId }) => {
        if (exitedId === resumedSessionId) onHealExit(resumedSessionId, healTarget, healCwd);
      });
      healTimer.current = setTimeout(disarmHeal, remaining);
    };

    const createFreshSession = (
      nextTarget: string | undefined,
      nextCwd: string | undefined,
      agentSessionId: string | undefined,
      resume: boolean,
      // The id this respawn replaces, if any — forgotten once the new id
      // is known (see the `.then()` below), since the client only holds
      // both ids at that moment and nothing can name the old one after.
      supersededSessionId: string | undefined,
      // Whether this spawn is a RECOVERY (a session that died is being
      // replaced) rather than a heal or a first start. Passed explicitly
      // rather than inferred from `supersededSessionId`, which is absent in
      // one of recoverDeadSession's three entry paths — the item that
      // mounts with no session named at all. It is the only thing
      // `terminal_recovery` is reported for, and this is the single point
      // where that attempt's two outcomes are already distinguished.
      isRecovery = false,
    ): void => {
      desiredSessionId = null;
      attachGeneration++;
      const recoveryStartedAt = isRecovery ? Date.now() : 0;
      attemptedAdmissionRevision = admissionRevision;
      retryAfterAdmission = false;
      // The ladder (if any) was walking the OLD session back; a fresh
      // spawn means a new session with no held window of its own yet
      // (reattachExisting's own start() call arms the next one). Without
      // this, a step already in flight — or a later gesture reusing the
      // dead session's stale state — could apply a window from a session
      // that no longer exists over whatever comes next.
      backfill.current?.invalidate();
      // Only a replacement is flagged: a brand-new item has no session for
      // the rail's sweep to have seen exit, so there is nothing to protect
      // it from. Cleared in both settlements below — a create that never
      // settles would otherwise pin the item unsweepable forever.
      if (supersededSessionId !== undefined) setRecovering(item.id, true);
      const est = estimateTermSize();
      const pending = services.pty
        .create({
          cwd: nextCwd,
          cols: est.cols,
          rows: est.rows,
          target: nextTarget,
          agentSessionId,
          repoId: item.repoId,
          catalogItemId: item.id,
          resume,
          deferAttach: true,
        })
        .then(async (result) => {
          const recovered: RecoveryResult = {
            sessionId: result.sessionId,
            resumed: result.resumed === true,
            target: nextTarget,
            cwd: nextCwd,
            createdAt: Date.now(),
          };
          desiredSessionId = result.sessionId;
          retryAfterAdmission = false;
          setEndedMessage(null);
          setExitedInfo(null);
          setScrollback(null);
          setSessionId(null);
          // Only the response's own `resumed` echo can say a resume
          // actually happened — a target with no resume support spawns
          // fresh regardless of what was requested (see PtySession.resumed).
          if (result.resumed && mountedRef.current) {
            armHeal(result.sessionId, nextTarget, nextCwd, recovered.createdAt);
          }
          // The id this respawn replaces — see forgetTargetForRespawn's own
          // doc comment for why this must use the captured
          // supersededSessionId, never a live read of the item's
          // ptySessionId (which the update below is about to move on from).
          const forgetTarget = forgetTargetForRespawn(supersededSessionId, result.sessionId);
          if (forgetTarget !== undefined) {
            void services.pty.forgetRecord(forgetTarget, item.repoId);
          }
          // Reattaches this SAME item to its new session — a respawn never
          // mints a new item id (that's `createTerminalItem`'s job, for a
          // genuinely new terminal). No agentSessionId clear here: unlike
          // before Task 10, the item's agentSessionId is authoritative, and
          // resumeTargetFor only ever resumes the id the item already has —
          // there is no stale predecessor id left for a clear to protect
          // against (see resumeTargetFor's own doc comment).
          const patch: { ptySessionId: string; cwd?: string } = { ptySessionId: result.sessionId };
          const cwd = result.cwdHostPath || nextCwd;
          if (cwd !== undefined) patch.cwd = cwd;
          await services.catalog.updateItem(item.machineId, item.id, patch);
          // A fast exit can start a replacement while this older catalog
          // write is in flight. Only the current attempt owns recovery UI.
          if (pendingRecoveries.get(item.id) !== pending) return recovered;
          setRecovering(item.id, false);
          // Creation can finish after the process printed its first prompt.
          // Save its identity before attaching so a failed read retries this
          // same process, and replay before mounting its live terminal view.
          if (disposed) {
            // StrictMode can replace the effect before its scheduled spawn
            // begins. Hand its result to the active effect's attach owner.
            if (mountedRef.current) followSessionRef.current?.(result.sessionId, recovered);
          } else {
            await reattachExisting(result.sessionId, { sinceSeq: 0, maxBytes: COLD_TAIL_BYTES }, undefined, recovered);
          }
          if (isRecovery) {
            captureEvent("terminal_recovery", {
              outcome: "recovered",
              ms: Date.now() - recoveryStartedAt,
            });
          }
          syncSessionMeta(result.sessionId);
          return recovered;
        });
      pendingRecoveries.set(item.id, pending);
      void pending.then(
        () => {
          if (pendingRecoveries.get(item.id) === pending) pendingRecoveries.delete(item.id);
        },
        (err: unknown) => {
          if (pendingRecoveries.get(item.id) !== pending) return;
          pendingRecoveries.delete(item.id);
          setRecovering(item.id, false);
          retryAfterAdmission = true;
          if (isRecovery) {
            captureEvent("terminal_recovery", {
              outcome: "dead",
              ms: Date.now() - recoveryStartedAt,
            });
          }
          setEndedMessage(sessionEndedMessage(err));
          retryFailedAttach();
        },
      );
    };

    /**
     * Replaces a session that is definitively gone, resuming the original
     * conversation when the item has one (`resumeTargetFor`) — passing its
     * `agentSessionId` back into `pty:create` is what makes a dead claude
     * item RESUME its transcript instead of starting fresh.
     *
     * Reached three ways, and all must behave identically: a mount-time
     * reconnect that found the session already dead, a live
     * `pty:session-lost` for a ptyd that died and came back without it, and
     * an exited recovery item that mounts with no session named at all.
     * Before the second
     * existed, a session lost mid-run left the tile rendering as live
     * forever — the frozen terminal a killed ptyd used to leave behind. The
     * third used to spawn a plain fresh session, ignoring the conversation
     * sitting on the item: cubed's start-up sweep clears `ptySessionId`
     * on everything a ptyd restart orphaned, so every agent tile whose
     * machine restarted while the app was closed came back on a NEW
     * conversation with its transcript stranded on disk.
     *
     * `deadSessionId` is the id being replaced, and is absent in that third
     * case — nothing named a session, so there is no record to forget.
     *
     * Unlike before Task 10, this is synchronous: `agentSessionId` is
     * authoritative on the item itself now, so there is no `readMeta` round
     * trip to await, and therefore no lookup-failure branch to keep the
     * dead session in place for — see resumeTargetFor's own doc comment.
     */
    const recoverDeadSession = (deadSessionId?: string): void => {
      // An item that reports an exit code is finished: its session ran and
      // stopped, and the rail removes the row for it (state/catalog.ts's
      // sweepExitedOnAttach). Reviving it here would race that removal and
      // leave the replacement running with no item — the same orphan a
      // ptyd restart used to produce, from the other direction. An item
      // with no exit code never reported an exit at all: nothing removes
      // it, and bringing it back is the whole point.
      //
      // Read from the catalog rather than this closure's mount-time `item`,
      // which is frozen at the value the tile started with — same reason
      // the session-lost handler below reads it there.
      const current = catalogStore.getSnapshot().items.find((i) => i.id === item.id) ?? item;
      if (current.exitCode !== undefined) {
        // A recovery that is refused before it is attempted, not a
        // successful one: the session ran, stopped, and stays stopped.
        captureEvent("terminal_recovery", { outcome: "dead", ms: 0 });
        setEndedMessage("Session ended");
        return;
      }
      // A new recovery earns a fresh retry — see `healUsed`'s own comment.
      healUsed.current = false;
      setRestored(false);
      const decision = resumeTargetFor(item);
      createFreshSession(
        item.target,
        item.cwd,
        decision.kind === "resume" ? decision.agentSessionId : undefined,
        decision.kind === "resume",
        deadSessionId,
        true,
      );
    };

    /**
     * Attaches to a session this item already names — reconnect-only,
     * never creates. `options` carries the cursor (and, on a cold tail,
     * the byte cap) to ask for: start() passes `{ sinceSeq: 0, maxBytes:
     * COLD_TAIL_BYTES }` on a first attach or the held cursor on a
     * same-instance re-attach; the remount branch below passes its
     * stash's cursor — the reply is then just the delta, composed onto
     * the stashed snapshot — or a cold tail when no snapshot survived.
     */
    const reattachExisting = async (
      existingSessionId: string,
      options: PtyReconnectOptions,
      stash?: SessionSnapshot,
      recovery?: RecoveryResult,
    ): Promise<void> => {
      if (disposed || existingSessionId !== desiredSessionId) return;
      attemptedAdmissionRevision = admissionRevision;
      retryAfterAdmission = false;
      const generation = ++attachGeneration;
      const isCurrent = () => !disposed && generation === attachGeneration && existingSessionId === desiredSessionId;
      // Which daemon this session lives on is a fact carried by the item
      // itself, so remote-vs-local needs no lookup and no await: an item
      // in a cloud machine's catalog has that machine's id, whether it
      // belongs to a cloud repo or to the machine's own repo-less
      // terminals (the gh sign-in flow). Both locations reconnect
      // directly; best-effort discovery cannot prove a session is dead.
      const remote = item.machineId !== LOCAL_MACHINE_ID;
      const { cols, rows } = estimateTermSize();
      try {
        const result = await reconnectWithRetry(
          services.pty,
          existingSessionId,
          cols,
          rows,
          item.repoId,
          remote,
          {},
          { ...options, machineId: item.machineId },
        );
        // An authoritative replacement can arrive while the old attach is
        // in flight. Neither its output nor its dead-session response may
        // overwrite or respawn the replacement.
        if (!isCurrent()) return;
        if (result.exited && recovery?.resumed
          && onHealExit(existingSessionId, recovery.target, recovery.cwd)) return;
        // All state updates land in the same microtask, so React batches
        // them into one re-render — TerminalTab doesn't even mount (the
        // sessionId state starts null on every mount) until scrollback is
        // already set alongside it, closing the race where TerminalTab's
        // [sessionId]-keyed mount effect could run before scrollback
        // arrived.
        // ReconnectResult's own `seq` is optional only so restore-session
        // test doubles don't all need one — every real response carries
        // it (see PtyReconnectResult); ?? 0 only matters for a fake.
        const resultSeq = result.seq ?? 0;
        heldWindowRef.current = windowFromReply({ ...result, seq: resultSeq });
        // A remount composes its stashed snapshot with the delta (and
        // always resets — its xterm is empty); a first mount applies the
        // response as-is, where an empty reply must stay a no-op.
        const patch =
          stash !== undefined
            ? remountScrollback(stash, { ...result, seq: resultSeq })
            : attachScrollback({ ...result, seq: resultSeq });
        // A bounded raw tail cannot reconstruct a TUI that emits diffs.
        // Ask the live process to repaint after parsing; complete replays,
        // local snapshots and exited sessions need no size disturbance.
        const redraw = result.reset === true && result.scrollbackStart !== 0 && !result.exited;
        if (patch) setScrollback(redraw ? { ...patch, redraw: true } : patch);
        lastSeqBySession.set(existingSessionId, resultSeq);
        setInitialSeq(resultSeq);
        // Seeded from the attach reply's own seq — not just left for the
        // first onSeqAdvance frame — so a scroll-up gesture that fires
        // before any live output arrives still sizes its request from the
        // right cursor instead of 0.
        receivedRef.current = resultSeq;
        currentSessionIdRef.current = existingSessionId;
        retryAfterAdmission = false;
        setEndedMessage(null);
        setExitedInfo(null);
        setSessionId(existingSessionId);
        backfill.current?.start(heldWindowRef.current);
        // A session ptyd still retains past its exit (Task 9) resolves
        // here instead of throwing — TerminalTab still mounts and renders
        // its final scrollback above; this only adds the "closed"
        // indicator alongside it (see the render below).
        if (result.exited) {
          setExitedInfo({ exitCode: result.exitCode ?? 0 });
        }
        // Unlike createFreshSession, a reconnect never re-creates the
        // session, so createFreshSession's own post-reconnect sync never
        // runs for it — sync explicitly here instead. The endpoint is
        // definitely connected by now (reconnectWithRetry just talked to
        // it), so discover() will list it.
        syncSessionMeta(existingSessionId);
      } catch (err) {
        if (!isCurrent()) return;
        if (!isDeadSessionError(err)) {
          // A transport failure that outlasted the retry budget (machine
          // unreachable, sprite never finished waking). The session may
          // still be alive behind it — do NOT fall back to a fresh
          // create: that spawns an orphan server-side and, worse, on
          // success would overwrite ptySessionId and permanently orphan
          // the real session. Render the failure and keep the item's
          // ptySessionId so the next app launch can reattach.
          console.error("[terminal-item] reconnect gave up (session kept):", err);
          retryAfterAdmission = true;
          setEndedMessage("Connection interrupted. Waiting to reconnect…");
          retryFailedAttach();
          return;
        }
        recoverDeadSession(existingSessionId);
      }
    };

    async function start(): Promise<void> {
      const existingSessionId = item.ptySessionId;
      if (existingSessionId) {
        const held = lastSeqBySession.get(existingSessionId);
        // A first attach (no cursor) is a cold tail; a same-instance
        // re-attach keeps its cursor delta, which is small by construction.
        const options: PtyReconnectOptions =
          held === undefined ? { sinceSeq: 0, maxBytes: COLD_TAIL_BYTES } : { sinceSeq: sinceSeqFor(held) };
        await reattachExisting(existingSessionId, options);
        return;
      }
      recoverDeadSession();
    }

    // A session this tile owns that the daemon no longer has. The id is
    // checked against the CATALOG STORE's current ptySessionId, not this
    // closure's mount-time `item`, which is frozen at the value the tile
    // started with and goes stale the moment anything respawns. An item
    // the user is closing is exempt for the same reason the heal exempts
    // one: its session is supposed to be going away.
    const offSessionLost = services.pty.onSessionLost(({ sessionId: lostId }) => {
      if (getLiveState(item.id).closing) return;
      const current = catalogStore.getSnapshot().items.find((i) => i.id === item.id);
      if (!current || current.ptySessionId !== lostId) return;
      // The session this ladder was walking back is gone — invalidate here
      // rather than relying solely on createFreshSession's own invalidate,
      // since recoverDeadSession can also settle into "Session ended"
      // without ever respawning (an exited item), which must still drop a
      // ladder that can no longer reach a live pty.
      backfill.current?.invalidate();
      attachScheduler.cancel(item.id);
      recoverDeadSession(lostId);
    });

    // The window a gap re-attach delivered — the router broadcasts it
    // after the output itself, so a held window here just widens to what
    // actually arrived rather than driving the delivery.
    //
    // Only a RESET delivery replaces the window: that reply cleared the
    // screen in band, so `[start, end]` really is everything the tile now
    // holds. A non-reset delta merely extends what was already there, and
    // adopting its `[cursor, seq]` wholesale would throw away the history
    // above it — every socket blip would shrink the window and the next
    // scroll-up would refetch history the user could already see. Widen
    // instead: keep the older start, take the newer end.
    const offWindow = services.pty.onWindow(({ sessionId: id, start, end, reset }) => {
      if (id !== currentSessionIdRef.current) return;
      const held = heldWindowRef.current;
      heldWindowRef.current =
        reset || !held ? { start, end, exact: true } : { start: Math.min(held.start, start), end, exact: true };
      backfill.current?.start(heldWindowRef.current);
    });

    // Session creation is once-per-item (the scheduler's started guard);
    // the session-lost subscription above is once-per-MOUNT, so a remount
    // — which skips creation — still gets its recovery wired. A fresh
    // spawn goes through the scheduler too (as a `visible: true` request,
    // which runs at once and never queues) rather than calling `start()`
    // directly, precisely so `hasStarted` marks it started and this guard
    // covers creation, not just an attach to an existing session — a
    // `void start()` outside the scheduler would leave `hasStarted` false
    // forever and reopen the double-`pty.create` StrictMode used to hit.
    const stillValid = () => {
      if (getLiveState(item.id).recovering) return false;
      const current = catalogStore.getSnapshot().items.find((i) => i.id === item.id);
      return !!current && current.ptySessionId === item.ptySessionId;
    };
    const pendingRecovery = pendingRecoveries.get(item.id);
    let waitingForRecovery = pendingRecovery !== undefined;
    let followingSessionId: string | null = null;
    const followSession = (id: string, recovery?: RecoveryResult): void => {
      if (disposed || id === currentSessionIdRef.current || id === followingSessionId) return;
      followingSessionId = id;
      desiredSessionId = id;
      attachGeneration++;
      attachScheduler.requestNow({
        itemId: item.id,
        machineId: item.machineId,
        visible: true,
        run: () => reattachExisting(id, { sinceSeq: 0, maxBytes: COLD_TAIL_BYTES }, undefined, recovery),
      });
    };
    followSessionRef.current = (id, recovery) => {
      // A changed authoritative session supersedes a queued stale attach.
      // A recovery owned by another view supplies its own result below.
      if (!waitingForRecovery && id !== desiredSessionId) {
        if (recovery?.resumed) armHeal(id, recovery.target, recovery.cwd, recovery.createdAt);
        followSession(id, recovery);
      }
    };
    if (pendingRecovery) {
      void pendingRecovery.then(
        (recovery) => {
          waitingForRecovery = false;
          if (disposed) return;
          if (recovery.resumed) armHeal(recovery.sessionId, recovery.target, recovery.cwd, recovery.createdAt);
          followSession(recovery.sessionId, recovery);
        },
        (err: unknown) => {
          waitingForRecovery = false;
          if (!disposed) {
            retryAfterAdmission = true;
            setEndedMessage(sessionEndedMessage(err));
            retryFailedAttach();
          }
        },
      );
    } else if (!attachScheduler.hasStarted(item.id)) {
      if (item.ptySessionId) {
        // An attach against an existing session: visible ones now,
        // hidden ones when the machine's queue reaches them (spec §2).
        attachScheduler.request({
          itemId: item.id,
          machineId: item.machineId,
          visible,
          run: start,
          stillValid,
        });
      } else {
        // A fresh spawn is never queued (visible: true runs at once) —
        // the user just created it — but still goes through `request`
        // rather than calling `start()` directly, so the scheduler marks
        // it started and a StrictMode double-mount's second run is a
        // no-op instead of a second `pty.create`.
        attachScheduler.request({
          itemId: item.id,
          machineId: item.machineId,
          visible: true,
          run: start,
        });
      }
    } else if (item.ptySessionId && !getLiveState(item.id).recovering) {
      // A genuine remount (view switch, error-boundary reload) whose xterm
      // is new and empty. With a stashed snapshot the screen is restored
      // locally and only the delta past its cursor is fetched; WITHOUT one
      // (the previous instance unmounted mid-parse) this is a cold attach
      // and asks for a tail, not the whole retained ring.
      const stash = sessionSnapshots.get(item.ptySessionId);
      const options: PtyReconnectOptions = stash
        ? { sinceSeq: stash.seq }
        : { sinceSeq: 0, maxBytes: COLD_TAIL_BYTES };
      // requestNow, not request: `hasStarted` is true for a remounted
      // item, and the duplicate guard would otherwise drop this.
      attachScheduler.requestNow({
        itemId: item.id,
        machineId: item.machineId,
        visible: true,
        run: () => reattachExisting(item.ptySessionId!, options, stash),
      });
    }
    // A machine can finish its confirmed restart after this tile's retry
    // budget expired. Admission is the signal to retry, without replacing
    // a session that may still be alive or requiring the tile to remount.
    function retryFailedAttach(): void {
      if (!retryAfterAdmission || admissionRevision <= attemptedAdmissionRevision || disposed) return;
      if (getLiveState(item.id).closing || getLiveState(item.id).recovering) return;
      const current = catalogStore.getSnapshot().items.find(candidate => candidate.id === item.id);
      if (!current || current.exitCode !== undefined) return;
      retryAfterAdmission = false;
      if (current.ptySessionId) {
        desiredSessionId = current.ptySessionId;
        void reattachExisting(current.ptySessionId, { sinceSeq: 0, maxBytes: COLD_TAIL_BYTES });
      } else {
        recoverDeadSession();
      }
    }
    const offStatus = services.repos.onStatus(event => {
      if (event.status !== "open" || event.repoId !== item.machineId) return;
      admissionRevision++;
      retryFailedAttach();
    });

    // Mount-only by design ([] deps): item.id/ptySessionId/cwd/target/
    // repoId are all read once here, matching the old guest's one-shot
    // URL-param read at page load. `visible` here is the prop's mount-time
    // value — the [visible] effect below handles it changing later.
    //
    // The cleanup below always cancels this item's scheduler entry (a
    // no-op once it has started) and only ever has heal state to tear
    // down if this mount actually armed one; disarmHeal() is a no-op
    // otherwise.
    return () => {
      disposed = true;
      pendingMetadata = null;
      writeSessionMeta.current = null;
      mountedRef.current = false;
      followSessionRef.current = null;
      offSessionLost();
      offWindow();
      offStatus();
      attachScheduler.cancel(item.id);
      disarmHeal();
    };
  }, []);

  useEffect(() => {
    if (item.ptySessionId) followSessionRef.current?.(item.ptySessionId);
  }, [item.ptySessionId]);

  // Promotes a queued (hidden) attach once this tile becomes visible —
  // the mount effect above only reads `visible` at mount time.
  useEffect(() => {
    if (visible) attachScheduler.setVisible(item.id, true);
  }, [visible, item.id]);

  if (endedMessage) {
    return <div className="item-terminal-exited">{endedMessage}</div>;
  }

  if (!sessionId) {
    return <TerminalLoading />;
  }

  return (
    <div className="item-terminal-live">
      {/* First in flow, not last and absolutely positioned: this is a row
          above the terminal, so it reads (and is read out) before the
          output it is asking about instead of covering that output's
          first line. The other blocks below stay overlays. */}
      {openUrlRequest !== null && (
        <div className="item-terminal-open-url-banner" role="alert">
          <span className="item-terminal-open-url-text" title={openUrlRequest}>
            This session wants to open <strong>{hostOf(openUrlRequest)}</strong>
          </span>
          <button
            type="button"
            className="item-terminal-open-url-open"
            onClick={() => {
              services.desktop.openExternal(openUrlRequest);
              setOpenUrlRequest(null);
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="item-terminal-open-url-dismiss"
            onClick={() => setOpenUrlRequest(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      <Suspense fallback={<TerminalLoading />}>
        <LazyTerminalTab
          host={terminalHost}
          sessionId={sessionId}
          visible={visible}
          focused={focused}
          theme={theme}
          restored={restored}
          scrollbackData={scrollback}
          initialSeq={initialSeq}
          onSeqAdvance={(seq) => {
            lastSeqBySession.set(sessionId, seq);
            receivedRef.current = seq;
          }}
          inbandReset={inband}
          onHistoryTop={() => backfill.current?.onHistoryTop()}
          onInbandApplied={(id) => backfill.current?.onApplied(id)}
          // The serialized screen, paired with the parsed-bytes cursor it
          // is complete up to (TerminalTab's, not lastSeqBySession's —
          // the held cursor counts received bytes, which can be ahead of
          // what the snapshot shows).
          onSnapshot={(snapshot, seq) => sessionSnapshots.set(sessionId, { snapshot, seq })}
          acceptTitles={item.target !== undefined && AGENT_TARGETS.has(item.target)}
          onAgentTitle={(title) => writeSessionMeta.current?.(sessionId, { agentTitle: title })}
          onCwdChanged={(cwd) => writeSessionMeta.current?.(sessionId, { cwd })}
          onUserInput={(data) => {
            const kind = commandDetector.current(data);
            if (kind) captureEvent("terminal_command_sent", terminalCommandProps(item, kind));
          }}
          // Clicked file paths open as workspace items (issue #25).
          // Resolution happens here, not in the component: this is the
          // layer that knows the tile's machine, cwd space and repos.
          // Absolute paths are allowed on every machine — a cloud
          // machine-native path rebases onto the machine's repo roots
          // (repoRootsForMachine), and one no root owns never links at
          // all: canOpenPath filters it out at detection.
          allowAbsolutePaths={true}
          canOpenPath={(raw) => resolveTerminalItemPath(raw, item) !== null}
          onOpenPath={(raw) => {
            const resolved = resolveTerminalItemPath(raw, item);
            if (resolved === null) return;
            const repo = repoForAbsPath(resolved);
            openFile(resolved, repo !== null ? { repoId: repo.id } : {});
          }}
          onOpenUrlRequest={setOpenUrlRequest}
          // One fact, two behaviours: a pty on another machine can see
          // neither this clipboard nor this filesystem, so a pasted
          // image and a dropped file both have to travel (issues #13,
          // #14). A local pty needs neither — it opens the path the
          // drop already carries.
          remote={isRemote}
          onTransferStatus={setTransfer}
        />
      </Suspense>
      {exitedInfo && (
        <div className="item-terminal-ended-banner">
          {exitedMessage(exitedInfo.exitCode)}
        </div>
      )}
      {dropHint !== null && (
        // aria-hidden and pointer-events:none, both load-bearing:
        // TerminalTab's own container handler is what reads the drop, so
        // an overlay that intercepted the event would break the gesture
        // it is advertising.
        <div className="item-terminal-drop-hint" aria-hidden="true">
          <span className="item-terminal-drop-hint-label">{dropHint}</span>
        </div>
      )}
      {transfer !== null && (
        // Centered over the terminal and dimming it, not tucked along an
        // edge: an earlier top banner was routinely missed entirely.
        // Sending clears itself; errors wait to be dismissed, because
        // they name files the user has to do something about.
        <div className="item-terminal-transfer-scrim">
          <div className="item-terminal-transfer-card" role="status">
            {transfer.kind === "sending" ? (
              <>
                <span className="item-terminal-transfer-spinner" aria-hidden="true" />
                <span className="item-terminal-transfer-name" title={transfer.name}>
                  Sending <strong>{transfer.name}</strong>
                </span>
                {/* Nothing observes progress inside one file's send —
                    each is a single stash call — so the honest unit is
                    files, and only when there is more than one. */}
                {transfer.total > 1 && (
                  <span className="item-terminal-transfer-count">
                    {transfer.index} of {transfer.total}
                  </span>
                )}
              </>
            ) : (
              <>
                {transfer.messages.map((message) => (
                  <span className="item-terminal-transfer-error" key={message}>
                    {message}
                  </span>
                ))}
                <button
                  type="button"
                  className="item-terminal-transfer-dismiss"
                  onClick={() => setTransfer(null)}
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TerminalItem;
