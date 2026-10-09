import { revealTileInSidebar } from "../state/sidebar-tile-reveal";
// The rail: viewport-fitted worktree columns, each a
// vertical stack of panes (heights are viewport-height ratios summing to 1
// per column — see layout-ops.ts). Replaces ItemHost.
//
// Keep-alive contract: every MOUNTED item — paned or merely mounted (see
// workspace.ts's `mountedItemIds`) — renders exactly one slot div keyed by
// item.id, as a direct child of .rail-content in stable mount order.
// Column membership is expressed ONLY through inline geometry styles,
// never through React tree position, so moving a pane between columns
// re-styles the same DOM node instead of remounting it (editors and
// terminals keep their state). A mounted-but-unpaned id gets a slot at
// `display:none` (via `slotStyle`'s own undefined-rect branch) — the
// hidden case, same unbounded keep-alive rationale as before Task 9.
// Independent screen viewers (HTML artifacts, images, PDFs and file trees)
// instead keep one stable slot per placement. Closing their placement
// unmounts that view; other placements keep their own state and DOM.
//
// An item that is neither paned nor mounted gets NO slot at all: since the
// catalog now surfaces every machine item — including ones this client has
// never opened — mounting all of them would spawn a pty connection (for a
// term item) this client never asked for. Only `focusItem`
// (state/workspace.ts) adds an id to `mountedItemIds`, and only when this
// client actually opens/reveals it.
//
// Resize handles (column edge, pane seam) are chrome, not item slots: they
// render as siblings of the slots inside .rail-content, from the same
// geometry pass, and are free to remount on every render — the keep-alive
// contract only constrains the item slots above.
import { AttentionDot } from "../attention/AttentionDot";
import { useItemAttention } from "../attention/store";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SHORTCUT_ACCELERATORS } from "@port/shared/shortcuts";
import { splitFilepath } from "@port/shared/filepath";
import { Cloud } from '@phosphor-icons/react/dist/csr/Cloud';
import { CornersIn } from '@phosphor-icons/react/dist/csr/CornersIn';
import { CornersOut } from '@phosphor-icons/react/dist/csr/CornersOut';
import { X } from '@phosphor-icons/react/dist/csr/X';
import type { OwnedItem } from "@port/shared/catalog";
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { useWorkspace, activeScreen, hideItem, moveItem, moveItemToScreen, reconcile, resizeColumn, resizePane, resizeScreenDivider, setActiveItem, setActiveView, unmountItem, workspaceStore, type TreePaneRecord } from "../state/workspace";
import { resizeScreenDivider as resizeScreenDividerOp, screenToPixelColumns, MIN_COLUMN_RATIO, type Screen } from "../state/screen-ops";
import { sweepExitedOnAttach, useCatalog } from "../state/catalog";
import { getLiveState } from "../state/live-status";
import { setActive as setActiveRepo, useRepos } from "../state/repos";
import { services } from "../services";
import { useSidebarFocus, clearSidebarFocus } from "../state/sidebar-focus";
import { effectiveNarrowView, setPaneZoomed, togglePaneZoom, useUiState } from "../state/ui";
import { RAIL_TRAILING_BUFFER_PX, railGeometry, resizeColumnWidth, resizePaneRatio, resolveDropTarget, type Column, type DropIndicator, type MoveTarget, type PaneRect } from "../state/layout-ops";
import { onItemFocus } from "../state/item-focus";
import { setScreenViewportProvider } from "../state/screen-viewport-size";
import { paneCaretTarget } from "./pane-caret";
import { canDuplicatePane, fittedRailWidth, paneTitle, panedItemIds, RAIL_GUTTER_PX, slotVisible } from "./rail-slot";
import { PaneSkeleton } from "./PaneSkeleton";
import { resolveStatus, type DotStatus } from "../sidebar/group-entries";
import { useIsNarrow } from "../hooks/useIsNarrow";
import { ContainedErrorBoundary } from "../ErrorBoundary";
import { startPointerDrag } from "./use-pointer-drag";
import { canConsumeHorizontalWheel, createScreenScroller } from "./screen-scroll";
import { setScreenScrollPosition } from "../state/screen-scroll-position";
import { setScreenLayoutPreview } from "../state/screen-layout-preview";
import { takeInstantScreenNavigation } from "../state/screen-navigation";
import { requestItemFocus } from "../state/item-focus";
import { FileItem } from "./FileItem";
import { ArtifactItem } from "./ArtifactItem";
import { canCopyArtifactUrl, copyArtifactUrl, openArtifactInBrowser } from "./artifact-urls";
import { TerminalItem } from "./TerminalItem";
import { TerminalHeaderIcon } from "./TerminalHeaderIcon";
import { FileTreeItem } from "./FileTreeItem";
import { isCloudPath } from "./cloud-placeholder";
import { EmptyState } from "./EmptyState";

type ColumnOverride =
  | { kind: "px"; columnId: string; widthPx: number }
  | { kind: "ratio"; columnId: string; deltaRatio: number; minRatio: number }
  | null;
type SeamOverride = { columnId: string; seamIndex: number; deltaRatio: number } | null;

interface SeamHandleGeometry {
  seamIndex: number;
  topFr: number;
}

interface ColumnHandleGeometry {
  columnId: string;
  leftPx: number;
  widthPx: number;
  seams: SeamHandleGeometry[];
}

/** One entry per column: its edge position plus every pane-seam position. */
function columnHandleGeometry(columns: Column[]): ColumnHandleGeometry[] {
  const out: ColumnHandleGeometry[] = [];
  let leftPx = 0;
  for (const column of columns) {
    const seams: SeamHandleGeometry[] = [];
    let cumFr = 0;
    for (let i = 0; i < column.panes.length - 1; i++) {
      cumFr += column.panes[i]!.heightRatio;
      seams.push({ seamIndex: i, topFr: cumFr });
    }
    out.push({ columnId: column.id, leftPx, widthPx: column.widthPx, seams });
    leftPx += column.widthPx;
  }
  return out;
}

/** Rail-coordinate drop lookup for the pointer's current position. */
function resolveDrop(
  rail: HTMLDivElement,
  columns: Column[],
  clientX: number,
  clientY: number,
  pageOffset = 0,
): { target: MoveTarget; indicator: DropIndicator } | null {
  const railBox = rail.getBoundingClientRect();
  const contentX = clientX - railBox.left + rail.scrollLeft - pageOffset;
  const yFr = Math.min(1, Math.max(0, (clientY - railBox.top) / railBox.height));
  const drop = resolveDropTarget(columns, contentX, yFr);
  return drop ? { ...drop, indicator: { ...drop.indicator, leftPx: drop.indicator.leftPx + pageOffset } } : null;
}

const SCREEN_DRAG_DWELL_MS = 300;

/** The visible tab under a pointer, measured live so an overflowing strip can scroll mid-drag. */
function screenTabAtPoint(clientX: number, clientY: number): HTMLElement | null {
  for (const tab of document.querySelectorAll<HTMLElement>("[data-screen-id]")) {
    const box = tab.getBoundingClientRect();
    const scroll = tab.closest<HTMLElement>(".view-switcher-scroll");
    const visibleBox = scroll?.getBoundingClientRect();
    if (
      clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom
      && (!visibleBox || (
        clientX >= visibleBox.left && clientX <= visibleBox.right
        && clientY >= visibleBox.top && clientY <= visibleBox.bottom
      ))
    ) {
      return tab;
    }
  }
  return null;
}

function ItemView({ item, visible, active, onFocus, frameKey }: { item: OwnedItem; visible: boolean; active: boolean; onFocus: () => void; frameKey: string }) {
  if (item.type === "term") return <TerminalItem item={item} visible={visible} focused={active} />;
  if (item.type === "artifact") return <ArtifactItem item={item} visible={visible} onFocus={onFocus} />;
  return <FileItem item={item} visible={visible} onFocus={onFocus} />;
}

function slotStyle(rect: PaneRect | undefined): React.CSSProperties {
  if (!rect) return { display: "none" };
  return {
    left: rect.leftPx,
    width: rect.widthPx,
    top: `${rect.topFr * 100}%`,
    height: `${rect.heightFr * 100}%`,
  };
}

export { RAIL_GUTTER_PX } from "./rail-slot";

/**
 * Narrow mode's zoomed geometry. Percentage-based, unlike the desktop
 * zoom's measured `railRef.current.clientWidth`: the narrow rail never
 * scrolls (.rail-narrow + .rail-zoomed both pin overflow), so there is no
 * scroll offset to compensate for and no measurement to re-take on resize.
 * (The percentages are of `.rail-content`'s padding box, which is why they
 * carry the gutter correction too — see RAIL_GUTTER_PX.)
 */
const NARROW_ZOOM_STYLE: React.CSSProperties = {
  left: -RAIL_GUTTER_PX,
  width: `calc(100% + ${RAIL_GUTTER_PX * 2}px)`,
  top: -RAIL_GUTTER_PX,
  height: `calc(100% + ${RAIL_GUTTER_PX * 2}px)`,
  zIndex: 10,
};

/**
 * The badge's state for one pane: null for a local pane (no badge), else
 * the machine's repo:status — downgraded to "connecting" for a terminal
 * whose session does not exist yet. The catalog persists a term item
 * BEFORE its pty spawns (cubed's openCatalogItem contract), so a
 * just-created cloud terminal sits showing "Starting…" with the machine
 * socket already open; a green dot beside that banner reads as a lie.
 * The machine being reachable is necessary but not sufficient — the pane
 * is "connected" only once ITS session is real. An exited session keeps
 * the plain machine status: its pane already shows an explicit ended
 * banner, and the machine genuinely is fine.
 */
export function paneCloudStatus(
  item: OwnedItem,
  statuses: Parameters<typeof resolveStatus>[1],
): DotStatus | null {
  if (item.machineId === LOCAL_MACHINE_ID) return null;
  const machine = resolveStatus(item.machineId, statuses);
  // An `agent` item is pending on exactly the same terms as a `term`: its
  // row is persisted before the adapter is spawned (cubed's
  // `openCatalogItem`), so a green dot beside "Starting claude…" would be
  // the same lie.
  const sessionPending =
    (item.type === "term" || item.type === "agent")
    && item.ptySessionId === undefined
    && item.exitedAt === undefined;
  return machine === "open" && sessionPending ? "connecting" : machine;
}

/**
 * The provenance badge's state for a tree pane — same badge language as
 * `paneCloudStatus`, but a tree pane has no `machineId` of its own to key
 * off: only a repo-rooted pane on a cloud path can be "not there yet", so a
 * pane with no repo (opened outside any) or one whose root isn't a cloud
 * path gets no badge, same absence-as-local principle as an item pane.
 */
export function treePaneCloudStatus(
  pane: TreePaneRecord,
  statuses: Parameters<typeof resolveStatus>[1],
): DotStatus | null {
  if (pane.repoId === null || !isCloudPath(pane.root)) return null;
  return resolveStatus(pane.repoId, statuses);
}

/**
 * Accessible names for the provenance badge, one per DotStatus. Spoken (and
 * hover-shown) text, because the dot alone is a color — never the only
 * carrier of the state. "closed"/"unknown" both read as plain "Cloud":
 * resolveStatus's own doc comment forbids claiming "closed" for a machine
 * the shell merely hasn't heard from, and either way the actionable fact
 * for the user is just "this pane is remote".
 */
const PROVENANCE_LABELS: Record<DotStatus, string> = {
  open: "Cloud — connected",
  connecting: "Cloud — connecting",
  error: "Cloud — unreachable",
  closed: "Cloud",
  unknown: "Cloud",
};

function PaneHeader({
  itemId,
  title,
  cloudStatus,
  zoomed,
  zoomable,
  onPointerDown,
  conversationHeaderRef,
  terminal,
  hideLabel = "Hide",
  onHide,
  onZoom,
}: {
  /** The rail id this header belongs to — a catalog item id or a `tree:` pane id. */
  itemId: string;
  /** The pane header's title — an item's `paneTitle`, or a tree pane's own `name`. */
  title: string;
  /**
   * Null for a local pane — which renders NO badge, deliberately.
   * nav-status.ts states the principle: only cloud repos can be "not
   * there yet"; a local repo's files are on this disk whatever the
   * daemon is doing. Absence-as-local keeps headers quiet for the common
   * case and makes the cloud marker actually register (#15).
   */
  cloudStatus: DotStatus | null;
  zoomed: boolean;
  /**
   * Kept as a prop even though the header now renders on the wide layout
   * only (Rail's slot render gates it on !isNarrow — list-first gave the
   * narrow item screen its own MobileItemHeader instead), so a future
   * surface that wants a zoom-less header doesn't have to re-thread it.
   */
  zoomable: boolean;
  onHide?: () => void;
  hideLabel?: string;
  onZoom?: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  conversationHeaderRef?: React.RefCallback<HTMLDivElement> | undefined;
  terminal?: { target?: string } | undefined;
}) {
  const attention = useItemAttention(itemId);
  return (
    <div
      className={`rail-pane-header pane-chrome-header${conversationHeaderRef ? " pane-conversation-header" : ""}`}
      onPointerDown={onPointerDown}
    >
      {terminal ? <TerminalHeaderIcon target={terminal.target} attention={attention} /> : <AttentionDot state={attention} />}
      {/* Connection health colors the cloud glyph itself. */}
      {!conversationHeaderRef && cloudStatus !== null && (
        <span
          className="rail-pane-provenance"
          data-status={cloudStatus}
          role="img"
          title={PROVENANCE_LABELS[cloudStatus]}
          aria-label={PROVENANCE_LABELS[cloudStatus]}
        >
          <Cloud size={12} weight="regular" />
        </span>
      )}
      {conversationHeaderRef
        ? <div className="agent-header-host" ref={conversationHeaderRef} data-placeholder={title} />
        : <span className="rail-pane-title pane-chrome-title">{title}</span>}
      {/* Zoom's only other entry points are the "zoom-pane" shortcut and the
          View menu item that sends it, so without this button the feature is
          invisible to anyone who hasn't found the keystroke. Clicking it on a
          pane that ISN'T active works too: the slot's own
          onPointerDownCapture activates the pane before toggling zoom. */}
      {/* Shared pane actions keep the same target size in both views. */}
      {zoomable && (
        <button
          type="button"
          className="rail-pane-action pane-chrome-action rail-pane-zoom"
          data-tooltip={zoomed ? "Exit full screen" : "Full screen"}
          data-shortcut={SHORTCUT_ACCELERATORS["zoom-pane"]}
          aria-label={zoomed ? "Exit full screen" : "Full screen"}
          onClick={onZoom ?? (() => togglePaneZoom())}
        >
          {zoomed ? <CornersIn size={12} weight="bold" /> : <CornersOut size={12} weight="bold" />}
        </button>
      )}
      <button
        type="button"
        className="rail-pane-action pane-chrome-action rail-pane-hide"
        data-tooltip={hideLabel}
        data-shortcut={SHORTCUT_ACCELERATORS["close-tile"]}
        aria-label={hideLabel}
        onClick={onHide ?? (() => hideItem(itemId))}
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}

const EDGE_HANDLE_WIDTH_PX = 6;

/**
 * What "put the caret in this item" resolves to inside a pane's body —
 * the item's own input target, in the order a pane offers one. Verbatim
 * from tile-manager.js's focusCanvasTile, so a terminal picked in either
 * view lands the caret in the same place (xterm's hidden helper textarea).
 */
const PANE_INPUT_TARGET =
  'textarea, input, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

// A handle straddles its column's right edge — half over this column, half
// past it — so the seam can be grabbed from either side. The last column's
// outer half lands in the RAIL_TRAILING_BUFFER_PX of scrollable space
// `.rail-content` keeps past `totalWidthPx`, which is what makes the
// straddle legal there too (without the buffer, that half would sit past
// the content box where the rail can never scroll).
function EdgeHandle({
  column,
  onPointerDown,
}: {
  column: ColumnHandleGeometry;
  onPointerDown: (columnId: string, baseWidthPx: number) => (e: React.PointerEvent) => void;
}) {
  const right = column.leftPx + column.widthPx;
  const left = right - EDGE_HANDLE_WIDTH_PX / 2;
  return (
    <div
      className="rail-edge-handle"
      style={{ left, width: EDGE_HANDLE_WIDTH_PX, top: 0, bottom: 0 }}
      onPointerDown={onPointerDown(column.columnId, column.widthPx)}
    />
  );
}

function SeamHandles({
  column,
  onPointerDown,
}: {
  column: ColumnHandleGeometry;
  onPointerDown: (columnId: string, seamIndex: number) => (e: React.PointerEvent) => void;
}) {
  return (
    <>
      {column.seams.map((seam) => (
        <div
          key={`seam-${column.columnId}-${seam.seamIndex}`}
          className="rail-seam-handle"
          style={{
            left: column.leftPx,
            width: column.widthPx,
            top: `calc(${seam.topFr * 100}% - 3px)`,
            height: 6,
          }}
          onPointerDown={onPointerDown(column.columnId, seam.seamIndex)}
        />
      ))}
    </>
  );
}

/**
 * The width a screen's ratio columns are projected into: the rail's client
 * width minus both gutters, re-measured on every size change while a
 * screen shows (a sidebar toggle resizes the rail with no window resize,
 * hence an observer rather than the zoom path's resize tick). 0 until the
 * first measurement — useLayoutEffect lands it before paint. happy-dom
 * (Rail.test.tsx) has no ResizeObserver; the one-shot measure still runs.
 */
function useFittedRailWidth(
  railRef: React.RefObject<HTMLDivElement | null>,
  fitted: boolean,
): number {
  const [widthPx, setWidthPx] = useState(0);
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!fitted || !rail) return;
    const measure = (): void => setWidthPx(fittedRailWidth(rail.clientWidth));
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(rail);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [railRef, fitted]);
  return widthPx;
}

export function Rail({ visible: workspaceVisible = true }: { visible?: boolean } = {}) {
  const ws = useWorkspace();
  const { columns, activeItemId, mountedItemIds, treePanes } = ws;
  const catalog = useCatalog();
  // Statuses ride the same repo:status broadcasts the sidebar's dots read;
  // the cloud machine reports under its own machine id (group-entries.ts's
  // machineHeaderStatus), which is exactly what an item's `machineId` is.
  const { statuses } = useRepos();
  const { paneZoomed, narrowView } = useUiState();
  const isNarrow = useIsNarrow();
  // Narrow mode IS zoom, held on — derived, never written back to the ui
  // store. A forced flag would fight every switcher tap, and `togglePaneZoom` would
  // be able to turn narrow mode off into an unusable multi-column rail.
  const sidebarFocus = useSidebarFocus();
  const soloItemId = sidebarFocus && mountedItemIds.includes(sidebarFocus) ? sidebarFocus : null;
  const effectiveZoomed = paneZoomed || isNarrow || soloItemId !== null;
  const railRef = useRef<HTMLDivElement>(null);
  const activeDragCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => activeDragCancelRef.current?.(), []);
  useLayoutEffect(() => setScreenViewportProvider(() => {
    const rail = railRef.current;
    if (!rail) return null;
    return {
      width: fittedRailWidth(rail.clientWidth),
      height: Math.max(0, rail.clientHeight - parseFloat(getComputedStyle(rail).paddingTop || "0") - 2 * RAIL_GUTTER_PX),
    };
  }), []);
  // Desktop lays out every screen on one native horizontal rail. Narrow
  // retains the active-screen projection and its single zoomed pane.
  const screen: Screen | null = activeScreen(ws);
  const fitted = screen !== null;
  const railWidthPx = useFittedRailWidth(railRef, fitted || soloItemId !== null);
  const screenRail = fitted && !isNarrow;
  const pageWidth = railWidthPx + 2 * RAIL_GUTTER_PX;
  // Keep the outgoing page in the rail until native navigation reaches its
  // replacement. Removing it first would rebase the viewport in one frame.
  const [presentation, setPresentation] = useState({ source: ws.screens, activeId: screen?.id, pages: ws.screens });
  let pageScreens = presentation.pages;
  if (presentation.source !== ws.screens || presentation.activeId !== screen?.id || (!screenRail && pageScreens !== ws.screens)) {
    const live = new Map(ws.screens.map(candidate => [candidate.id, candidate]));
    const closingCurrent = presentation.activeId !== undefined && !live.has(presentation.activeId);
    const alreadyClosing = presentation.pages.some(candidate => !presentation.source.some(previous => previous.id === candidate.id));
    pageScreens = screenRail && (closingCurrent || alreadyClosing)
      ? [...presentation.pages.map(candidate => live.get(candidate.id) ?? candidate),
        ...ws.screens.filter(candidate => !presentation.pages.some(previous => previous.id === candidate.id))]
      : ws.screens;
    setPresentation({ source: ws.screens, activeId: screen?.id, pages: pageScreens });
  }
  const activePageIndex = screen ? pageScreens.findIndex(candidate => candidate.id === screen.id) : 0;
  const activePageOffset = screenRail ? activePageIndex * pageWidth : 0;
  const [visiblePages, setVisiblePages] = useState<[number, number]>([activePageIndex, activePageIndex]);
  const [alignedScreenId, setAlignedScreenId] = useState(screen?.id ?? "");
  const screenScrollerRef = useRef<ReturnType<typeof createScreenScroller> | null>(null);
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const scroller = createScreenScroller(rail, id => {
      if (workspaceStore.getSnapshot().screens.some(candidate => candidate.id === id)) setActiveView(`screen:${id}`);
    }, (first, last) => setVisiblePages([first, last]), setScreenScrollPosition, (id, nativeScrollEnd) => {
      const snapshot = workspaceStore.getSnapshot();
      if (!snapshot.screens.some(candidate => candidate.id === id)) {
        // An interrupted closing slide can settle on its outgoing page.
        // Continue to a live neighbor once that native gesture has ended.
        const destination = activeScreen(snapshot);
        if (destination && nativeScrollEnd) screenScrollerRef.current?.navigate(destination.id);
        return;
      }
      setAlignedScreenId(id);
      setPresentation(previous => previous.pages === snapshot.screens ? previous
        : { source: snapshot.screens, activeId: activeScreen(snapshot)?.id, pages: snapshot.screens });
    });
    screenScrollerRef.current = scroller;
    return () => { scroller.destroy(); screenScrollerRef.current = null; };
  }, []);
  useLayoutEffect(() => {
    // A keyboard jump's or a screen reorder's one-shot mark
    // (screen-navigation.ts): honoured only when it names the screen now
    // active, discarded otherwise.
    const instantId = takeInstantScreenNavigation();
    screenScrollerRef.current?.update({
      ids: pageScreens.map(candidate => candidate.id), activeId: screen?.id ?? "",
      width: pageWidth, enabled: screenRail && !effectiveZoomed,
      behavior: instantId !== null && instantId === screen?.id ? "instant" : "smooth",
    });
  });
  const [colOverride, setColOverride] = useState<ColumnOverride>(null);
  const [seamOverride, setSeamOverride] = useState<SeamOverride>(null);
  const [drag, setDrag] = useState<{ itemId: string; clientX: number; clientY: number } | null>(
    null,
  );
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const [zoomLeftPx, setZoomLeftPx] = useState(0);
  const [, setResizeTick] = useState(0);
  const [browserMessage, setBrowserMessage] = useState<{ itemId: string; text: string } | null>(null);
  useEffect(() => {
    if (!browserMessage) return;
    const timer = setTimeout(() => setBrowserMessage(null), 8000);
    return () => clearTimeout(timer);
  }, [browserMessage]);

  const itemsById = useMemo(() => new Map(catalog.items.map(i => [i.id, i])), [catalog.items]);

  // Prunes this client's arrangement whenever an accepted catalog snapshot
  // lands — see reconcileColumns' own doc comment (layout-ops.ts). A no-op
  // (same state reference, no notify) once the arrangement already agrees
  // with the catalog, so this is safe to run on every catalog change.
  useEffect(() => {
    reconcile(new Set(catalog.items.map((i) => i.id)));
  }, [catalog.items]);

  // Sweeps exited terminals this client was displaying, plus persona
  // workers even if nobody opened their tile. Other unmounted terminals
  // are kept: a session that died overnight should still be visible in
  // the morning rather than silently gone. An item whose pty a ptyd restart
  // took, or one this client's own tile is already respawning, is likewise kept — see
  // sweepExitedOnAttach's own doc comment (catalog.ts) for both.
  useEffect(() => {
    const recovering = new Set(mountedItemIds.filter((id) => getLiveState(id).recovering));
    const swept = sweepExitedOnAttach(catalog.items, new Set(mountedItemIds), recovering);
    for (const item of swept) {
      unmountItem(item.id);
      void services.catalog.removeItem(item.machineId, item.id).catch((err: unknown) => {
        console.error(`[rail] sweep of exited item ${item.id} failed: ${String(err)}`);
      });
    }
  }, [catalog.items, mountedItemIds]);

  // Visual pane order for the current columns or fitted screen.
  const paneItemIds = useMemo(
    () => screenRail ? pageScreens.flatMap(candidate => panedItemIds(candidate.columns)) : panedItemIds(screen ? screen.columns : columns),
    [columns, screen, screenRail, pageScreens],
  );

  // Keep DOM order independent of layout: reinserting a keyed slot reloads
  // descendant iframes even though React preserves their element identity.
  // mountedItemIds stays stable across moves/hides; append any not-yet-mounted
  // panes defensively. An id neither paned nor mounted (another
  // client's item, or one this client has never opened) gets no slot. An
  // id a slot references but the catalog doesn't (yet) know about — a
  // brief window right after a new item's own creation call resolves,
  // before its broadcast has landed in the catalog store — renders no slot
  // rather than crashing; `reconcile` above prunes any id that turns out
  // to be genuinely gone once the catalog is heard from.
  const slotOrder = useRef<string[]>([]);
  const slotIds = useMemo(() => {
    const needed = new Set([...mountedItemIds, ...paneItemIds]);
    // A shell-first app can later gain a narrow Workspace placement. Preserve
    // DOM order through that handoff: reinserting an iframe reloads its document.
    const next = slotOrder.current.filter(id => needed.has(id));
    const existing = new Set(next);
    next.push(...[...needed].filter(id => !existing.has(id)));
    slotOrder.current = next;
    return next;
  }, [paneItemIds, mountedItemIds]);

  // Zoom (Task 11's "zoom-pane" shortcut): captures the rail's current
  // scroll offset the moment zoom engages, so the zoomed slot lands exactly
  // over the pane's un-zoomed on-screen position instead of jumping to the
  // rail's origin. Fullscreen follows the active tile within this screen;
  // opening an item still places it in the layout underneath. Switching
  // screens restores the normal layout.
  //
  // Also re-captures on every breakpoint crossing, not just on engage: a
  // narrow rail is one viewport wide and cannot scroll, so the browser
  // clamps scrollLeft to 0 on the way in. Widening again with `paneZoomed`
  // still true would otherwise render the slot at the offset captured
  // before the crossing — a zoomed pane sitting off to the right of where
  // it belongs. `isNarrow` in the deps re-reads the (now clamped) offset.
  useEffect(() => {
    if ((paneZoomed || soloItemId) && railRef.current) setZoomLeftPx(railRef.current.scrollLeft);
  }, [paneZoomed, soloItemId, isNarrow, railWidthPx]);
  useEffect(() => {
    setPaneZoomed(false);
  }, [ws.activeView]);
  useEffect(() => {
    if (activeItemId === null) setPaneZoomed(false);
  }, [activeItemId]);

  // The zoomed slot's width reads railRef.current.clientWidth directly
  // during render (below); a window resize doesn't itself trigger a
  // re-render, so without this the zoomed pane would keep the viewport
  // width it had when zoom engaged. Only wired while zoomed.
  useEffect(() => {
    if (!paneZoomed) return;
    const onResize = (): void => setResizeTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [paneZoomed]);

  // Kept fresh every render so the pointerdown-time closures in
  // onHeaderPointerDown (wired once per gesture via startPointerDrag's
  // native listeners) can read live columns instead of the drag-start
  // snapshot — a column can change mid-drag (e.g. a pty exit removes it).
  // Holds `effectiveColumns` (pixel space, set below once it exists):
  // resolveDrop works in rail pixel coordinates, and a screen's own
  // columns carry ratio widths, not pixels.
  const columnsRef = useRef<Column[]>(columns);
  const zoomedRef = useRef(effectiveZoomed);
  zoomedRef.current = effectiveZoomed;
  const fittedRef = useRef(fitted);
  fittedRef.current = fitted;
  const narrowRef = useRef(isNarrow);
  narrowRef.current = isNarrow;

  // The legacy rail's pan handler remains for raw column layouts. The screen
  // scroller handles the same continuous pan plus alignment after input ends.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const onWheel = (event: WheelEvent): void => {
      if (zoomedRef.current || narrowRef.current || fittedRef.current) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      if (canConsumeHorizontalWheel(event.target, rail, event.deltaX)) return;
      rail.scrollLeft += event.deltaX;
      event.preventDefault();
      event.stopPropagation();
    };
    rail.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => rail.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  const effectiveColumns = useMemo(() => {
    let cols: Column[];
    if (screen !== null) {
      const scr =
        colOverride?.kind === "ratio"
          ? resizeScreenDividerOp(screen, colOverride.columnId, colOverride.deltaRatio, colOverride.minRatio)
          : screen;
      cols = screenToPixelColumns(scr, railWidthPx);
    } else {
      cols = columns;
      if (colOverride?.kind === "px") {
        cols = resizeColumnWidth(cols, colOverride.columnId, colOverride.widthPx);
      }
    }
    if (seamOverride) {
      cols = resizePaneRatio(
        cols,
        seamOverride.columnId,
        seamOverride.seamIndex,
        seamOverride.deltaRatio,
      );
    }
    return cols;
  }, [columns, screen, railWidthPx, colOverride, seamOverride]);
  // resolveDrop (onHeaderPointerDown) needs pixel-space columns, which is
  // exactly what effectiveColumns always is — a screen has already been
  // projected above.
  columnsRef.current = effectiveColumns;

  // The same in-gesture override, kept in ratio space for the screen strip,
  // so its indicator tracks a divider or seam drag instead of the drop.
  const previewScreenColumns = useMemo(() => {
    if (screen === null || (colOverride?.kind !== "ratio" && !seamOverride)) return null;
    let cols = colOverride?.kind === "ratio"
      ? resizeScreenDividerOp(screen, colOverride.columnId, colOverride.deltaRatio, colOverride.minRatio).columns
      : screen.columns;
    if (seamOverride) cols = resizePaneRatio(cols, seamOverride.columnId, seamOverride.seamIndex, seamOverride.deltaRatio);
    return { screenId: screen.id, columns: cols };
  }, [screen, colOverride, seamOverride]);
  useLayoutEffect(() => {
    setScreenLayoutPreview(previewScreenColumns);
  }, [previewScreenColumns]);
  useEffect(() => () => setScreenLayoutPreview(null), []);

  const screenLayouts = useMemo(() => screenRail ? pageScreens.map((candidate, index) => ({
    screen: candidate, index, offset: index * pageWidth,
    geometry: railGeometry(candidate.id === screen?.id ? effectiveColumns : screenToPixelColumns(candidate, railWidthPx)),
  })) : [], [screenRail, pageScreens, pageWidth, screen?.id, effectiveColumns, railWidthPx]);
  const { rects, totalWidthPx } = useMemo(() => screenRail ? {
    rects: screenLayouts.flatMap(layout => layout.geometry.rects.map(rect => ({ ...rect, leftPx: rect.leftPx + layout.offset }))),
    totalWidthPx: pageScreens.length * pageWidth - 2 * RAIL_GUTTER_PX,
  } : railGeometry(effectiveColumns), [screenRail, screenLayouts, pageScreens.length, pageWidth, effectiveColumns]);
  const liveOwners = useRef(new Map<string, string>());
  const placements = useMemo(() => screenLayouts.flatMap(layout => layout.geometry.rects.map(rect => ({
    screenId: layout.screen.id, page: layout.index, rect: { ...rect, leftPx: rect.leftPx + layout.offset },
  }))), [screenLayouts]);
  // Independent viewers get a persistent instance per placement. Stateful
  // editors and sessions retain the single keyed slot and settled handoff.
  const renderSlots = useMemo(() => slotIds.flatMap<{ itemId: string; key: string; placement: typeof placements[number] | undefined }>(itemId => {
    const independent = screenRail && canDuplicatePane(itemsById.get(itemId), !!treePanes[itemId]);
    const ownPlacements = independent ? placements.filter(placement => placement.rect.itemId === itemId) : [];
    // Sidebar fullscreen items need a viewer even without a screen placement.
    return independent && (ownPlacements.length > 0 || (soloItemId !== itemId))
      ? ownPlacements.map(placement => ({ itemId, key: JSON.stringify([itemId, placement.screenId]), placement }))
      : [{ itemId, key: itemId, placement: undefined }];
  }), [slotIds, screenRail, itemsById, treePanes, placements, soloItemId]);

  const livePlacements = useMemo(() => {
    const chosen = new Map<string, typeof placements[number]>();
    for (const placement of placements) {
      const id = placement.rect.itemId;
      const current = chosen.get(id);
      if (!current || placement.screenId === alignedScreenId ||
        (current.screenId !== alignedScreenId && placement.screenId === liveOwners.current.get(id))) chosen.set(id, placement);
    }
    return chosen;
  }, [placements, alignedScreenId]);
  useLayoutEffect(() => { liveOwners.current = new Map([...livePlacements].map(([id, placement]) => [id, placement.screenId])); }, [livePlacements]);
  const rectByItem = useMemo(() => new Map(screenRail
    ? [...livePlacements].map(([id, placement]) => [id, placement.rect])
    : rects.map(rect => [rect.itemId, rect])), [screenRail, livePlacements, rects]);
  const pageByItem = useMemo(() => new Map([...livePlacements].map(([id, placement]) => [id, placement.page])), [livePlacements]);
  const handleColumns = useMemo(() => columnHandleGeometry(effectiveColumns).map(column => ({
    ...column, leftPx: column.leftPx + activePageOffset,
  })), [effectiveColumns, activePageOffset]);

  // The caret half of picking an item. Activation is a store change and
  // nothing more, so a terminal picked from the sidebar took the focus ring
  // while the caret stayed where it was — it looked focused and swallowed
  // every keystroke until the pane itself was clicked. Pointer selection
  // and explicit creation fire this; see item-focus.ts for why activation in general
  // must not.
  //
  // Waits a frame because a revealed item's pane is inserted by the render
  // this signal races — the same reason CanvasView's reveal handler waits
  // one. Scoped to the pane BODY so the header's own buttons, which are
  // focusable and come first, are never what the caret lands on; and it
  // looks for the item's real input target rather than the pane, because
  // focusing a terminal's container does nothing at all — its input goes
  // through xterm's hidden helper textarea. That is the lesson
  // tile-manager.js's focusCanvasTile already carries for the canvas, and
  // this is the same query.
  useEffect(() => {
    return onItemFocus((itemId) => {
      requestAnimationFrame(() => {
        const candidates = [...(railRef.current?.querySelectorAll("[data-item-id]") ?? [])]
          .filter(el => el.getAttribute("data-item-id") === itemId);
        // A shared instance can still be on the outgoing page during its
        // handoff. Its caret moves with it; independent copies need the
        // selected page's input instead.
        const slot = candidates.find(el => el.getAttribute("data-screen-active") !== "false")
          ?? (candidates.length === 1 ? candidates[0] : undefined);
        const body = slot?.querySelector(".rail-pane-body");
        body?.querySelector<HTMLElement>(PANE_INPUT_TARGET)?.focus({ preventScroll: true });
      });
    });
  }, []);

  const hidePane = (itemId: string): void => {
    if (soloItemId === itemId) clearSidebarFocus();
    hideItem(itemId);
  };

  const onEdgePointerDown =
    (columnId: string, baseWidthPx: number) =>
    (e: React.PointerEvent): void => {
      e.preventDefault();
      if (fitted) {
        if (railWidthPx <= 0) return;
        const minRatio = Math.min(MIN_COLUMN_RATIO, 0.5 / effectiveColumns.length);
        const delta = (dx: number): number => dx / railWidthPx;
        startPointerDrag(e, {
          onMove: (dx) => setColOverride({ kind: "ratio", columnId, deltaRatio: delta(dx), minRatio }),
          onEnd: (dx, _dy, canceled) => {
            setColOverride(null);
            if (!canceled) resizeScreenDivider(columnId, delta(dx), minRatio);
          },
        });
        return;
      }
      startPointerDrag(e, {
        onMove: (dx) => setColOverride({ kind: "px", columnId, widthPx: baseWidthPx + dx }),
        onEnd: (dx, _dy, canceled) => {
          setColOverride(null);
          if (!canceled) resizeColumn(columnId, baseWidthPx + dx);
        },
      });
    };

  const onSeamPointerDown =
    (columnId: string, seamIndex: number) =>
    (e: React.PointerEvent): void => {
      e.preventDefault();
      const railHeight = railRef.current?.clientHeight || 1;
      startPointerDrag(e, {
        onMove: (_dx, dy) => setSeamOverride({ columnId, seamIndex, deltaRatio: dy / railHeight }),
        onEnd: (_dx, dy, canceled) => {
          setSeamOverride(null);
          if (!canceled) {
            resizePane(columnId, seamIndex, dy / railHeight);
          }
        },
      });
    };

  const onHeaderPointerDown =
    (itemId: string) =>
    (e: React.PointerEvent): void => {
      if (e.button !== 0 || (e.target as Element).closest("button, input, summary, a")) return;
      // Wide layout only: the header itself renders only when !isNarrow
      // (list-first gave the narrow item screen MobileItemHeader instead),
      // so there is no narrow branch to guard here anymore.
      e.preventDefault();
      // preventDefault above is what keeps a header drag from selecting text,
      // and it also stops the click from moving DOM focus. The slot's capture
      // handler has already made this the active tile; hand it the caret too,
      // so typing after clicking a title bar goes to the tile you clicked
      // rather than to whichever terminal held focus before.
      paneCaretTarget((e.currentTarget as Element).closest(".rail-pane"))?.focus();
      activeDragCancelRef.current?.();
      const sourceState = workspaceStore.getSnapshot();
      const sourceView = sourceState.activeView;
      const sourceScreenId = activeScreen(sourceState)?.id ?? null;
      let dragActive = false;
      let lastDrop: { screenId: string | null; target: MoveTarget; indicator: DropIndicator } | null = null;
      let lastPointer = { clientX: e.clientX, clientY: e.clientY };
      let hoveredTabId: string | null = null;
      let highlightedTab: HTMLElement | null = null;
      let tabHeld: string | null = null;
      let dwellTimer: ReturnType<typeof setTimeout> | null = null;

      const clearDwell = (): void => {
        if (dwellTimer !== null) clearTimeout(dwellTimer);
        dwellTimer = null;
      };
      const highlightTab = (tab: HTMLElement | null): void => {
        if (highlightedTab === tab) return;
        if (highlightedTab) delete highlightedTab.dataset.screenDropTarget;
        highlightedTab = tab;
        if (tab) tab.dataset.screenDropTarget = "true";
      };
      const liveViewportDrop = (clientX: number, clientY: number): typeof lastDrop => {
        const rail = railRef.current;
        if (!rail) return null;
        const box = rail.getBoundingClientRect();
        const snapshot = workspaceStore.getSnapshot();
        if (activeScreen(snapshot)) {
          if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null;
          const viewportWidth = rail.clientWidth;
          if (viewportWidth <= 0) return null;
          const pages = [...rail.querySelectorAll<HTMLElement>("[data-screen-page]")];
          const index = Math.max(0, Math.min(pages.length - 1,
            Math.floor((clientX - box.left + rail.scrollLeft) / viewportWidth)));
          const destination = snapshot.screens.find(candidate => candidate.id === pages[index]?.dataset.screenPage);
          if (!destination) return null;
          const drop = resolveDrop(rail, screenToPixelColumns(destination, fittedRailWidth(viewportWidth)),
            clientX, clientY, index * viewportWidth);
          return drop ? { screenId: destination.id, ...drop } : null;
        }
        const drop = resolveDrop(rail, columnsRef.current, clientX, clientY);
        return drop ? { screenId: null, ...drop } : null;
      };
      // Only a dwell on a screen indicator switches screens mid-drag; the
      // rail's own edges never do.
      const scheduleSwitch = (screenId: string): void => {
        clearDwell();
        dwellTimer = setTimeout(() => {
          dwellTimer = null;
          if (!workspaceStore.getSnapshot().screens.some(candidate => candidate.id === screenId)) return;
          setActiveView(`screen:${screenId}`);
        }, SCREEN_DRAG_DWELL_MS);
      };

      const dragRail = railRef.current;
      const updateDropAfterScroll = () => {
        if (!dragActive || hoveredTabId !== null) return;
        lastDrop = liveViewportDrop(lastPointer.clientX, lastPointer.clientY);
        setDropIndicator(lastDrop?.indicator ?? null);
      };
      dragRail?.addEventListener("scroll", updateDropAfterScroll, { passive: true });
      activeDragCancelRef.current = startPointerDrag(e, {
        onMove: (dx, dy, ev) => {
          if (!dragActive && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          dragActive = true;
          lastPointer = { clientX: ev.clientX, clientY: ev.clientY };
          setDrag({ itemId, clientX: ev.clientX, clientY: ev.clientY });

          const tab = screenTabAtPoint(ev.clientX, ev.clientY);
          if (tab) {
            const screenId = tab.dataset.screenId ?? null;
            hoveredTabId = screenId;
            highlightTab(tab);
            lastDrop = null;
            setDropIndicator(null);
            if (tabHeld !== screenId) {
              tabHeld = screenId;
              clearDwell();
              if (screenId && activeScreen(workspaceStore.getSnapshot())?.id !== screenId) {
                scheduleSwitch(screenId);
              }
            }
            return;
          }

          hoveredTabId = null;
          highlightTab(null);
          if (tabHeld !== null) {
            tabHeld = null;
            clearDwell();
          }
          lastDrop = liveViewportDrop(ev.clientX, ev.clientY);
          setDropIndicator(lastDrop?.indicator ?? null);
        },
        onEnd: (_dx, _dy, canceled) => {
          clearDwell();
          dragRail?.removeEventListener("scroll", updateDropAfterScroll);
          highlightTab(null);
          activeDragCancelRef.current = null;
          if (canceled) {
            setActiveView(sourceView);
          } else if (hoveredTabId !== null) {
            if (sourceScreenId !== null && hoveredTabId !== sourceScreenId) {
              moveItemToScreen(itemId, hoveredTabId, undefined, sourceScreenId ?? undefined);
            }
          } else if (dragActive) {
            // Native scrolling can move the destination under a stationary
            // pointer, so resolve against the final rail offset at drop time.
            const drop = liveViewportDrop(lastPointer.clientX, lastPointer.clientY);
            if (drop?.screenId != null) moveItemToScreen(itemId, drop.screenId, drop.target, sourceScreenId ?? undefined);
            else if (drop) moveItem(itemId, drop.target);
          }
          setDrag(null);
          setDropIndicator(null);
        },
      }, railRef.current);
    };

  // List-first: while the narrow projection shows the home screen instead
  // of the active item, the rail stays mounted (keep-alive — see the
  // module doc comment) but paints nothing, via the single-class
  // `.rail-home-hidden` rule in App.css.
  const narrowHome = isNarrow && effectiveNarrowView(narrowView, activeItemId) === "home";
  const railClass = [
    "rail",
    "scrollbar-hover",
    effectiveZoomed ? "rail-zoomed" : null,
    isNarrow ? "rail-narrow" : null,
    narrowHome ? "rail-home-hidden" : null,
    fitted && !effectiveZoomed ? "rail-fitted" : null,
  ]
    .filter((c): c is string => c !== null)
    .join(" ");
  const railContentClass = isNarrow
    ? "rail-content rail-content-narrow"
    : fitted
      ? "rail-content rail-content-fitted"
      : "rail-content";

  return (
    <div className={railClass} ref={railRef} inert={!workspaceVisible}>
      {!soloItemId && !screenRail && (screen ? screen.columns : columns).length === 0 && <EmptyState screenId={screen?.id} visible={workspaceVisible && !narrowHome} />}
      <div
        className={railContentClass}
        style={isNarrow ? undefined : { width: totalWidthPx + (fitted ? 2 * RAIL_GUTTER_PX : RAIL_TRAILING_BUFFER_PX) }}
      >
        {screenLayouts.map(layout => (
          <div key={layout.screen.id} className="rail-screen-snap" data-screen-page={layout.screen.id}
            style={{ left: layout.offset - RAIL_GUTTER_PX, width: pageWidth }}>
            {!soloItemId && layout.screen.columns.length === 0 && <EmptyState screenId={layout.screen.id} visible={workspaceVisible && !narrowHome && layout.screen.id === screen?.id} />}
          </div>
        ))}
        {renderSlots.map(({ itemId, key, placement }) => {
          // An id the catalog store doesn't (yet) know about — see
          // slotIds' own doc comment — renders no slot; `reconcile` above
          // prunes it once the catalog confirms it's genuinely gone, and
          // the next render simply drops it from this list. A `tree:` id
          // is never a catalog item at all — it resolves against
          // `treePanes` instead (see workspace.ts's fourth "kind of id").
          const item = itemsById.get(itemId);
          const treePane = item === undefined ? treePanes[itemId] : undefined;
          if (!item && !treePane) return null;
          const title = item ? paneTitle(item) : treePane!.name;
          const cloudStatus = item
            ? paneCloudStatus(item, statuses)
            : treePane ? treePaneCloudStatus(treePane, statuses) : null;
          const livePlacement = livePlacements.get(itemId);
          const rect = placement?.rect ?? rectByItem.get(itemId);
          const displayed = rect !== undefined;
          const page = placement?.page ?? pageByItem.get(itemId);
          const active = soloItemId ? itemId === soloItemId && (!placement || placement.screenId === livePlacement?.screenId) : itemId === activeItemId && (!placement || page === activePageIndex);
          const inViewport = !screenRail || (page !== undefined && page >= visiblePages[0] && page <= visiblePages[1]);
          const visible = workspaceVisible && (soloItemId ? active : slotVisible(displayed && (effectiveZoomed ? active : inViewport), effectiveZoomed, active));
          // `displayed` guards zoom: setActiveItem accepts ids whose only
          // placement is a canvas tile, and zooming a display:none slot
          // would paint an empty full-viewport pane. File-tree clicks move
          // focus to the opened file, which becomes the fullscreen target.
          const zoomed = soloItemId ? active : effectiveZoomed && active && displayed;
          const style: React.CSSProperties = soloItemId && active
            ? { left: zoomLeftPx + RAIL_GUTTER_PX, width: Math.max(0, railWidthPx - 2 * RAIL_GUTTER_PX), top: RAIL_GUTTER_PX, height: `calc(100% - ${2 * RAIL_GUTTER_PX}px)`, zIndex: 10 }
            : zoomed
              ? isNarrow
                ? NARROW_ZOOM_STYLE
                : {
                    // `clientWidth` and `scrollLeft` are the rail's own, so
                    // they already describe the un-guttered viewport; only
                    // the origin and the percentage height need the
                    // containing block's padding taken back out.
                    left: zoomLeftPx - RAIL_GUTTER_PX,
                    width: railRef.current?.clientWidth ?? "100%",
                    top: -RAIL_GUTTER_PX,
                    height: `calc(100% + ${RAIL_GUTTER_PX * 2}px)`,
                    zIndex: 10,
                  }
              : slotStyle(rect);
          // The look (frame, header, body) is pane-chrome.css's, shared with
          // the canvas tile; the rail-* classes carry this surface's own
          // geometry and behaviour. Same split tile-renderer.js makes.
          const paneType = item?.type ?? "tree";
          // An artifact is a bare clipped iframe only inside the persona
          // workspace and the sidebar viewer; desktop screens add a title
          // and drag header above the rounded content (ArtifactItem.css).
          const flatArtifact = item?.type === "artifact" && Boolean(soloItemId);
          const glass = paneType === "term" || paneType === "agent" || paneType === "tree";
          const className = ["rail-pane", "pane-chrome"];
          if (soloItemId && active) className.push("rail-sidebar-viewer");
          if (flatArtifact) className.push("rail-artifact-flat");
          if (glass) className.push("pane-chrome-glass");
          if (paneType === "term") className.push("pane-chrome-term");
          // In Builder an app is open for editing: an ordinary tile whose
          // header is the editing bar. Narrow layouts keep a bare frame.
          const framed = paneType === "artifact";
          const artifactTile = paneType === "artifact" && !isNarrow && !soloItemId;
          const chromeless = (framed && !artifactTile) || paneType === "image";
          if (framed && !artifactTile) className.push("rail-pane-chromeless");
          if (artifactTile) className.push("rail-artifact-tile");
          if (paneType === "image") className.push("rail-pane-image");
          if (active) className.push("rail-pane-active", "is-active");
          if (zoomed && !soloItemId) className.push("rail-pane-zoomed");
          const focusSlot = () => {
            // Tile selection is independent of screen navigation, including
            // clicks on a page still leaving the viewport during a snap.
            setActiveItem(itemId);
            if (!isNarrow) revealTileInSidebar(itemId);
            const repoId = item?.repoId ?? treePane?.repoId;
            if (repoId) setActiveRepo(repoId);
          };
          return (
            <div
              key={key}
              data-item-id={itemId}
              hidden={item?.type === "app" && !visible}
              data-placement-screen-id={placement?.screenId}
              data-screen-active={soloItemId ? active : screenRail ? page === activePageIndex : undefined}
              inert={(!workspaceVisible || (soloItemId ? !active : screenRail && ((!inViewport && !active) || (page !== undefined && !ws.screens.some(candidate => candidate.id === pageScreens[page]?.id)))))}
              // Mirrors the canvas engine's own `data-tile-type` (see
              // tile-renderer.js): the surface a terminal needs under it is
              // not the surface a file needs, and both views now say so the
              // same way rather than one of them guessing. App.css keys the
              // terminal ground (--pane-term-bg, tiled and zoomed alike)
              // off it. A tree pane has no catalog
              // item — it is typed "tree", the same name canvas.css's
              // data-tile-type gives its tiles.
              data-item-type={paneType}
              className={className.join(" ")}
              style={soloItemId && !active ? { ...style, visibility: "hidden", pointerEvents: "none" } : style}
              onContextMenu={paneType === "artifact" && item ? async (event) => {
                event.preventDefault();
                const selected = await services.desktop.showContextMenu([
                  { id: "open-in-browser", label: "Open in browser" },
                  ...(canCopyArtifactUrl(item, services.desktop.capabilities.localRepos) ? [{ id: "copy-url", label: "Copy URL" }] : []),
                  { id: "hide-artifact", label: "Hide artifact" },
                ]);
                if (selected === "hide-artifact") hidePane(itemId);
                if (selected === "open-in-browser") {
                  try {
                    await openArtifactInBrowser(item, document.documentElement.classList.contains("dark") ? "dark" : "light");
                    setBrowserMessage(null);
                  } catch {
                    setBrowserMessage({itemId,text:"This artifact couldn’t be opened in the browser."});
                  }
                }
                if (selected === "copy-url") {
                  try {
                    await copyArtifactUrl(item);
                    setBrowserMessage(null);
                  } catch {
                    setBrowserMessage({itemId,text:"This URL couldn’t be copied."});
                  }
                }
              } : undefined}
              // Selecting the pane also selects its repo, so Cmd+N (which
              // reads reposStore's activeRepoId — see shortcuts.ts's
              // "new-tile") creates under the repo the user is actually
              // working in, not whatever was last clicked in the sidebar.
              // ReposSidebar's own `selectRepoForItem` has done this
              // for sidebar rows all along; clicking the pane itself was the
              // one way to focus an item without it. An item with no repo
              // (opened outside any — supported) leaves the selection alone
              // rather than clearing it, matching the sidebar.
              onPointerDownCapture={focusSlot}
            >
              {flatArtifact && item ? <>
                <ContainedErrorBoundary>
                  <ArtifactItem item={item} visible={visible} onFocus={focusSlot} bare />
                </ContainedErrorBoundary>
                {browserMessage?.itemId === itemId && <div className="artifact-browser-message" role="status">{browserMessage.text}</div>}
              </> : <div className="rail-pane-surface"
                onPointerDown={paneType === "image" && !isNarrow ? onHeaderPointerDown(itemId) : undefined}>
                {/* List-first: below the breakpoint the pane header does not
                    render at all — its verbs are desktop pane management
                    (zoom, hide, drag) that read as column-layout controls on
                    a phone, and MobileItemHeader (App.tsx) carries the item
                    screen's own chrome (back, title, rename) instead. */}
                {!isNarrow && !chromeless && (
                  <PaneHeader
                    itemId={itemId}
                    title={title}
                    cloudStatus={artifactTile ? null : cloudStatus}
                    zoomed={zoomed}
                    zoomable={!artifactTile}
                    hideLabel={artifactTile ? "Hide artifact" : "Hide"}
                    onHide={() => hidePane(itemId)}
                    onZoom={() => togglePaneZoom()}
                    onPointerDown={onHeaderPointerDown(itemId)}
                    terminal={item?.type === "term" ? item : undefined}
                  />
                )}
                {/* A pane on a machine that is not running shows the same static
                    skeleton a placement on another screen does, under one
                    sentence. Its live view stays mounted but hidden, so nothing
                    is torn down for a pause. */}
                <div className="rail-pane-body pane-chrome-body">
                  <ContainedErrorBoundary>
                    {item ? (
                      <ItemView
                        item={item}
                        visible={visible}
                        active={active && workspaceVisible}
                        onFocus={focusSlot}
                        frameKey={String(key)}
                      />
                    ) : (
                      <FileTreeItem
                        paneId={itemId}
                        pane={treePane!}
                        visible={visible}
                      />
                    )}
                  </ContainedErrorBoundary>
                </div>
                {paneType === "image" && !isNarrow && (
                  <div className="rail-image-toolbar">
                    <div className="rail-image-path filepath-text" title={item?.filePath}>
                      <span className="filepath-parent">{splitFilepath(item?.filePath ?? "").parent}</span>
                      <span className="filepath-name">{splitFilepath(item?.filePath ?? "").name}</span>
                    </div>
                    <button type="button" className="rail-image-close"
                      aria-label="Hide image" data-tooltip="Hide image" data-shortcut={SHORTCUT_ACCELERATORS["close-tile"]}
                      onClick={() => hidePane(itemId)}>
                      <X size={14} weight="bold" />
                    </button>
                  </div>
                )}
                {browserMessage?.itemId === itemId && (
                  <div className="artifact-browser-message" role="status">{browserMessage.text}</div>
                )}
              </div>}
            </div>
          );
        })}
        {screenRail && !effectiveZoomed && placements.filter(placement =>
          !canDuplicatePane(itemsById.get(placement.rect.itemId), !!treePanes[placement.rect.itemId]) &&
          placement.page >= visiblePages[0] && placement.page <= visiblePages[1] &&
          livePlacements.get(placement.rect.itemId) !== placement).map(placement => (
          <div key={JSON.stringify([placement.screenId, placement.rect.itemId])}
            className="rail-pane pane-chrome rail-pane-placeholder"
            data-placeholder-item-id={placement.rect.itemId} data-screen-id={placement.screenId}
            style={slotStyle(placement.rect)}
            onPointerDown={event => {
              event.preventDefault();
              setActiveItem(placement.rect.itemId);
              if (!isNarrow) revealTileInSidebar(placement.rect.itemId);
              const repoId = itemsById.get(placement.rect.itemId)?.repoId ?? treePanes[placement.rect.itemId]?.repoId;
              if (repoId) setActiveRepo(repoId);
              requestItemFocus(placement.rect.itemId);
            }}>
            <div className="rail-pane-surface">
              <div className="pane-chrome-header rail-placeholder-header">
                <span className="rail-placeholder-title">{itemsById.has(placement.rect.itemId)
                  ? paneTitle(itemsById.get(placement.rect.itemId)!) : treePanes[placement.rect.itemId]?.name}</span>
              </div>
              <div className="rail-placeholder-body">
                <PaneSkeleton type={itemsById.get(placement.rect.itemId)?.type ?? "tree"} />
              </div>
            </div>
          </div>
        ))}
        {/* Resize handles are desktop-only chrome: narrow mode shows one
            pane at a time, so there is no column edge or pane seam to drag.
            They are free to disappear and come back — the keep-alive
            contract only constrains the item slots (module doc comment).
            Dividers trade width between neighbors; the final edge stays
            pinned to the viewport. */}
        {!isNarrow &&
          handleColumns.map((column) => (
            <Fragment key={column.columnId}>
              {!(fitted && effectiveColumns.at(-1)?.id === column.columnId) && (
                <EdgeHandle column={column} onPointerDown={onEdgePointerDown} />
              )}
              <SeamHandles column={column} onPointerDown={onSeamPointerDown} />
            </Fragment>
          ))}
        {dropIndicator?.kind === "column" && (
          <div className="rail-drop-column" style={{ left: dropIndicator.leftPx }} />
        )}
        {dropIndicator?.kind === "seam" && (
          <div
            className="rail-drop-seam"
            style={{
              left: dropIndicator.leftPx,
              width: dropIndicator.widthPx,
              // A bottom-of-column drop has topFr = 1, which would place the
              // 2px bar entirely below the rail; the min() pins it inside.
              top: `min(${dropIndicator.topFr * 100}%, calc(100% - 2px))`,
            }}
          />
        )}
        {drag && createPortal(
          <div
            className="rail-drag-ghost"
            style={{ left: drag.clientX - 90, top: drag.clientY - 60 }}
          />,
          document.body,
        )}
      </div>
    </div>
  );
}

export default Rail;
