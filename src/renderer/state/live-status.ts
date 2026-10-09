/**
 * Ephemeral per-item live state this client observes locally: a terminal's
 * current non-shell foreground command, the last file an attached agent
 * session touched, and whether this client has a close in flight for it.
 * None of this belongs in the catalog — the foreground command changes on
 * every keystroke (far too noisy to broadcast), and "closing" is purely
 * this client's own request state, not a fact about the machine — so it's
 * tracked here instead, keyed by item id, and merged into a sidebar row via
 * build-item-entry.ts's `LiveStatus` (which adds `hidden`, a third kind of
 * fact — this client's arrangement — that this store doesn't hold either).
 *
 * Ports the shell's own wiring for the same events (renderer.js:1262-1288's
 * onPtyExit/onPtyStatusChanged, and recordFileTouched at
 * renderer.js:526-536), now writing to this store instead of mutating a
 * tile directly, and looking items up against the catalog store (identity)
 * instead of the workspace store (arrangement only, no items list anymore).
 *
 * Unlike the pre-Task-10 version, `onAnyExit` here never removes anything
 * and never forgets a session's durable record: the catalog's own
 * `exitedAt` (arrives by broadcast, stamped by cubed) is what makes a
 * row idle now, and removal is a client-initiated action
 * (ReposSidebar.tsx's close flow, via `services.catalog.removeItem`),
 * not an exit side effect. This also means there is no more "heal-armed"
 * item to protect from an unconditional removal here — see
 * TerminalItem.tsx's own doc comments for where that machinery went.
 *
 * Pure — no DOM/React beyond the `useSyncExternalStore` hook — so it's
 * testable directly against the catalog store and a fake services
 * instance; App.tsx's useEffect only calls start()/dispose().
 */



import { useSyncExternalStore } from "react";
import { normalizeCommandName } from "@port/shared/path-utils";
import { services } from "../services";
import { catalogStore } from "./catalog";

export interface LiveState {
  /** The terminal's current non-shell foreground command (e.g. "claude"), or null. */
  liveCommand: string | null;
  /** The last file an attached agent session touched, or null. */
  touchedFile: string | null;
  /** A close is in flight for this item: the kill was sent, not yet confirmed. */
  closing: boolean;
  /**
   * This client's tile is replacing the item's session right now: a respawn
   * has been requested and its new id has not landed yet. Read by the rail's
   * exit sweep, which must not remove an item that is coming back.
   */
  recovering: boolean;
}

const EMPTY_STATE: LiveState = {
  liveCommand: null,
  touchedFile: null,
  closing: false,
  recovering: false,
};

// Interactive shells the daemon's foreground poll can report while a
// terminal item sits idle at its prompt — excluded so a bare shell doesn't
// masquerade as "something running" (ported from tile-renderer.js's
// SHELL_COMMAND_NAMES).
const SHELL_COMMAND_NAMES = new Set([
  "zsh",
  "bash",
  "sh",
  "dash",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "pwsh",
  "powershell",
  "cmd",
]);

/**
 * Ports tile-renderer.js's `liveForegroundDetail`. Moved here from
 * build-item-entry.ts along with the raw event handling: `LiveState`'s
 * `liveCommand` is the already-filtered value (unlike the old
 * `WorkspaceItem.liveForeground`, which stored the raw foreground and left
 * filtering to the entry builder), so the filtering has to happen at the
 * point this store is written, not at the point it's read.
 */
function liveForegroundDetail(foreground: string): string | null {
  const base = normalizeCommandName(foreground);
  if (!base) return null;
  const normalized = base.replace(/^-/, "");
  if (SHELL_COMMAND_NAMES.has(normalized)) return null;
  return foreground.trim();
}

let states: Record<string, LiveState> = {};
const subscribers = new Set<() => void>();

function notify(): void {
  for (const callback of subscribers) callback();
}

function commit(id: string, next: LiveState): void {
  const current = states[id] ?? EMPTY_STATE;
  if (
    current.liveCommand === next.liveCommand
    && current.touchedFile === next.touchedFile
    && current.closing === next.closing
    && current.recovering === next.recovering
  ) {
    return;
  }
  states = { ...states, [id]: next };
  notify();
}

/** The current live state for `id`, or the all-empty default if nothing has been recorded yet. */
export function getLiveState(id: string): LiveState {
  return states[id] ?? EMPTY_STATE;
}

/**
 * Flags an item's close as in flight (or clears it) — ReposSidebar.tsx's
 * close flow calls this before/after `services.catalog.removeItem`, so a
 * self-initiated exit (terminal-item-logic.ts's `decideHeal`,
 * TerminalItem.tsx's `onSessionLost` handler) can tell it apart from the
 * session dying on its own.
 */
export function setClosing(id: string, closing: boolean): void {
  const current = getLiveState(id);
  if (current.closing === closing) return;
  commit(id, { ...current, closing });
}

/**
 * Flags an item as mid-respawn (or clears it) — TerminalItem.tsx calls this
 * around every `pty:create` that replaces a session the item already had.
 *
 * The rail's exit sweep is the only reader: an exit that a tile is already
 * answering with a replacement must not also be read as "nobody wants this
 * item any more". Purely this client's own intent, like `closing`, which is
 * why it lives here and not on the item.
 */
export function setRecovering(id: string, recovering: boolean): void {
  const current = getLiveState(id);
  if (current.recovering === recovering) return;
  commit(id, { ...current, recovering });
}

export const liveStatusStore = {
  subscribe(callback: () => void): () => void {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },
  getSnapshot(): Record<string, LiveState> {
    return states;
  },
};

/** Subscribes a React component to the live-status store. */
export function useLiveStatus(): Record<string, LiveState> {
  return useSyncExternalStore(liveStatusStore.subscribe, liveStatusStore.getSnapshot);
}

/** Test-only: clears every item's ephemeral state back to empty. */
export function resetLiveStatus(): void {
  states = {};
  notify();
}

/**
 * Subscribes to `services.pty.onStatusChanged`, `services.desktop.onAgentEvent`
 * (filtered to `"file-touched"` — the preload also fans in session-started/
 * session-ended, which this ignores, matching renderer.js's
 * recordFileTouched), and `services.pty.onAnyExit`. Items are looked up by
 * `ptySessionId`/`agentSessionId` against the catalog store's current
 * snapshot rather than mutating anything on the item itself — this is
 * purely local UI state. Returns a dispose function.
 */
export function startLiveStatus(): () => void {
  const offStatusChanged = services.pty.onStatusChanged(({ sessionId, foreground }) => {
    const item = catalogStore
      .getSnapshot()
      .items.find((i) => i.type === "term" && i.ptySessionId === sessionId);
    if (!item) return;
    commit(item.id, { ...getLiveState(item.id), liveCommand: liveForegroundDetail(foreground) });
  });

  const offAgentEvent = services.desktop.onAgentEvent((event) => {
    if (event.kind !== "file-touched" || !event.filePath) return;
    // Both session-bearing ranks: an `agent` item's conversation touches
    // files exactly like a `term` one's does, and its row shows the same
    // detail. Only this lookup widens — the two above key on
    // `ptySessionId`, and an agent item's session is an ACP pipe that
    // ptyd's pty events never name.
    const item = catalogStore
      .getSnapshot()
      .items.find(
        (i) =>
          (i.type === "term" || i.type === "agent") && i.agentSessionId === event.sessionId,
      );
    if (!item) return;
    commit(item.id, { ...getLiveState(item.id), touchedFile: event.filePath });
  });

  // The catalog's own `exitedAt` (arrives by broadcast) is what makes the
  // row idle now — this only clears the foreground command, so a dead
  // session's row doesn't keep showing e.g. "claude" as still running. It
  // must not remove anything or forget any record: those are
  // ReposSidebar.tsx's close flow now, not an exit side effect.
  const offAnyExit = services.pty.onAnyExit(({ sessionId }) => {
    const item = catalogStore
      .getSnapshot()
      .items.find((i) => i.type === "term" && i.ptySessionId === sessionId);
    if (!item) return;
    const current = getLiveState(item.id);
    if (current.liveCommand === null) return;
    commit(item.id, { ...current, liveCommand: null });
  });

  return () => {
    offStatusChanged();
    offAgentEvent();
    offAnyExit();
  };
}
