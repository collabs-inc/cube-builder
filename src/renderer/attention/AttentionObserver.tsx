/**
 * Advances this client's watermarks. Renders nothing.
 *
 * Terminal completions are seen on a fresh body click or typing in xterm.
 * Existing focus, visibility, and clicks before completion do not count.
 * Conversation completions are seen when their pane is on screen: the document
 * is visible, and the item is displayed by the showing view. That is
 * narrower than `displayedItemIds`: the phone's home list hides the whole
 * rail, and a zoomed pane hides its column siblings. All are accounted for
 * here rather than trusting placement alone.
 *
 * Two more conditions keep a completion from being consumed unseen. The
 * item must stay shown for a short dwell: selecting a screen changes the
 * active view at once while the rail is still scrolling toward it, and a
 * scroll interrupted before arriving must not count. And an item on a
 * machine whose connection is known not to be open is never acknowledged,
 * since its pane cannot be showing that result.
 *
 * Observation runs before acknowledgment, in effect order, so a row's
 * first sight adopts whatever it had already finished before anything can
 * be compared against it.
 */



import { useEffect, useMemo, useRef, useState } from "react";
import { useIsNarrow } from "../hooks/useIsNarrow";
import { catalogStore, useCatalog } from "../state/catalog";
import { reposStore } from "../state/repos";
import { effectiveNarrowView, useUiState, type NarrowView } from "../state/ui";
import { displayedItemIds, useWorkspace, type WorkspaceState } from "../state/workspace";
import { acknowledge, observeItems, watermarkStore } from "./watermarks";
import { deriveAttention } from "./attention";

/** How long an item must stay on screen before its completion counts as seen. */
export const ACK_DWELL_MS = 1_000;

export function shownItemIds(input: {
  workspace: Pick<WorkspaceState, "activeItemId"> & Parameters<typeof displayedItemIds>[0];
  narrow: boolean;
  narrowView: NarrowView;
  paneZoomed: boolean;
  documentVisible: boolean;
  workspaceVisible?: boolean;
}): Set<string> {
  if (!input.documentVisible || input.workspaceVisible === false) return new Set();
  const active = input.workspace.activeItemId;
  if (input.narrow) {
    return active !== null && effectiveNarrowView(input.narrowView, active) === "item" ? new Set([active]) : new Set();
  }
  if (input.paneZoomed && active !== null && input.workspace.activeView !== "canvas") return new Set([active]);
  return displayedItemIds(input.workspace);
}

/** What the dwell timer acknowledges once it fires, read at that moment. */
export function acknowledgeable(
  items: ReadonlyArray<{ id: string; machineId: string; turnEndedAt?: string }>,
  shown: ReadonlySet<string>,
  statuses: Readonly<Record<string, { status: string } | undefined>>,
): Array<{ id: string; turnEndedAt: string }> {
  const out: Array<{ id: string; turnEndedAt: string }> = [];
  for (const item of items) {
    if (item.turnEndedAt === undefined || !shown.has(item.id)) continue;
    const connection = statuses[item.machineId]?.status;
    if (connection !== undefined && connection !== "open") continue;
    out.push({ id: item.id, turnEndedAt: item.turnEndedAt });
  }
  return out;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function AttentionObserver({ visible = true }: { visible?: boolean } = {}): null {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const catalog = useCatalog();
  const workspace = useWorkspace();
  const ui = useUiState();
  const narrow = useIsNarrow();
  const documentVisible = useDocumentVisible();

  useEffect(() => {
    observeItems(catalog.items.filter(item => item.type === "term" || item.type === "agent"));
  }, [catalog.items]);

  useEffect(() => {
    const acknowledgeTerminal = (event: Event, doneOnly = false) => {
      if (!visibleRef.current || document.visibilityState === "hidden" || !(event.target instanceof Element)) return;
      const terminal = event.target.closest(".item-terminal-live .xterm");
      const id = terminal?.closest(".rail-pane[data-item-id]")?.getAttribute("data-item-id");
      if (!id) return;
      // Read the current stamp at the interaction, never grant future completions
      // an acknowledgment just because this terminal retains keyboard focus.
      const items = catalogStore.getSnapshot().items.filter(item => item.id === id && item.type === "term"
        && (!doneOnly || deriveAttention(item, watermarkStore.getSnapshot()[id]) === "done"));
      for (const item of acknowledgeable(items, new Set([id]), reposStore.getSnapshot().statuses)) {
        acknowledge(item.id, item.turnEndedAt);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0) acknowledgeTerminal(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Listen to user events rather than xterm.onData, which also emits
      // automatic device replies. App shortcuts and modifier keys aren't typing.
      // The terminal's clipboard fallback handles Cmd/Ctrl+V itself, so
      // that explicit paste may never emit a native paste/input event.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "v") {
        acknowledgeTerminal(event, true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length === 1 || ["Enter", "Backspace", "Delete"].includes(event.key)) acknowledgeTerminal(event, true);
    };
    const onTextInput = (event: Event) => acknowledgeTerminal(event, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("input", onTextInput, true);
    document.addEventListener("paste", onTextInput, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("input", onTextInput, true);
      document.removeEventListener("paste", onTextInput, true);
    };
  }, []);

  const shown = useMemo(
    () => shownItemIds({ workspace, narrow, narrowView: ui.narrowView, paneZoomed: ui.paneZoomed, documentVisible, workspaceVisible: visible }),
    [workspace, narrow, ui.narrowView, ui.paneZoomed, documentVisible, visible],
  );
  // Keyed on WHICH items are shown, not on the workspace object, so an
  // unrelated layout or catalog change does not keep restarting the dwell.
  const shownKey = [...shown].sort().join("\n");
  // Keyed on the shown rows' stamps too, so a completion landing on an item
  // already on screen starts its own dwell.
  const stampsKey = catalog.items
    .filter(item => item.type === "agent" && shown.has(item.id) && item.turnEndedAt !== undefined)
    .map(item => `${item.id}:${item.turnEndedAt}`)
    .join("\n");

  useEffect(() => {
    if (shownKey === "") return;
    const timer = setTimeout(() => {
      // Read at fire time: what is on screen and connected NOW.
      const ids = new Set(shownKey.split("\n"));
      const conversations = catalogStore.getSnapshot().items.filter(item => item.type === "agent");
      for (const { id, turnEndedAt } of acknowledgeable(conversations, ids, reposStore.getSnapshot().statuses)) {
        acknowledge(id, turnEndedAt);
      }
    }, ACK_DWELL_MS);
    return () => clearTimeout(timer);
  }, [shownKey, stampsKey]);

  return null;
}
