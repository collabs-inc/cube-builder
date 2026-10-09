import { openSidebarItem } from "../state/sidebar-focus";
import { useHiddenArtifacts } from "../state/hidden-artifacts";
import { reorderCatalog } from "./reorder-catalog";
import { AttentionDot } from "../attention/AttentionDot";
import { useAttentionMap } from "../attention/store";
// Ported from src/windows/repos/src/App.tsx (the old repos webview),
// with the transport swapped out: instead of an `onReposMessage`
// channel multiplexer relaying a diffed tile list from the shell, this
// reads the workspace/repos stores directly and re-derives its rows on
// every render. There's no init gate and no add/update/remove protocol —
// it's a sidebar list, not a canvas mirror.
import { Terminal } from '@phosphor-icons/react/dist/csr/Terminal';
import { FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { Sparkle } from '@phosphor-icons/react/dist/csr/Sparkle';
import { TrashSimple } from '@phosphor-icons/react/dist/csr/TrashSimple';
import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { LOCAL_MACHINE_ID, type ContextMenuItem } from "@port/shared/types";
import type { WorktreeOrigin } from "@port/shared/catalog";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./ReposSidebar.css";
import "./MiniRepoTree.css";
import { MiniRepoRow } from "./MiniRepoRow";
import { MiniFolderRow } from "./MiniFolderRow";
import { listedInMini, miniRepoSections, worktreeViewSection, type MiniRepoSection } from "./mini-sections";
import { toggleWorktreeView, useWorktreeView } from "../state/sidebar-worktree-view";
import { workingCheckoutId, worktreeLabel, type WorktreeLabel } from "@port/shared/working-checkout";
import { SidebarSections } from "./SidebarSections";

import { HistoryArrows } from "./HistoryArrows";
import AddLocalRepoModal from "./AddLocalRepoModal";
import CreateRepoModal from "./CreateRepoModal";
import { chooseRepoAction as pickRepoAction } from "./choose-repo-action";
import { onAddRepoRequest } from "./add-repo-request";
import { useRowActions } from "./row-actions";
import { DisclosureButton, HiddenSummary, RowLead, disclosureRegionId, type RowDisclosure } from "./DisclosureRow";
import { UNSCOPED_KEY, checkoutKey, directoryKey, hiddenSummary, isHiddenBy, itemAncestorKeys, machineKey, miniAncestorKeys, repoKey, type DisclosureKey } from "./disclosure";
import { expandKeys, toggleCollapsed, useDisclosure } from "../state/sidebar-disclosure";
import { onSidebarReveal } from "../state/sidebar-reveal";
import { sidebarTileRevealStore } from "../state/sidebar-tile-reveal";
import { DndContext, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableRow, type SortableBind } from "./SortableRow";
import { machineDocument } from "../state/catalog";
import { buildSiblingIndex, createDragController, itemRowScope, planMove, repoRowScope, scopeId, worktreeViewGroup, scopeMembers, scopedCollisionDetection, type RowScope } from "./sidebar-order";
import { buildItemListEntry, type ItemListEntry } from "./build-item-entry";
import { sidebarNavigationOrder } from "./machine-sites";
import { textPresentation } from "./text-presentation";
import { BranchPillIcon, CheckoutIcon, harnessOf, ItemIcon, itemIconClass, MachineIcon, RepoIcon } from "./row-icons";
import { groupEntries, repoSections, type CheckoutSection, type RepoSection, checkoutName, checkoutBranch, isDetached, repoDisplayOrder, resolveStatus, localSectionEmptyText, resolveLiveDetail, virtualRootFor, kindLabel, errorRowDetail, type DotStatus, type EntryGroup, type RepoInfo } from "./group-entries";
import { services } from "../services";

import { shouldHandleSidebarKey } from "./focus-guard";
import { useWorkspace, focusItem, showItem, openTreePane, registerTreePane, displayedItemIds, openCheckoutScreen, syncCheckoutScreens } from "../state/workspace";
import { requestItemFocus } from "../state/item-focus";
import { useCatalog } from "../state/catalog";
import { getLiveState, setClosing, useLiveStatus } from "../state/live-status";
import { acpConversationsEnabled } from "../feature-flags";
import { useRepos, setActive as setActiveRepo } from "../state/repos";

import { carriesFiles } from "@port/shared/file-drag";
import { dropContents } from "@builder/components/Terminal/file-drop";
import { dropHintText } from "../drag-drop";
import { isCloudPath } from "../items/cloud-placeholder";
import { useFileImport } from "./use-file-import";
import { TransferStrip } from "./TransferStrip";
import { unscopedDirectories } from "./unscoped-directories";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A stable empty-array identity for a `Map.get(...) ?? []` fallback: a
// fresh `[]` literal on every render would give useMemo/useEffect callers
// keyed on it (flatEntries, the document keydown subscription it feeds) a
// new dependency identity every render even when nothing changed — most
// visibly on a host with no local machine, where this is the permanent case.
const NO_ENTRIES: ItemListEntry[] = [];

const STATUS_LABELS: Record<DotStatus, string> = {
  open: "Connected",
  connecting: "Connecting…",
  closed: "Closed",
  error: "Error",
  unknown: "",
};


/** A mini repo as drawn: its flat list, or its worktree view's checkouts. */
interface MiniDisplay extends MiniRepoSection<ItemListEntry> {
  worktrees: RepoSection<ItemListEntry> | null;
}

interface RowMessage {
  text: string;
  isError: boolean;
}

/** What a row's detail span shows: short text inline, the full story (a
 * failure's git stderr) in the `title` attribute when there is more to tell
 * than fits — the same split `errorRowDetail` already uses for connection
 * errors, which is why a plain RowMessage is a RowDetail with no title. */
interface RowDetail extends RowMessage {
  title?: string;
}

/**
 * A checkout row's label lives in group-entries.ts now (`checkoutName` /
 * `checkoutBranch`), because it is no longer a worktree-only question: the
 * repo's own working copy is a checkout row too, and both ranks have to
 * derive their label the same way or they drift apart again.
 */

function creationDetail(worktreeOf: WorktreeOrigin | undefined): RowDetail | null {
  const creation = worktreeOf?.creation;
  if (!creation) return null;
  if (creation.state === "pending") return { text: "Creating…", isError: false };
  return {
    text: "Couldn't create",
    isError: true,
    ...(creation.error !== undefined ? { title: creation.error } : {}),
  };
}

const EMPTY_COLLAPSED: ReadonlySet<DisclosureKey> = new Set();

/** Spread onto buttons and inputs inside a sortable row, so pressing them never starts a drag. */
const stopDrag = {
  onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
  onTouchStart: (event: React.TouchEvent) => event.stopPropagation(),
};

interface RepoRowProps {
  /** Present when the row can collapse its checkouts; absent on the phone list. */
  disclosure?: RowDisclosure | undefined;
  /** Present when the row activates a drag of its subtree. */
  sortable?: SortableBind | undefined;
  repo: RepoInfo;
  message: RowMessage | null;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRetryRemoval?: (() => void) | undefined;
  /** Repo rows only — a checkout never spawns a worktree of a worktree. */
  onNewWorktree?: (() => void) | undefined;
}

/**
 * The repository: rank 1, a label for the checkouts beneath it rather than
 * a thing you connect to.
 *
 * It carries no status dot and no steady-state detail. A repo is not a
 * connection — its checkouts are — and a right edge that always says
 * something is a right edge that says nothing. The only thing that reaches
 * the gutter here is a transient message, which is by definition news.
 *
 * "New worktree" is the one action that belongs to the repo rather than to a
 * directory. Browse files and New terminal moved down to the checkout rows,
 * where they act on a specific working copy instead of on an implied one.
 */
function RepoRow({ repo, message, disclosure, sortable, onClick, onContextMenu, onNewWorktree, onRetryRemoval }: RepoRowProps) {
  return (
    <div className="repo-row" ref={sortable?.setActivatorNodeRef} {...sortable?.activatorProps} onClick={onClick} onContextMenu={onContextMenu}>
      <RowLead className="row-icon" title="Repository" disclosure={disclosure}>
        <RepoIcon />
      </RowLead>
      <span className="row-name">{repo.name}</span>
      {disclosure && !disclosure.expanded && <HiddenSummary {...disclosure.summary} />}
      {message && (
        <span
          className={`row-detail${message.isError ? " error" : ""}`}
          title={message.text}
        >
          {message.text}
        </span>
      )}
      {onRetryRemoval && (
        <button type="button" {...stopDrag} className="row-action retry-removal" aria-label="Retry removal"
          onClick={e => { e.stopPropagation(); onRetryRemoval(); }}>
          Retry
        </button>
      )}
      {onNewWorktree && (
        <button
          type="button"
          {...stopDrag}
          className="row-action"
          data-tooltip="New worktree…"
          aria-label="New worktree"
          aria-haspopup="dialog"
          onClick={(e) => {
            e.stopPropagation();
            onNewWorktree();
          }}
        >
          <Plus size={12} weight="bold" />
        </button>
      )}
    </div>
  );
}

interface CheckoutRowProps {
  /** Present when the row can collapse its items; absent on the phone list. */
  disclosure?: RowDisclosure | undefined;
  /** Present when the row activates a drag of its subtree. */
  sortable?: SortableBind | undefined;
  repo: RepoInfo;
  active: boolean;
  /** A repo with just its primary checkout uses one combined row. */
  repository?: boolean;
  /** The repo's own working copy. Never removable, always sorted first. */
  primary: boolean;
  status: DotStatus;
  statusError: string | undefined;
  message: RowMessage | null;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRetryRemoval?: (() => void) | undefined;
  onNewWorktree?: (() => void) | undefined;
  /** Hover actions, all acting on THIS checkout's directory. Absent while
   * the worktree is still being created (or failed to): the directory does
   * not exist yet, so none of them can work. */
  onOpenFiles?: (() => void) | undefined;
  onNewTerminal?: (() => void) | undefined;
  /** Opens the agent chooser, then starts a conversation in that harness. The
   * same flat menu the empty-checkout row offers, from the same shared
   * list — see `handlePickAgent`. */
  onNewAgent?: (() => void) | undefined;
  /** External-file drop wiring — an OS file dropped on this row lands in
   * the checkout's root, same import path as the tree view's rows. Absent
   * while the worktree is still being created: no directory to land in
   * yet, the same gate the hover actions use. */
  fileDrop?:
    | {
        active: boolean;
        onDragOver: (e: React.DragEvent) => void;
        onDragLeave: () => void;
        onDrop: (e: React.DragEvent) => void;
      }
    | undefined;
}

/**
 * One working copy: rank 2, and the rank that actually does things. The
 * repo's primary checkout is one of these, which is the whole point — its
 * terminals used to hang off the repo row as siblings of the WORKTREE rows,
 * so a terminal and a checkout read as the same kind of thing.
 *
 * The status dot renders only when the status is NOT open. A column of
 * identical green dots down every row costs the right edge on every row and
 * carries no information; a dot that appears when something is wrong is a
 * signal. The machine header keeps its dot unconditionally — there, current
 * state is the headline.
 */
function CheckoutRow({
  repo,
  active,
  repository = false,
  primary,
  status,
  statusError,
  message,
  disclosure,
  sortable,
  onClick,
  onDoubleClick,
  onContextMenu,
  onNewWorktree,
  onRetryRemoval,
  onOpenFiles,
  onNewTerminal,
  onNewAgent,
  fileDrop,
}: CheckoutRowProps) {
  const label = status === "error" ? errorRowDetail(repo.kind, statusError) : STATUS_LABELS[status];
  const statusDetail: RowDetail | null = status === "error" ? { text: label, isError: true } : null;
  // A transient message outranks the creation detail: a removal the daemon
  // refused with "still creating" has to be readable on the very row whose
  // "Creating…" is the reason it was refused. The message expires on its
  // own timer, leaving the row back on "Creating…".
  // The branch is a pill beside the name now, not gutter text, so the gutter
  // is back to carrying news only: a transient message outranks the creation
  // detail (a removal the daemon refused with "still creating" has to be
  // readable on the very row whose "Creating…" is the reason it was
  // refused), and both outrank a connection error.
  const branch = checkoutBranch(repo);
  const name = repository ? repo.name : checkoutName(repo);
  const detail: RowDetail | null =
    message ?? creationDetail(repo.worktreeOf) ?? statusDetail;
  return (
    <div
      className={`${repository ? "repo-row primary-checkout" : "checkout-row"}${primary ? " primary" : ""}${
        isDetached(repo) ? " detached" : ""
      }${active ? " active-checkout" : ""}${fileDrop?.active ? " drop-target" : ""}`}
      ref={sortable?.setActivatorNodeRef}
      {...sortable?.activatorProps}
      onClick={onClick}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest("button")) return;
        onDoubleClick();
      }}
      onContextMenu={onContextMenu}
      onDragOver={fileDrop?.onDragOver}
      onDragLeave={fileDrop?.onDragLeave}
      onDrop={fileDrop?.onDrop}
    >
      <RowLead className="row-icon" disclosure={disclosure}>
        {repository ? <RepoIcon /> : <CheckoutIcon repo={repo} />}
      </RowLead>
      <span className="checkout-label">
        <span className={repository ? "row-name" : "checkout-name"}>{name}</span>
        {branch !== null && (
          <span className="branch-pill" title={branch}>
            <BranchPillIcon detached={isDetached(repo)} />
            <span className="branch-pill-name">{branch}</span>
          </span>
        )}
      </span>
      {disclosure && !disclosure.expanded && <HiddenSummary {...disclosure.summary} />}
      {detail && (
        <span
          className={`row-detail${detail.isError ? " error" : ""}`}
          title={detail.title ?? detail.text}
        >
          {detail.text}
        </span>
      )}
      {/* Ordered by how often the action is wanted, most-used first, which
          on a checkout row means agent before shell before files. The
          previous order was files-then-terminal, which put the rarest of
          the three closest to the name. */}
      {onNewAgent && (
        <button
          type="button"
          {...stopDrag}
          className="row-action"
          data-tooltip="New agent…"
          aria-label="New agent"
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            onNewAgent();
          }}
        >
          {/* Not `Asterisk`, which is spoken for: row-icons.tsx's
              HARNESS_ICONS makes it mean CLAUDE, and claude rows sit
              directly under this button. A chooser of three agents
              cannot wear one agent's mark. */}
          <Sparkle size={12} weight="regular" />
        </button>
      )}
      {onNewTerminal && (
        <button
          type="button"
          {...stopDrag}
          className="row-action"
          data-tooltip={acpConversationsEnabled() ? "New terminal…" : "New terminal here"}
          aria-label="New terminal here"
          aria-haspopup={acpConversationsEnabled() ? "menu" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onNewTerminal();
          }}
        >
          <Terminal size={12} weight="regular" />
        </button>
      )}
      {onOpenFiles && (
        <button
          type="button"
          {...stopDrag}
          className="row-action row-action-browse"
          data-tooltip="Browse files"
          aria-label="Browse files"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFiles();
          }}
        >
          <FolderOpen size={12} weight="regular" />
        </button>
      )}
      {onRetryRemoval && (
        <button type="button" {...stopDrag} className="row-action retry-removal" aria-label="Retry removal"
          onClick={e => { e.stopPropagation(); onRetryRemoval(); }}>
          Retry
        </button>
      )}
      {onNewWorktree && (
        <button
          type="button"
          {...stopDrag}
          className="row-action"
          data-tooltip="New worktree…"
          aria-label="New worktree"
          aria-haspopup="dialog"
          onClick={(e) => {
            e.stopPropagation();
            onNewWorktree();
          }}
        >
          <Plus size={12} weight="bold" />
        </button>
      )}
      {status !== "open" && (
        <span className={`status-dot status-${status}`} title={label || undefined} />
      )}
    </div>
  );
}


/** The add-repo shortcut, in the platform's own glyphs (see HotkeysPane). */
function addRepoShortcutLabel(isMac: boolean): string {
  return isMac ? "⇧⌘O" : "Shift+Ctrl+O";
}

/**
 * A machine section's empty state: not a line of text saying there is
 * nothing here, but the one thing to do about it — a full-width dashed
 * "+ Add …" button sitting where the first repo row will. The cloud one
 * carries the global shortcut that opens the same flow.
 */
function MachineAddButton({
  label,
  shortcut,
  onClick,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <div className="machine-empty">
      <button type="button" className="machine-add-button" onClick={onClick}>
        <span className="machine-add-label">+ {label}</span>
        {shortcut && <kbd className="machine-add-kbd">{shortcut}</kbd>}
      </button>
    </div>
  );
}

/**
 * A machine: the section header, not a row.
 *
 * It used to be rendered as a `.repo-header` — the same 12px/500 type,
 * the same hover highlight, the same indent origin as the repos nested
 * under it — so "This Mac" and a repo read as siblings and the only thing
 * telling them apart was an icon. A machine is a fixture, not something you
 * click into, and it now looks like one: smaller, tracked out, on its own
 * ground, no hover state, and outside the tree's indent entirely. Promoting it out of
 * the tree is also what pays for the checkout rank added below it.
 *
 * It is NOT muted — it sits on its own ground at full `--foreground`, above
 * every rank in the tree. Muted was the original treatment and it failed
 * for a reason worth keeping written down: it made the header the palest
 * thing in a panel where everything beneath it was louder, so it read as a
 * caption on the row below rather than as a label over the section. See
 * `.machine-header` in ReposSidebar.css for the ground's rationale.
 *
 * It keeps its status dot unconditionally, and it is the only rank that
 * does. Whether the machine is reachable is this section's headline fact,
 * and it is the one place the dot actually varies — the checkout rows below
 * show theirs only when something is wrong.
 */
function MachineHeaderRow({
  kind,
  name,
  status,
  statusError,
  message,
  machineName,
  disclosure,
  onContextMenu,
  onAdd,
  onUpdate,
}: {
  kind: RepoInfo["kind"];
  /** Present when the header can collapse its repos; absent on the phone list. */
  disclosure?: RowDisclosure | undefined;
  /** The section label — "Cloud machine" / "Local machine" (see kindLabel). */
  name: string;
  /** The machine's own name, for the hover text. The header names the RANK
   * rather than the instance, so this is where the instance goes: it is a
   * fixture-level constant, and a constant printed on screen is a constant
   * spending space. */
  machineName?: string | undefined;
  status: DotStatus;
  statusError: string | undefined;
  message: RowMessage | null;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** New Repo on this machine. */
  onAdd?: (() => void) | undefined;
  /** Confirmed image update for an incompatible daemon or missing
   * conversation capability. Present or absent, never merely hidden. */
  onUpdate?: (() => void) | undefined;
}) {
  const label = status === "error" ? errorRowDetail(kind, statusError) : STATUS_LABELS[status];
  const detail = message ?? (status === "error" ? { text: label, isError: true } : null);
  return (
    <div className="machine-header" onContextMenu={onContextMenu} title={machineName}>
      {/* The mark, not a laptop-and-cloud pair. See MachineIcon in
          row-icons for why this rank has a glyph again: the prism is the
          product rather than a picture of the word beside it. */}
      <RowLead className="machine-header-icon" disclosure={disclosure}>
        <MachineIcon kind={kind} />
      </RowLead>
      <span className="machine-header-name">{name}</span>
      {disclosure && !disclosure.expanded && <HiddenSummary {...disclosure.summary} />}
      <span
        className={`status-dot status-${status}`}
        title={detail?.text ?? (label || undefined)}
      />
      {detail && (
        <span
          className={`row-detail${detail.isError ? " error" : ""}`}
          title={detail.text}
        >
          {detail.text}
        </span>
      )}
      {onUpdate && (
        <button
          type="button"
          {...stopDrag}
          className="row-action"
          title="Update machine"
          aria-label="Update machine"
          onClick={(e) => {
            e.stopPropagation();
            onUpdate();
          }}
        >
          <ArrowsClockwise size={12} weight="bold" />
        </button>
      )}
      {/* The local machine's "New Repo" opens AddLocalRepoModal, which has no
          browser equivalent (native folder picker) — hidden there behind
          capabilities.localRepos. Cloud's is never gated: cloning a
          GitHub repo onto the paired cloud machine works from a browser. */}
      {onAdd && (kind !== "local" || services.desktop.capabilities.localRepos) && (
        <button
          type="button"
          {...stopDrag}
          className="row-action"
          data-tooltip="New repo…"
          aria-label="New repo"
          aria-haspopup="dialog"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
        >
          <Plus size={12} weight="bold" />
        </button>
      )}
    </div>
  );
}

function TileEntryRow({
  entry,
  focused,
  isRenaming,
  renameValue,
  onClick,
  onDoubleClick,
  onContextMenu,
  onRenameChange,
  onRenameConfirm,
  onRenameCancel,
  onClose,
  showViewState,
  sortable,
  worktreeLabel,
  hideLiveDetail = false,
}: {
  entry: ItemListEntry;
  /** The linked worktree this terminal or conversation works in (mini layout only). */
  worktreeLabel?: WorktreeLabel | undefined;
  /** Drop the foreground command / touched file on the row's right. */
  hideLiveDetail?: boolean | undefined;
  /** Present when the row is its own sortable node and activator. */
  sortable?: SortableBind | undefined;
  focused: boolean;
  isRenaming: boolean;
  renameValue: string;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameChange: (value: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  /** Hover action: close the session (same confirm-then-close flow as the
   * context menu's Close). */
  onClose: () => void;
  /** Whether the row reflects the workspace's view state — the focused
   * accent bar and the hidden-item dimming. Both describe an item's place
   * in the columns (looked at, or mounted but paned away), and the phone's
   * list has no such place: every row is a destination, so none is
   * highlighted and none is dimmed. False on touch rows. */
  showViewState: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.select();
    }
  }, [isRenaming]);

  const liveDetail = hideLiveDetail ? null : resolveLiveDetail(entry);
  const iconClass = itemIconClass(entry.type, entry.target);
  const setNodeRef = sortable?.setNodeRef;
  const setActivatorNodeRef = sortable?.setActivatorNodeRef;
  const rowRef = useCallback((node: HTMLDivElement | null) => {
    setNodeRef?.(node);
    setActivatorNodeRef?.(node);
  }, [setNodeRef, setActivatorNodeRef]);

  return (
    <div
      className={`tile-entry${showViewState && focused ? " focused" : ""}${
        showViewState && entry.hidden ? " hidden-item" : ""
      }${entry.closing ? " closing" : ""}${entry.stopped ? " stopped" : ""}`}
      ref={rowRef}
      data-sidebar-item-id={entry.id}
      style={sortable?.style}
      {...sortable?.activatorProps}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className={`tile-icon${iconClass ? ` ${iconClass}` : ""}`}>
        <ItemIcon type={entry.type} target={entry.target} />
        {/* What an agent row asks of the user — blocked, finished and
            unseen, or working (attention/attention.ts). A badge on the
            glyph's top-right corner, out of the flow: its coming and going
            must never move the title, and it must never need a hover to
            show, unlike the close action at the right edge. */}
        <AttentionDot state={entry.attention ?? "idle"} className="tile-attention" />
      </div>
      {isRenaming ? (
        <input
          ref={inputRef}
          className="tile-rename-input"
          {...stopDrag}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRenameConfirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onRenameCancel();
            }
          }}
          onBlur={onRenameConfirm}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          {/* The title truncates in every state now (see .tile-title), so the
              native tooltip is how a long one is read in full — the job the
              focused row's second line used to do, at no layout cost. Same
              treatment .tile-detail and .branch-pill already get. */}
          <div className="tile-title" title={entry.title}>
            {textPresentation(entry.title)}
          </div>
          {/* The tree's branch pill (checkout rows), so a worktree reads the
              same wherever it is named. */}
          {worktreeLabel && (
            <span className={`branch-pill tile-worktree-label${worktreeLabel.detached ? " detached" : ""}`} title={`Worktree: ${worktreeLabel.name}`}>
              <BranchPillIcon detached={worktreeLabel.detached} />
              <span className="branch-pill-name">{worktreeLabel.name}</span>
            </span>
          )}
          {entry.personaName && (
            <span className="tile-persona-badge" title={`Persona: ${entry.personaName}`}>
              {entry.personaName}
            </span>
          )}
          {liveDetail && (
            <div className="tile-detail" title={liveDetail}>
              {liveDetail}
            </div>
          )}
          {/* Artifact rows carry no close: an artifact lives while it is
              valid, and the sidebar never removes or hides one. Without the
              button the title simply runs to the row's edge, in the drawer
              and on MobileHome too. */}
          {entry.type !== "artifact" && (
            <button
              type="button"
              // row-action-close is how Sidebar.css's narrow drawer promotes
              // exactly ONE control per item row to an always-visible 32px
              // target (a phone has no hover, and touch Safari does not
              // dependably raise `contextmenu` on long-press). The repo
              // headers promote their own by container instead.
              className="row-action row-action-close"
              {...stopDrag}
              data-tooltip={entry.closing ? "Ending session…" : "Close session"}
              aria-label={entry.closing ? "Ending session" : "Close session"}
              // Disabled while the kill is in flight: the row stays until the
              // daemon confirms the session ended, and a second click would
              // just queue another kill behind the same settlement.
              disabled={entry.closing}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              {entry.closing ? (
                <CircleNotch size={12} weight="regular" className="tile-closing-spinner" />
              ) : (
                <TrashSimple size={12} weight="regular" />
              )}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export interface ReposSidebarProps {
  /** Studio's list heading and presentation overrides. Other consumers keep their own view. */
  repoListHeader?: React.ReactNode;
  showWorktrees?: boolean | undefined;
  showArtifacts?: boolean | undefined;
  groupUnscopedByDirectory?: boolean | undefined;
  localHome?: string | null | undefined;
  /** Studio hides the local page until its catalog has content. */
  allowLocal?: boolean | undefined;
  /** Machine-scoped actions before Add Repo, supplied by Studio. */
  machineActions?: ((machine: "local" | "cloud") => React.ReactNode) | undefined;
  machineHeader?: ((machine: "local" | "cloud") => React.ReactNode) | undefined;
  /** A title row at the top of each machine page, so it pages with the machine. */
  machineTitle?: ((machine: "local" | "cloud") => React.ReactNode) | undefined;
  /** A section to show under that title in place of the page's repos, or null for the repos. */
  machineBody?: ((machine: "local" | "cloud") => React.ReactNode) | undefined;
  /** Hide repository contents while retaining the machine pages and their persona headers. */
  hideRepos?: boolean | undefined;
  /**
   * Whether this tree is the one on screen. The phone's home screen and the
   * navigator's Projects surface each mount their own, and a hidden one's
   * document-level key handlers must not fire underneath the visible one.
   * Read via a ref inside the handlers rather than as a dependency, so the
   * listener doesn't get torn down and rebuilt on every change.
   */
  visible: boolean;
  /**
   * Called whenever a row in this sidebar opens or focuses an item.
   * MobileHome uses it to show the item screen; undefined (and therefore a
   * no-op) in the navigator's panel. Deliberately a callback rather than
   * the host watching `activeItemId`: re-tapping the row of the
   * already-active item is a no-op in the store (setActiveItem
   * early-returns) but must still navigate.
   */
  onNavigate?: (() => void) | undefined;
  /** Render the running status dot on item rows — the phone's
   * session-alive indicator (#83). The touch surface (MobileHome) sets it;
   * desktop leaves liveness on the detail text. Rename deliberately has no
   * row affordance on touch: it lives on the item screen's own header
   * (MobileItemHeader), keeping rows at the drawer-era one-control
   * promotion the layout was designed around. */
  touchRows?: boolean | undefined;
  /** "mini": repos with their terminals flat beneath them, worktrees as labels. */
  layout?: "tree" | "mini" | undefined;
}

export function ReposSidebar({ visible, onNavigate: onNavigateProp, touchRows, machineHeader, machineTitle, machineBody, machineActions, allowLocal = true, hideRepos = false, layout = "tree", repoListHeader, showWorktrees, showArtifacts = true, groupUnscopedByDirectory = false, localHome = null }: ReposSidebarProps) {
  const mini = layout === "mini";
  // A navigation out of the tree — an item opened, a session created, a
  // repo picked — tells the host (the phone home screen) to navigate.
  const onNavigate = useCallback(() => { onNavigateProp?.(); }, [onNavigateProp]);
  const workspace = useWorkspace();
  const catalog = useCatalog();
  const live = useLiveStatus();
  const reposState = useRepos();
  // Mini draws no worktree rows, so a selected worktree lights its repo's row.
  const activeRepo = reposState.repos.find((repo) => repo.id === reposState.activeRepoId);
  const activeTopLevelRepoId = activeRepo?.worktreeOf?.repoId ?? reposState.activeRepoId;
  const containerRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // OS files dropped on a checkout row land in that checkout's root — the
  // same import path as the tree view's rows (use-file-import.ts). This
  // tracks which root a file drag currently hovers, for the row highlight
  // and the strip's copy/upload hint; no selection follows a drop here (the
  // default view has no file rows to select).
  const [dropRoot, setDropRoot] = useState<string | null>(null);
  const { transfer, dismissTransfer, importFiles } = useFileImport();
  // Each machine section owns its own modal — the machine sections' +
  // buttons and empty states each open their own kind directly, there's no
  // shared toggle state to route through.
  const [localModalOpen, setLocalModalOpen] = useState(false);
  const [createMachineId, setCreateMachineId] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const chooseRepoAction = useCallback(async (machineId: string) => {
    const action = await pickRepoAction(machineId);
    if (!mounted.current) return;
    if (action === "create-repo") setCreateMachineId(machineId);
    else if (action === "add-existing-repo") {
      setLocalModalOpen(true);
    }
  }, []);

  // Requests from outside the sidebar (the foot's folder, ⇧⌘O) run the
  // same menu and open the same modals as the sidebar's own rows.
  useEffect(() => onAddRepoRequest(machineId => { void chooseRepoAction(machineId); }), [chooseRepoAction]);

  const focusedId = workspace.activeItemId;

  // Per-view: the canvas, the columns rail, and a screen are different
  // surfaces, and "on screen right now" follows whichever one is showing.
  // A screen's panes count the same way. (Narrow mode forces the columns
  // projection regardless of activeView; that edge renders canvas- and
  // screen-placed items un-grayed there, accepted for the spike.)
  const displayed = useMemo(
    () => displayedItemIds(workspace),
    [workspace.activeView, workspace.canvasTiles, workspace.columns, workspace.screens],
  );

  // Every agent row's attention, derived once for every surface
  // (attention/store.ts); identity-stable across catalog changes that move
  // no dot.
  const attention = useAttentionMap();

  // Sessions only — terminals and agent conversations: this sidebar is a
  // registry of what's running in the underlying system (a pty, or an ACP
  // pipe), not a record of what's open on the rail. File
  // items live in the file tree (filetree/FileTreeHost.tsx); clicking a file there focuses
  // or reveals its existing item via openFile's dedupe. Reads from the
  // catalog now (this machine's full registry of items, not just the ones
  // this client has ever opened) — `live` isn't read directly here, but is
  // still a real dependency: `getLiveState` reads the same module state
  // `useLiveStatus()` subscribes to, so this must recompute whenever it
  // changes.
  //
  // `hidden` means exactly one thing: this item has no pane on screen right
  // now. It is derived from `columns` and nothing else.
  //
  // It used to also require `mountedItemIds.has(id)` — "this client mounted
  // it but isn't paning it" — to tell "you hid this" apart from "you never
  // opened this". That distinction is not one a reader can use, and paying
  // for it cost the one that matters: an item this client had never mounted
  // fell through to `false` and rendered identically to an item actually on
  // screen. The symptom was a cloud machine, where the catalog lists every
  // item on the machine and most of them were opened by some other client,
  // so a whole panel of off-screen sessions read as live ones.
  //
  // `mountedItemIds` answers a different question — whose DOM does Rail
  // keep alive — and that is a keep-alive concern, not a visibility one.
  // Keeping them separate is also what makes tabs cheap later: an
  // independent arrangement of tiles changes which `columns` are in play,
  // and every row in this panel re-derives from that with no stored
  // visibility flag anywhere to keep in sync.
  // Artifacts this device hid from its sidebar (row menu → Hide from sidebar).
  const hiddenArtifacts = useHiddenArtifacts();
  const entries = useMemo(
    () => {
      return catalog.items
        .filter((item) => !(item.type === "artifact" && hiddenArtifacts.has(item.id)))
        .filter((item) => showArtifacts || item.type !== "artifact")
        .filter((item) => mini ? listedInMini(item, touchRows === true)
          : item.type === "term" || item.type === "agent" || item.type === "artifact")
        .map((item) =>
          buildItemListEntry(
            item,
            {
              ...getLiveState(item.id),
              hidden: !displayed.has(item.id),
            },
            undefined,
            attention.get(item.id) ?? "idle",
          ),
        );
    },
    [mini, touchRows, catalog.items, live, displayed, attention, hiddenArtifacts, showArtifacts],
  );
  // Every item without a checkout belongs in Unscoped, including web artifacts.
  const scopedEntries = entries;
  const localMachineEntries = NO_ENTRIES;
  const cloudMachineEntries = NO_ENTRIES;
  const groups = useMemo(
    () => groupEntries(scopedEntries, repoDisplayOrder(reposState.repos)),
    [scopedEntries, reposState.repos],
  );
  // Whether this host HAS a local machine — not merely whether it can add
  // repos to one. The flag reads "Local (this-machine) repos and
  // terminals" (capabilities.ts), which a browser answers false to because
  // there is no such machine behind the tab at all, so the section that
  // names it does not belong on screen either. Width only changes the
  // layout: a narrow Electron window still owns its local machine.
  const showLocalMachine = services.desktop.capabilities.localRepos && allowLocal;
  // Builder exposes only the installation machine. Preserve the local-page geometry.
  const shownMachine = "local";
  const machinePages = false;
  const machinePagesRef = useRef<HTMLDivElement>(null);
  const showCloudSection = false;
  const showLocalSection = showLocalMachine;
  // Collapsible rows (spec §2). The phone list has no disclosure at all: it
  // renders every row expanded, with no chevrons and no hidden counts,
  // whatever this client collapsed at full width.
  const disclosureState = useDisclosure();
  const collapsed = useMemo(() => touchRows ? EMPTY_COLLAPSED
    : groupUnscopedByDirectory ? new Set([...disclosureState.collapsed].filter(key => key !== UNSCOPED_KEY))
    : disclosureState.collapsed, [touchRows, groupUnscopedByDirectory, disclosureState.collapsed]);
  const tileReveal = useSyncExternalStore(sidebarTileRevealStore.subscribe, sidebarTileRevealStore.getSnapshot);
  // Split into local repo groups, cloud repo groups (nested under the
  // one machine-headed Cloud section — see the render below), and the
  // trailing Unscoped group groupEntries already produces. flatEntries
  // mirrors this same order so arrow-key navigation matches what's drawn.
  const localGroups = useMemo(
    () => groups.filter((g): g is EntryGroup<ItemListEntry> => g.repo?.kind === "local"),
    [groups],
  );
  const cloudGroups = useMemo(
    () => groups.filter((g): g is EntryGroup<ItemListEntry> => g.repo?.kind === "cloud"),
    [groups],
  );
  const unscopedGroup = useMemo(() => groups.find((g) => g.repoId === null) ?? null, [groups]);
  const directoryGroups = useMemo(() => groupUnscopedByDirectory
    ? unscopedDirectories(unscopedGroup?.entries ?? [], catalog.items, catalog.repos, localHome)
    : [], [groupUnscopedByDirectory, unscopedGroup, catalog.items, catalog.repos, localHome]);
  const unscopedEntries = useMemo(() => groupUnscopedByDirectory
    ? directoryGroups.flatMap(group => group.entries)
    : unscopedGroup?.entries ?? NO_ENTRIES, [groupUnscopedByDirectory, directoryGroups, unscopedGroup]);
  const directoryKeyById = useMemo(() => new Map(directoryGroups.flatMap(group =>
    group.entries.map(entry => [entry.id, group.key] as const))), [directoryGroups]);
  const ancestorKeysById = useMemo(
    () => new Map(catalog.items.map((item) => {
      const directory = directoryKeyById.get(item.id);
      return [item.id, directory !== undefined ? [directoryKey(directory)]
        : mini ? miniAncestorKeys(item, catalog.repos) : itemAncestorKeys(item, catalog.repos)];
    })),
    [mini, catalog.items, catalog.repos, directoryKeyById],
  );
  const ancestorsOf = useCallback((entry: ItemListEntry) => ancestorKeysById.get(entry.id) ?? [], [ancestorKeysById]);
  const rowDisclosure = useCallback((key: DisclosureKey, label: string, hasChildren: boolean): RowDisclosure | undefined => touchRows ? undefined : {
    expanded: !collapsed.has(key),
    hasChildren,
    label,
    controls: disclosureRegionId(key),
    summary: hiddenSummary(key, entries, ancestorsOf),
    onToggle: () => toggleCollapsed(key),
  }, [touchRows, collapsed, entries, ancestorsOf]);
  // Directory grouping belongs to this view (including its resolved local
  // home). Only explicit focus intent opens a group, never catalog changes.
  useEffect(() => onSidebarReveal(itemId => {
    const directory = directoryKeyById.get(itemId);
    if (directory !== undefined) expandKeys([directoryKey(directory)]);
  }), [directoryKeyById]);
  useEffect(() => {
    if (!tileReveal || touchRows || !visible) return;
    const directory = directoryKeyById.get(tileReveal.itemId);
    if (directory !== undefined) expandKeys([directoryKey(directory)]);
    const row = [...(containerRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-item-id]") ?? [])]
      .find(candidate => candidate.dataset.sidebarItemId === tileReveal.itemId);
    if (!row) return;
    row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    sidebarTileRevealStore.consume(tileReveal);
  }, [tileReveal, touchRows, visible, shownMachine, collapsed, entries, directoryKeyById]);
  // Folded into repo → checkouts → items for rendering. `flatEntries` stays
  // on the flat group order above, which is the same order the fold walks —
  // arrow-key navigation must match what is drawn.
  const localSections = useMemo(() => repoSections(localGroups), [localGroups]);
  const cloudSections = useMemo(() => repoSections(cloudGroups), [cloudGroups]);
  const documentIndex = useMemo(() => new Map(catalog.items.map((item, index) => [item.id, index])), [catalog.items]);
  // The checkout each terminal works in: its worktree label's own answer,
  // which the worktree view files it under.
  const workingCheckouts = useMemo(() => {
    const checkouts = new Map<string, string>();
    if (!mini) return checkouts;
    for (const item of catalog.items) {
      if (item.type !== "term" && item.type !== "agent") continue;
      const checkout = workingCheckoutId(item, catalog.repos);
      if (checkout !== null) checkouts.set(item.id, checkout);
    }
    return checkouts;
  }, [mini, catalog.items, catalog.repos]);
  const worktreeView = useWorktreeView();
  // Each mini repo: its flat list, and — when its toggle is on — main's
  // nested checkouts to draw instead (a lone primary checkout included).
  const miniDisplays = useCallback((sections: RepoSection<ItemListEntry>[]): MiniDisplay[] =>
    miniRepoSections(sections, documentIndex).map((section, index) => ({
      ...section,
      worktrees: (showWorktrees ?? worktreeView.has(section.repo.id))
        ? worktreeViewSection(sections[index]!, (id) => workingCheckouts.get(id) ?? null, documentIndex)
        : null,
    })), [documentIndex, worktreeView, workingCheckouts, showWorktrees]);
  const localMini = useMemo(() => miniDisplays(localSections), [miniDisplays, localSections]);
  const cloudMini = useMemo(() => miniDisplays(cloudSections), [miniDisplays, cloudSections]);
  // Under its worktree's own row a terminal needs no label naming it.
  const nestedItemIds = useMemo(() => new Set([...cloudMini, ...localMini].flatMap((section) =>
    section.worktrees?.checkouts.flatMap((checkout) => checkout.entries.map((entry) => entry.id)) ?? [])), [cloudMini, localMini]);
  const worktreeLabels = useMemo(() => {
    const labels = new Map<string, WorktreeLabel>();
    if (!mini) return labels;
    for (const item of catalog.items) {
      if (item.type !== "term" && item.type !== "agent") continue;
      const label = worktreeLabel(item, catalog.repos);
      if (label !== null) labels.set(item.id, label);
    }
    return labels;
  }, [mini, catalog.items, catalog.repos]);
  // Catalog membership supplies reveal-all and reconnect ownership, never layouts.
  const checkoutScreens = useMemo(() => {
    const items = catalog.items.filter((item) =>
      item.type === "term" || item.type === "agent" || item.type === "artifact");
    const repos = repoDisplayOrder(reposState.repos);
    const repoIds = new Set(repos.map((repo) => repo.id));
    return [
      ...repos.map((repo) => ({
        repoId: repo.id,
        ...(catalog.repos.find(owner => owner.id === repo.id)?.machineId ? { machineId: catalog.repos.find(owner => owner.id === repo.id)!.machineId } : {}),
        name: repo.worktreeOf ? checkoutName(repo) ?? checkoutBranch(repo) ?? repo.name : repo.name,
        itemIds: items.filter((item) => item.repoId === repo.id).map((item) => item.id),
      })),
      { repoId: "__unscoped__", name: "Unscoped",
        itemIds: items.filter((item) => !item.repoId || !repoIds.has(item.repoId)).map((item) => item.id) },
    ];
  }, [catalog.items, reposState.repos]);
  useEffect(() => {
    syncCheckoutScreens(checkoutScreens, { localCatalogExpected: services.desktop.capabilities.localRepos });
  }, [checkoutScreens, workspace.mountedItemIds]);
  // One index for render and commit (spec §2.8): each sibling set's displayed
  // ids, in render order.
  const sortableRows = useMemo(() => {
    const rows: { id: string; scopeId: string; row: RowScope }[] = [];
    // `group` splits one reorder scope into separately drawn sibling sets.
    const push = (row: RowScope | null, id: string, group?: string) => { if (row) rows.push({ id, scopeId: group ?? scopeId(row), row }); };
    const machineFor = (repoId: string) => catalog.repos.find((row) => row.id === repoId)?.machineId ?? "";
    if (mini) {
      for (const section of [...cloudMini, ...(showLocalMachine ? localMini : [])]) {
        push(repoRowScope(catalog, section.repo.id), section.repo.id);
        const row: RowScope = { machineId: machineFor(section.repo.id), scope: { kind: "repo-items", repoId: section.repo.id } };
        // The worktree view draws the repo's items in one group per checkout
        // they work in, whatever checkout they are filed under. Each group is
        // its own sibling set, and a drop permutes only that group's slots
        // within the repo-wide order.
        if (section.worktrees) {
          for (const checkout of section.worktrees.checkouts) {
            if (!checkout.primary) push(repoRowScope(catalog, checkout.repo.id), checkout.repo.id);
            for (const entry of checkout.entries) push(row, entry.id, worktreeViewGroup(row, checkout.repo.id));
          }
          continue;
        }
        for (const entry of section.entries) push(row, entry.id);
      }
    } else {
      for (const entry of [...cloudMachineEntries, ...(showLocalMachine ? localMachineEntries : [])]) {
        push(itemRowScope(catalog, entry.id), entry.id);
      }
      for (const section of [...cloudSections, ...(showLocalMachine ? localSections : [])]) {
        push(repoRowScope(catalog, section.repo.id), section.repo.id);
        for (const checkout of section.checkouts) {
          if (!checkout.primary) push(repoRowScope(catalog, checkout.repo.id), checkout.repo.id);
          for (const entry of checkout.entries) push(itemRowScope(catalog, entry.id), entry.id);
        }
      }
    }
    for (const entry of unscopedEntries) {
      const row = itemRowScope(catalog, entry.id);
      const directory = directoryKeyById.get(entry.id);
      push(row, entry.id, row && directory ? `${scopeId(row)}@${directory}` : undefined);
    }
    return rows;
  }, [mini, cloudMini, localMini, cloudMachineEntries, localMachineEntries, cloudSections, localSections, showLocalMachine, unscopedEntries, directoryKeyById, catalog]);
  const rowScopeOf = useMemo(() => new Map(sortableRows.map((entry) => [entry.id, entry.row])), [sortableRows]);
  const rowScopeOfRef = useRef(rowScopeOf);
  rowScopeOfRef.current = rowScopeOf;
  const siblingIndex = useMemo(() => buildSiblingIndex(sortableRows), [sortableRows]);
  const rowScopeIds = useMemo(() => new Map(sortableRows.map((row) => [row.id, row.scopeId])), [sortableRows]);
  const machineOf = useCallback((repoId: string) => catalog.repos.find((row) => row.id === repoId)?.machineId ?? "", [catalog.repos]);
  const siblingIndexRef = useRef(siblingIndex);
  siblingIndexRef.current = siblingIndex;
  const rowScopeIdsRef = useRef(rowScopeIds);
  rowScopeIdsRef.current = rowScopeIds;
  const dragController = useMemo(() => createDragController({
    rowScope: (id) => rowScopeOfRef.current.get(id) ?? null,
    displayedIds: (id) => siblingIndexRef.current.get(rowScopeIdsRef.current.get(id) ?? "") ?? [],
    members: (row) => scopeMembers(machineDocument(row.machineId), row),
    reorder: (machineId, scope, ids) => reorderCatalog(machineId, scope, ids),
    warn: (reason) => console.warn("[sidebar] reorder refused:", reason),
  }), []);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  /** Move up/down menu entries and their handler for one row (spec §2.7). */
  const moveMenu = useCallback((passed: RowScope | null, id: string) => {
    // An explicit null is a row that offers no move (a multi-checkout
    // repo's primary checkout, which shares its repo's id); otherwise the
    // scope this sidebar drew the row in wins over the menu's guess.
    const row = passed === null ? null : rowScopeOf.get(id) ?? passed;
    if (row === null) return { items: [] as ContextMenuItem[], run: async (_selected: string | null) => {} };
    const displayed = siblingIndex.get(rowScopeIds.get(id) ?? scopeId(row)) ?? [];
    const index = displayed.indexOf(id);
    const items: ContextMenuItem[] = [
      { id: "move-up", label: "Move up", enabled: index > 0 },
      { id: "move-down", label: "Move down", enabled: index >= 0 && index < displayed.length - 1 },
    ];
    const run = async (selected: string | null) => {
      if (selected !== "move-up" && selected !== "move-down") return;
      const members = scopeMembers(machineDocument(row.machineId), row);
      if (members === null) return;
      const plan = planMove(row, id, selected === "move-up" ? "up" : "down", displayed, members);
      if (plan === null) return;
      const result = await reorderCatalog(plan.machineId, plan.scope, plan.ids);
      if (!result.ok) console.warn("[sidebar] reorder refused:", result.reason);
    };
    return { items, run };
  }, [siblingIndex, rowScopeOf, rowScopeIds]);

  // Walk the selected machine's sites and repos, then Unscoped, in the
  // same order as the rendered rows. The other machine and collapsed
  // descendants must never become invisible keyboard stops.
  const flatEntries = useMemo(() => {
    const unscoped = unscopedEntries.filter(entry => touchRows
      || (catalog.items.find(item => item.id === entry.id)?.machineId === LOCAL_MACHINE_ID ? "local" : "cloud") === shownMachine);
    const ordered = mini
      ? [...(showCloudSection ? cloudMini : []), ...(showLocalSection ? localMini : [])]
          .flatMap((section) => section.worktrees
            ? section.worktrees.checkouts.flatMap((checkout) => collapsed.has(checkoutKey(checkout.repo.id)) ? [] : checkout.entries)
            : section.entries)
          .concat(unscoped)
      : sidebarNavigationOrder({
          cloudMachineEntries: showCloudSection ? cloudMachineEntries : NO_ENTRIES,
          cloudGroups: showCloudSection ? cloudGroups : [],
          localMachineEntries,
          localGroups,
          showLocalMachine: showLocalSection,
          unscoped: unscopedGroup && { ...unscopedGroup, entries: unscoped },
        });
    return ordered.filter((entry) => !isHiddenBy(ancestorsOf(entry), collapsed));
  }, [mini, cloudMini, localMini, cloudMachineEntries, cloudGroups, localMachineEntries, localGroups, showCloudSection, showLocalSection, unscopedGroup, unscopedEntries, ancestorsOf, collapsed, touchRows, shownMachine, catalog.items]);

  const handleSelectRepo = useCallback((repoId: string, revealAll = false) => {
    // Selecting a repo, or a worktree in it, opens its fold: you cannot be
    // working in a repo whose rows are hidden, and the selection is what
    // says you are working there. The worktree's parent is what carries the
    // fold, so open that too.
    expandKeys([repoKey(repoId), checkoutKey(repoId)]);
    const parentId = reposState.repos.find((r) => r.id === repoId)?.worktreeOf?.repoId;
    if (parentId !== undefined) expandKeys([repoKey(parentId)]);
    setActiveRepo(repoId);
    if (machineHeader) {
      const repo = reposState.repos.find(repo => repo.id === repoId);
      if (repo) openSidebarItem(registerTreePane({ repoId, root: virtualRootFor(repo), name: checkoutName(repo) ?? repo.name }));
      return;
    }
    const checkout = checkoutScreens.find((screen) => screen.repoId === repoId);
    if (checkout && revealAll) openCheckoutScreen(checkout, { revealAll: true });
  }, [checkoutScreens, reposState.repos, machineHeader]);

  const handleOpenFiles = useCallback((repo: RepoInfo) => {
    handleSelectRepo(repo.id);
    if (!machineHeader) openTreePane({
      repoId: repo.id,
      root: virtualRootFor(repo),
      name: checkoutName(repo) ?? repo.name,
    });
    onNavigate?.();
  }, [handleSelectRepo, onNavigate, machineHeader]);

  /**
   * Focus the item and select its worktree as sidebar context, without reporting it as
   * navigation. Selecting that repo also makes Cmd+N target this checkout.
   * Split out from handleClick for the ArrowUp/ArrowDown handler below:
   * arrow keys traverse the list, and calling onNavigate on each step would
   * dismiss the narrow drawer the moment the user started walking it. A
   * pointer activation is the only thing that counts as "the user picked
   * this one and is done here".
   */
  const selectEntryRepo = useCallback(
    (id: string) => {
      const checkout = checkoutScreens.find((screen) => screen.itemIds.includes(id));
      if (checkout && checkout.repoId !== "__unscoped__") setActiveRepo(checkout.repoId);
    },
    [checkoutScreens],
  );
  const focusEntry = useCallback(
    (id: string) => {
      selectEntryRepo(id);
      if (machineHeader) openSidebarItem(id);
      else focusItem(id);
    },
    [selectEntryRepo, machineHeader],
  );

  // A pointer activation, unlike the arrow traversal above it, also hands
  // the item the caret: picking a terminal here used to leave it wearing
  // the focus ring while every keystroke went somewhere else, until the
  // pane itself was clicked a second time. The view answers the signal —
  // see item-focus.ts for why only this path fires it.
  //
  // A pointer activation also goes to the item where it already is: when
  // another screen shows it and this one does not, the rail travels there
  // (`showItem`) instead of opening a second copy here. Arrow traversal keeps
  // opening here, since sliding the rail on every keypress would lose the
  // user's place; "Open here" in the row menu asks for this screen outright.
  const handleClick = useCallback(
    (id: string) => {
      selectEntryRepo(id);
      if (machineHeader) openSidebarItem(id);
      else showItem(id);
      requestItemFocus(id);
      onNavigate?.();
    },
    [selectEntryRepo, onNavigate, machineHeader],
  );

  const handleDoubleClick = useCallback(
    (id: string) => {
      selectEntryRepo(id);
      if (machineHeader) openSidebarItem(id);
      else showItem(id);
      requestItemFocus(id);
      onNavigate?.();
    },
    [selectEntryRepo, onNavigate, machineHeader],
  );

  const startRename = useCallback((id: string) => {
    const entry = entries.find(en => en.id === id);
    if (entry) {
      setRenameValue(entry.title);
      setRenamingId(id);
    }
  }, [entries]);
  const getItemTitle = useCallback(
    (id: string) => entries.find(entry => entry.id === id)?.title, [entries],
  );
  const rowActions = useRowActions({
    moveMenu, onNavigate, startRename, openTreePaneFor: handleOpenFiles,
    setClosing, setActiveRepo, focusEntry, getItemTitle,
  });
  const {
    rowMessage, showRowMessage, removalMessage, retryRemoval,
    newWorktree: handleNewWorktree, pickAgent: handlePickAgent, closeItem: closeEntry,
  } = rowActions;
  const commitRename = useCallback((id: string) => {
    rowActions.renameItem(id, renameValue);
    setRenamingId(null);
    setRenameValue("");
  }, [rowActions.renameItem, renameValue]);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue("");
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // A hidden tree stays mounted (the phone's home screen behind the
      // item screen) — don't react to keys meant for the visible one.
      if (!visibleRef.current) return;
      // The modal has its own inputs (name, git URL, share link) — arrow
      // keys there move the text cursor, not the row focus behind it.
      if (localModalOpen || createMachineId || rowActions.modalOpen) return;
      if (renamingId) return;
      // The whole-app gate must be unescapable: inert on .app-body (App.tsx)
      // starves elements of focus, but this is a document-level listener —
      // shouldHandleSidebarKey treats "nothing focused" (document.body) as
      // "focus is still here", so inert alone doesn't stop it. Check the
      // gate directly.
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      // Document-level, so it must bail when typing in an unrelated input,
      // or when focus has moved to another surface entirely (a terminal, an
      // editor) — see focus-guard.ts.
      if (!shouldHandleSidebarKey(containerRef.current, document.activeElement, document.body)) return;
      if (flatEntries.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const currentIdx = flatEntries.findIndex((entry) => entry.id === focusedId);
      const nextIdx =
        currentIdx < 0 ? 0 : (currentIdx + dir + flatEntries.length) % flatEntries.length;
      const nextEntry = flatEntries[nextIdx];
      // focusEntry, not handleClick: traversing the list is not navigating
      // to something, and firing onNavigate here would shut the narrow
      // drawer on the first ArrowDown (see focusEntry's doc comment).
      if (nextEntry) focusEntry(nextEntry.id);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    localModalOpen,
    createMachineId,
    rowActions.modalOpen,
    flatEntries,
    focusedId,
    focusEntry,
    renamingId,
  ]);

  const renderTileEntry = (entry: ItemListEntry) => (
    <SortableRow key={entry.id} id={entry.id} scopeId={rowScopeIds.get(entry.id) ?? ""} disabled={!rowScopeIds.has(entry.id)}>
      {(bind) => (
    <TileEntryRow
      entry={entry}
      focused={entry.id === focusedId}
      isRenaming={entry.id === renamingId}
      renameValue={entry.id === renamingId ? renameValue : ""}
      onClick={() => handleClick(entry.id)}
      onDoubleClick={() => handleDoubleClick(entry.id)}
      onContextMenu={(e) => { e.preventDefault(); void rowActions.itemMenu(entry.id, e); }}
      onRenameChange={setRenameValue}
      onRenameConfirm={() => commitRename(entry.id)}
      onRenameCancel={cancelRename}
      onClose={() => void closeEntry(entry.id)}
      showViewState={touchRows !== true}
      sortable={bind}
      worktreeLabel={nestedItemIds.has(entry.id) ? undefined : worktreeLabels.get(entry.id)}
      // An agent row in mini names its agent and worktree, not what it runs.
      hideLiveDetail={mini && harnessOf(entry.target) !== null}
    />
      )}
    </SortableRow>
  );

  // Renders one checkout row and the items living in that working copy.
  const renderCheckout = (checkout: CheckoutSection<ItemListEntry>, repository = false) => {
    const repo = checkout.repo;
    const unbuilt = repo.worktreeOf?.creation !== undefined;
    const unavailable = repo.kind !== "local";
    const rawStatus = resolveStatus(repo.id, reposState.statuses);
    const statusError = reposState.statuses[repo.id]?.error;
    const status = rawStatus;
    const openCheckout = (revealAll = false) => {
      handleSelectRepo(repo.id, revealAll);
      onNavigate?.();
    };
    // The mini layout draws checkouts only in its worktree view, grouped as in `sortableRows`.
    const parentId = repo.worktreeOf?.repoId ?? repo.id;
    const itemsScopeId = mini
      ? worktreeViewGroup({ machineId: machineOf(repo.id), scope: { kind: "repo-items", repoId: parentId } }, repo.id)
      : scopeId({ machineId: machineOf(repo.id), scope: { kind: "items", repoId: repo.id } });
    // The sortable node is the whole subtree, row plus items; the row is
    // its activator. A multi-checkout repo's primary checkout is not
    // sortable: it has no siblings of its own rank.
    const body = (bind?: SortableBind) => (
      <div data-checkout-id={repo.id} ref={bind?.setNodeRef} style={bind?.style}
        className={repository ? "repo-section single-checkout" : "checkout-group"}>
        <CheckoutRow
          repo={repo}
          sortable={bind}
          active={reposState.activeRepoId === repo.id}
          repository={repository}
          primary={checkout.primary}
          status={status}
          statusError={statusError}
          message={removalMessage(repo) ?? (rowMessage?.repoId === repo.id ? rowMessage : null)}
          onRetryRemoval={retryRemoval(repo)}
          disclosure={rowDisclosure(checkoutKey(repo.id), `checkout ${repo.name}`, checkout.entries.length > 0)}
          onClick={() => openCheckout()}
          onDoubleClick={() => openCheckout(true)}
          onContextMenu={(e) => {
            e.preventDefault();
            void (repository ? rowActions.repoMenu(repo, e) : rowActions.checkoutMenu(repo, e));
          }}
          onNewWorktree={repository && !unavailable ? () => handleNewWorktree(repo.id) : undefined}
          onOpenFiles={
            unbuilt || unavailable ? undefined : () => handleOpenFiles(repo)
          }
          onNewTerminal={unbuilt || unavailable ? undefined : () => void handlePickAgent(repo, "terminal")}
          onNewAgent={unbuilt || unavailable ? undefined : () => void handlePickAgent(repo)}
          fileDrop={
            unbuilt || unavailable
              ? undefined
              : {
                  active: dropRoot === virtualRootFor(repo),
                  onDragOver: (e) => {
                    if (!carriesFiles(e.dataTransfer)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    setDropRoot(virtualRootFor(repo));
                  },
                  onDragLeave: () =>
                    setDropRoot((cur) => (cur === virtualRootFor(repo) ? null : cur)),
                  onDrop: (e) => {
                    if (!carriesFiles(e.dataTransfer)) return;
                    e.preventDefault();
                    setDropRoot(null);
                    // Synchronous, before any await — a DataTransfer is
                    // emptied once the event finishes dispatching (see
                    // Terminal/file-drop.ts).
                    const { files, folderNames } = dropContents(e.dataTransfer);
                    if (files.length === 0 && folderNames.length === 0) return;
                    importFiles(files, folderNames, virtualRootFor(repo));
                  },
                }
          }
        />
        {!collapsed.has(checkoutKey(repo.id)) && (
        <SortableContext items={siblingIndex.get(itemsScopeId) ?? []} strategy={verticalListSortingStrategy}>
        <div className="checkout-items" id={disclosureRegionId(checkoutKey(repo.id))} data-sortable-container={itemsScopeId}>
          {checkout.entries.map(renderTileEntry)}

        </div>
        </SortableContext>
        )}
      </div>
    );
    return repository || !checkout.primary
      ? <SortableRow key={repo.id} id={repo.id} scopeId={rowScopeIds.get(repo.id) ?? ""} disabled={!rowScopeIds.has(repo.id)}>{body}</SortableRow>
      : <Fragment key={repo.id}>{body()}</Fragment>;
  };

  /**
   * A repo and its checkouts. The checkouts share a left rail rather than an
   * indent step: they all sit at one x, so the branch names read as a column
   * instead of a staircase, and the level the primary-checkout row costs is
   * paid for by the machine header leaving the tree.
   *
   * Only ever called with a section whose repo came from localSections /
   * cloudSections, both filtered on `kind`.
   */
  const renderRepoSection = (section: RepoSection<ItemListEntry>) => section.checkouts.length === 1 && section.checkouts[0]!.primary
    ? renderCheckout(section.checkouts[0]!, true)
    : (
    <SortableRow key={section.repo.id} id={section.repo.id} scopeId={rowScopeIds.get(section.repo.id) ?? ""} disabled={!rowScopeIds.has(section.repo.id)}>
      {(bind) => (
    <div className="repo-section" ref={bind.setNodeRef} style={bind.style}>
      <RepoRow
        repo={section.repo}
        sortable={bind}
        message={removalMessage(section.repo) ?? (rowMessage?.repoId === section.repo.id ? rowMessage : null)}
        onRetryRemoval={retryRemoval(section.repo)}
        onClick={() => {
          handleSelectRepo(section.repo.id);
          onNavigate?.();
        }}
        onContextMenu={(e) => { e.preventDefault(); void rowActions.repoMenu(section.repo, e); }}
        onNewWorktree={section.repo.kind !== "local" ? undefined : () => handleNewWorktree(section.repo.id)}
        disclosure={rowDisclosure(repoKey(section.repo.id), `repo ${section.repo.name}`, true)}
      />
      {!collapsed.has(repoKey(section.repo.id)) && (
        <SortableContext items={siblingIndex.get(scopeId({ machineId: machineOf(section.repo.id), scope: { kind: "worktrees", parentId: section.repo.id } })) ?? []} strategy={verticalListSortingStrategy}>
          <div className="checkout-rail" id={disclosureRegionId(repoKey(section.repo.id))}
            data-sortable-container={scopeId({ machineId: machineOf(section.repo.id), scope: { kind: "worktrees", parentId: section.repo.id } })}>
            {section.checkouts.map((checkout) => renderCheckout(checkout))}
          </div>
        </SortableContext>
      )}
    </div>
      )}
    </SortableRow>
  );

  /**
   * The mini layout's repo: one row, its terminals flat beneath it in
   * catalog document order. Its worktrees are labels on those terminals,
   * never rows, so one repo-items scope orders them all.
   */
  const renderMiniRepo = (section: MiniDisplay) => {
    const repo = section.repo;
    const worktreesScope = scopeId({ machineId: machineOf(repo.id), scope: { kind: "worktrees", parentId: repo.id } });
    const unavailable = repo.kind !== "local";
    const key = repoKey(repo.id);
    const itemsScope = scopeId({ machineId: machineOf(repo.id), scope: { kind: "repo-items", repoId: repo.id } });
    return (
      <SortableRow key={repo.id} id={repo.id} scopeId={rowScopeIds.get(repo.id) ?? ""} disabled={!rowScopeIds.has(repo.id)}>
        {(bind) => (
          <div className="mini-repo" ref={bind.setNodeRef} style={bind.style}>
            <MiniRepoRow
              repo={repo}
              sortable={bind}
              active={activeTopLevelRepoId === repo.id}
              message={removalMessage(repo) ?? (rowMessage?.repoId === repo.id ? rowMessage : null)}
              disclosure={rowDisclosure(key, `repo ${repo.name}`, section.entries.length > 0 || section.worktrees !== null)}
              onClick={() => { handleSelectRepo(repo.id); onNavigate?.(); }}
              onContextMenu={(e) => { e.preventDefault(); void rowActions.repoMenu(repo, e); }}
              onRetryRemoval={retryRemoval(repo)}
              onNewAgent={unavailable ? undefined : () => void handlePickAgent(repo)}
              onNewTerminal={unavailable ? undefined : () => void handlePickAgent(repo, "terminal")}
              // Phones get no file browser (MobileHome's one deliberate subtraction).
              onOpenFiles={unavailable || touchRows ? undefined : () => handleOpenFiles(repo)}
              worktreeView={!touchRows && showWorktrees === undefined
                ? { on: section.worktrees !== null, onToggle: () => toggleWorktreeView(repo.id) }
                : undefined}
            />
            {!collapsed.has(key) && section.worktrees && (
              <SortableContext items={siblingIndex.get(worktreesScope) ?? []} strategy={verticalListSortingStrategy}>
                <div className="mini-worktree-rail" id={disclosureRegionId(key)} data-sortable-container={worktreesScope}>
                  {section.worktrees.checkouts.map((checkout) => renderCheckout(checkout))}
                </div>
              </SortableContext>
            )}
            {!collapsed.has(key) && !section.worktrees && (
              <SortableContext items={siblingIndex.get(itemsScope) ?? []} strategy={verticalListSortingStrategy}>
                <div className="mini-repo-items" id={disclosureRegionId(key)} data-sortable-container={itemsScope}>
                  {section.entries.map(renderTileEntry)}
                </div>
              </SortableContext>
            )}
          </div>
        )}
      </SortableRow>
    );
  };

  // Studio keeps its actions and Repos heading outside the scrolling tree.
  // The navigator's titled pages retain their own section layout.
  const fixedRepoHeader = !!repoListHeader && !touchRows;
  const repoListScroll = (list: React.ReactNode) => fixedRepoHeader
    ? <div className="repos-body-scroll scrollbar-hover">{list}</div>
    : machineTitle
      ? <div className="machine-page-section machine-page-section-repos"><div className="machine-page-repos">{list}</div></div>
      : list;

  const unscopedDisclosure = rowDisclosure(UNSCOPED_KEY, "unscoped", true);

  const renderUnscoped = (kind: "cloud" | "local" | "all") => {
    const pageEntries = unscopedEntries.filter(entry => kind === "all"
      || (catalog.items.find(item => item.id === entry.id)?.machineId === LOCAL_MACHINE_ID ? "local" : "cloud") === kind);
    if (pageEntries.length === 0) return null;
    const pageIds = new Set(pageEntries.map(entry => entry.id));
    const regionId = `${disclosureRegionId(UNSCOPED_KEY)}-${kind}`;
    return (
          <div className="unscoped-group">
            {!groupUnscopedByDirectory && <div className="unscoped-header">
              <span className="row-name">Unscoped</span>
              {unscopedDisclosure && !unscopedDisclosure.expanded && <HiddenSummary {...hiddenSummary(UNSCOPED_KEY, pageEntries, ancestorsOf)} />}
              {unscopedDisclosure && (
                <DisclosureButton
                  expanded={unscopedDisclosure.expanded}
                  label={unscopedDisclosure.label}
                  controls={regionId}
                  onToggle={unscopedDisclosure.onToggle}
                />
              )}
              {rowMessage?.repoId === null && (
                <span
                  className={`row-detail${rowMessage.isError ? " error" : ""}`}
                  title={rowMessage.text}
                >
                  {rowMessage.text}
                </span>
              )}
            </div>}
            {groupUnscopedByDirectory && rowMessage?.repoId === null && <span className={`row-detail${rowMessage.isError ? " error" : ""}`} title={rowMessage.text}>{rowMessage.text}</span>}
            {!collapsed.has(UNSCOPED_KEY) && (
              groupUnscopedByDirectory ? <div id={regionId}>
                {directoryGroups.filter(group => group.entries.some(entry => pageIds.has(entry.id))).map(group => {
                  const key = directoryKey(group.key);
                  const disclosure = rowDisclosure(key, group.path, true);
                  return <div className="unscoped-directory mini-repo" key={group.key} data-unscoped-directory={group.path}>
                    <MiniFolderRow className="unscoped-directory-heading" name={<em>{group.path}</em>} iconTitle="Directory"
                      title={group.path} disclosure={disclosure} onClick={disclosure?.onToggle} />
                    {!collapsed.has(key) && <SortableContext items={group.entries.map(entry => entry.id)} strategy={verticalListSortingStrategy}>
                      <div className="mini-repo-items" id={disclosureRegionId(key)} data-sortable-container={group.key}>{group.entries.map(renderTileEntry)}</div>
                    </SortableContext>}
                  </div>;
                })}
              </div> : <SortableContext items={pageEntries.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
                <div id={regionId} data-sortable-container="unscoped">{pageEntries.map(renderTileEntry)}</div>
              </SortableContext>
            )}
          </div>
    );
  };
  return (
    <>
      {/* Window-chrome actions, kept out of .repos-list so they can sit in
          the titlebar strip beside the traffic lights (see Sidebar.css) rather
          than scroll with the repo rows. */}
      {/* Settings moved to the footer (#57); what stays here is transient
          by nature — a grace-period notice and an update offer, both of
          which render nothing most of the time. */}
      {/* Only the grace-period banner lives up here now: the update pill
          moved to the footer beside the gear (#96), so this band is purely
          transient-notice space. */}
      <div className="repos-sidebar-actions">
        {!touchRows && <HistoryArrows />}
      </div>
      <div className={`repos-list scrollbar-hover${fixedRepoHeader ? " repos-list-fixed-header" : ""}`} ref={containerRef}
        onScroll={event => {
          const list = event.currentTarget;
          list.style.setProperty("--repos-top-opacity", String(1 - Math.min(Math.max(list.scrollTop, 0) / 8, 1)));
        }}>
        {/* The machine header is hidden unless it has something to say
            (desktop/Desktop.tsx); its New repo action is a row of the
            strip instead. */}
        {touchRows && <SidebarSections
          onAddRepo={() => {
            void chooseRepoAction(LOCAL_MACHINE_ID);
          }}
        />}
        {/* One drag context for every sibling set (spec §2.6). The
            accessibility container keeps dnd-kit's live region out of the
            list's own children. */}
        <DndContext
          sensors={sensors}
          accessibility={{ container: document.body }}
          collisionDetection={scopedCollisionDetection}
          onDragStart={({ active }) => dragController.start(String(active.id))}
          onDragEnd={({ active, over }) => void dragController.end(String(active.id), over ? String(over.id) : null)}
          onDragCancel={() => dragController.cancel()}
        >
        <AddLocalRepoModal open={localModalOpen} onClose={() => setLocalModalOpen(false)} />
        {createMachineId && <CreateRepoModal machineId={createMachineId} onCreated={repo => setActiveRepo(repo.id)} onClose={() => setCreateMachineId(null)} />}
        {rowActions.modals}
        {/* Both trees stay mounted for native horizontal paging. Keyboard
            traversal and interaction belong only to the selected page. */}
        {/* A lone cloud page keeps the pages layout too: it is what gives a
            page its edge padding, reserved scrollbar gutter and per-tab
            scrolling, with nothing to swipe to. Only the phone list stacks. */}
        <div ref={machinePagesRef} className={touchRows ? "sidebar-machine-stack" : "sidebar-machine-pages"}>
        {/* The whole section, header included — a browser has no local
            machine to name. Leaving the header behind (with only its add
            affordances gated) put a "Local machine" label and a status dot
            over nothing, reporting on a daemon a tab cannot reach. */}
        {(machinePages || showLocalSection) && (
          <div className="machine-section machine-section-local scrollbar-hover" inert={machinePages && !showLocalSection}>
            {machineTitle?.("local")}
            {machineBody?.("local") ?? <>
            {machineHeader?.("local")}
            {!hideRepos && <>
            {machineHeader && !repoListHeader && <div className="sidebar-repos-heading">Repos</div>}
            {!touchRows && <SidebarSections onAddRepo={() => { void chooseRepoAction(LOCAL_MACHINE_ID); }}>{machineActions?.("local")}</SidebarSections>}
            {repoListHeader}
            {repoListScroll(<>
            <MachineHeaderRow
              kind="local"
              name={kindLabel("local")}
              status={resolveStatus(LOCAL_MACHINE_ID, reposState.statuses)}
              statusError={reposState.statuses[LOCAL_MACHINE_ID]?.error}
              message={rowMessage?.repoId === LOCAL_MACHINE_ID ? rowMessage : null}
              onAdd={() => void chooseRepoAction(LOCAL_MACHINE_ID)}
              disclosure={rowDisclosure(machineKey(LOCAL_MACHINE_ID), kindLabel("local"), localSections.length > 0 || localMachineEntries.length > 0)}
            />
            {!collapsed.has(machineKey(LOCAL_MACHINE_ID)) && (
              <>
                {localMachineEntries.length > 0 && (
                  <SortableContext items={localMachineEntries.map(entry => entry.id)} strategy={verticalListSortingStrategy}>
                    <div className="machine-sites" data-sortable-container="local-machine-items">{localMachineEntries.map(renderTileEntry)}</div>
                  </SortableContext>
                )}
                <SortableContext items={siblingIndex.get(scopeId({ machineId: LOCAL_MACHINE_ID, scope: { kind: "repos" } })) ?? []} strategy={verticalListSortingStrategy}>
                  <div className="machine-section-repos" id={disclosureRegionId(machineKey(LOCAL_MACHINE_ID))}
                    data-sortable-container={scopeId({ machineId: LOCAL_MACHINE_ID, scope: { kind: "repos" } })}>
                    {mini ? localMini.map(renderMiniRepo) : localSections.map(renderRepoSection)}
                  </div>
                </SortableContext>
              </>
            )}
            {/* A second entry point into the same local-add flow as the
                header's "+", and the reason the "+" gate above survives:
                both are inside a section this host does have. */}
            {!mini && !collapsed.has(machineKey(LOCAL_MACHINE_ID)) && localSectionEmptyText(localSections.length) && (
              <MachineAddButton
                label={localSectionEmptyText(localSections.length)!}
                onClick={() => void chooseRepoAction(LOCAL_MACHINE_ID)}
              />
            )}
            {!touchRows && renderUnscoped("local")}
            </>)}
            </>}
            </>}
          </div>
        )}
        </div>
        {touchRows && renderUnscoped("all")}
        </DndContext>
      </div>
      <TransferStrip
        hint={
          dropRoot !== null
            ? dropHintText("sidebar", { remote: isCloudPath(dropRoot) })
            : null
        }
        transfer={transfer}
        onDismiss={dismissTransfer}
      />
    </>
  );
}

export default ReposSidebar;
