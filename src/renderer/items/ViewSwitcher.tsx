/** The client-local global screen strip. */



import { rollupAttention } from "../attention/attention";
import { AttentionDot } from "../attention/AttentionDot";
import { useAttentionMap } from "../attention/store";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type Modifier } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { GO_TO_SCREEN_DIGITS, SHORTCUT_ACCELERATORS, formatShortcut } from "@port/shared/shortcuts";
import { closeScreen, renameScreen, reorderScreen, screenView, setActiveView, useWorkspace, workspaceStore, type Screen } from "../state/workspace";
import { screenDisplayName } from "../state/screen-ops";
import { requestInstantScreenNavigation } from "../state/screen-navigation";
import { services } from "../services";
import { onScreenScrollPosition, type ScreenScrollPosition } from "../state/screen-scroll-position";
import { useScreenLayoutPreview } from "../state/screen-layout-preview";
import "./ViewSwitcher.css";
import { ScreenLayoutMiniature } from "./ScreenLayoutMiniature";
import { useEdgeFades } from "../hooks/useEdgeFades";

interface StripEntry {
  screen: Screen;
  exit?: { width: number; presence: number };
}

function jumpToScreen(id: string): void {
  requestInstantScreenNavigation(id);
  setActiveView(screenView(id));
}

/** What a sortable indicator binds onto its tab element. */
interface IndicatorBind {
  setNodeRef: (node: HTMLElement | null) => void;
  dragProps: Record<string, unknown>;
  style: CSSProperties;
  isDragging: boolean;
}

interface IndicatorProps {
  screen: Screen;
  exit: StripEntry["exit"];
  index: number;
  active: boolean;
  name: string;
  label: string;
  shortcut: string | undefined;
  editing: boolean;
  onSelect: () => void;
  onAuxClose: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onAnimationEnd: (e: React.AnimationEvent) => void;
  onFinishName: (value: string, save: boolean, restoreFocus?: boolean) => void;
  nameInputRef: (input: HTMLInputElement | null) => void;
  onNameInput: (input: HTMLInputElement) => void;
  attention: ComponentProps<typeof AttentionDot>["state"];
  bind?: IndicatorBind;
}

/** One indicator, live or exiting. A live one may also be a sortable node. */
function IndicatorBody({
  screen, exit, active, name, label, shortcut, editing,
  onSelect, onAuxClose, onKeyDown, onContextMenu, onAnimationEnd, onFinishName, nameInputRef, onNameInput, attention, bind,
}: IndicatorProps) {
  const style: CSSProperties | undefined = exit
    ? { "--screen-exit-width": `${exit.width}px`, "--screen-presence": exit.presence } as CSSProperties
    : bind?.style;
  return (
    <div ref={bind?.setNodeRef} {...bind?.dragProps}
      role={exit ? undefined : "tab"} tabIndex={!exit && active ? 0 : -1} data-screen-id={exit ? undefined : screen.id}
      aria-selected={exit ? undefined : active} aria-label={exit ? undefined : label} data-tooltip={exit ? undefined : shortcut}
      aria-hidden={exit ? true : undefined} inert={exit ? true : undefined}
      data-screen-exiting={exit ? screen.id : undefined}
      style={style}
      onAnimationEnd={onAnimationEnd}
      data-screen-unnamed={!name && !editing ? "true" : undefined}
      data-screen-naming={editing ? "true" : undefined}
      className={`view-switcher-option${active ? " view-switcher-active" : ""}${bind?.isDragging ? " is-dragging" : ""}`}
      onClick={onSelect}
      onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onAuxClose(); } }}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      {editing ? <input className="view-switcher-name-input" aria-label="Screen name"
        defaultValue={name} maxLength={100}
        ref={nameInputRef}
        // A press in the field is typing, never a drag of the indicator.
        onMouseDown={event => event.stopPropagation()}
        onTouchStart={event => event.stopPropagation()}
        onInput={event => onNameInput(event.currentTarget)}
        onBlur={event => onFinishName(event.currentTarget.value, true)}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            onFinishName(event.currentTarget.value, event.key === "Enter", true);
          }
        }} /> : name ? <span className="view-switcher-name">{name}</span> : screen.columns.length > 0 ? (
          <ScreenLayoutMiniature screen={screen} />
        ) : null}
      {!exit && <AttentionDot className="view-switcher-attention" state={attention} />}
    </div>
  );
}

/** Keep one DOM node across spare, sortable, and exiting states so CSS
 * transitions retain their previous values. Disabled entries never drag. */
function ScreenIndicator({ sortable, ...props }: IndicatorProps & { sortable: boolean }) {
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: props.screen.id, disabled: !sortable });
  // Indicators stay role="tab" with their roving tabIndex; dnd-kit's
  // pressed and roledescription attributes still come through.
  const { role: _role, tabIndex: _tabIndex, ...sortableAttributes } = attributes;
  const style: CSSProperties = {
    ...(transform ? { transform: `translate3d(${transform.x}px, 0, 0)` } : {}),
    ...(transition ? { transition } : {}),
  };
  return <IndicatorBody {...props} bind={{ setNodeRef, dragProps: sortable ? { ...sortableAttributes, ...listeners } : {}, style: sortable ? style : {}, isDragging: sortable && isDragging }} />;
}

export function ViewSwitcher() {
  // A screen's dot rolls up the items placed on it: the only surface that
  // can tell the user to look at a screen they are not on.
  const attention = useAttentionMap();
  const workspace = useWorkspace();
  const screens = workspace.screens;
  // A resize in progress draws its indicator from the gesture, not the store.
  const layoutPreview = useScreenLayoutPreview();
  const scrollRef = useRef<HTMLDivElement>(null);
  const measurements = useRef(new Map<string, { width: number; presence: number }>());
  const [strip, setStrip] = useState<{ screens: Screen[]; entries: StripEntry[] }>(() => ({
    screens, entries: screens.map(screen => ({ screen })),
  }));
  // Retain removed indicators for their exit animation, independently of the
  // workspace. They stop being tabs/drop targets as soon as the screen closes.
  if (strip.screens !== screens) {
    const liveIds = new Set(screens.map(screen => screen.id));
    const entries: StripEntry[] = screens.map(screen => ({ screen }));
    strip.entries.forEach((entry, index) => {
      if (liveIds.has(entry.screen.id)) return;
      const next = strip.entries.slice(index + 1).find(candidate => liveIds.has(candidate.screen.id));
      const insertion = next ? entries.findIndex(candidate => candidate.screen.id === next.screen.id) : entries.length;
      entries.splice(insertion, 0, { ...entry, exit: entry.exit ?? measurements.current.get(entry.screen.id) ?? { width: 38.4, presence: 0 } });
    });
    setStrip({ screens, entries });
  }
  const finishExit = useCallback((id: string) => {
    measurements.current.delete(id);
    setStrip(current => ({ ...current, entries: current.entries.filter(entry => entry.screen.id !== id || !entry.exit) }));
  }, []);
  const exitTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const exiting = new Set(strip.entries.filter(entry => entry.exit).map(entry => entry.screen.id));
    for (const [id, timer] of exitTimers.current) {
      if (!exiting.has(id)) { clearTimeout(timer); exitTimers.current.delete(id); }
    }
    for (const id of exiting) {
      // Also clean up when hidden/zoomed chrome cannot deliver animationend.
      if (!exitTimers.current.has(id)) exitTimers.current.set(id, setTimeout(() => finishExit(id), 240));
    }
  }, [strip.entries, finishExit]);
  useEffect(() => () => { for (const timer of exitTimers.current.values()) clearTimeout(timer); }, []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  // The field tracks its own content, so a blank name keeps the compact
  // indicator width (the CSS min-width) and typing grows it, up to the
  // indicator's own max-width. The floor and the slack past the content are
  // the caret's: a field measured to exactly its text clips the caret sitting
  // after it, and a zero-width empty field hides it altogether.
  const fitNameInput = useCallback((input: HTMLInputElement) => {
    input.style.width = "0px";
    input.style.width = `${Math.max(input.scrollWidth + 2, 8)}px`;
  }, []);
  const focusNameInput = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    fitNameInput(input);
    input.focus();
    input.select();
  }, [fitNameInput]);
  useEffect(() => {
    if (editingId !== null && !screens.some(screen => screen.id === editingId)) {
      editingRef.current = null;
      setEditingId(null);
    }
  }, [screens, editingId]);
  useEdgeFades(scrollRef, strip.entries);
  useLayoutEffect(() => {
    const strip = scrollRef.current;
    if (!strip) return;
    const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
    let position: ScreenScrollPosition | null = null;
    const update = () => {
      const selected = tabs.find(tab => tab.getAttribute("aria-selected") === "true");
      const from = tabs.find(tab => tab.dataset.screenId === position?.fromId) ?? selected;
      const to = tabs.find(tab => tab.dataset.screenId === position?.toId) ?? from;
      if (!from || !to) return;
      const progress = position ? Math.max(0, Math.min(1, position.progress)) : 0;
      for (const tab of tabs) {
        const presence = from === to ? Number(tab === from)
          : tab === from ? 1 - progress : tab === to ? progress : 0;
        tab.style.setProperty("--screen-presence", String(presence));
        measurements.current.set(tab.dataset.screenId!, { width: tab.getBoundingClientRect().width, presence });
      }
      // Keep the emphasized segment reachable as the strip overflows.
      const emphasized = progress < 0.5 ? from : to;
      const left = emphasized.offsetLeft;
      const width = emphasized.offsetWidth;
      if (strip.clientWidth > 0 && editingRef.current === null) {
        if (left < strip.scrollLeft) strip.scrollLeft = left;
        else if (left + width > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + width - strip.clientWidth;
      }
    };
    const unsubscribe = onScreenScrollPosition(next => { position = next; update(); });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(strip);
    tabs.forEach(tab => observer?.observe(tab));
    window.addEventListener("resize", update);
    return () => { unsubscribe(); observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [screens, workspace.activeView]);

  const finishName = (value: string, save: boolean, restoreFocus = false): void => {
    const id = editingRef.current;
    if (id === null) return;
    editingRef.current = null;
    setEditingId(null);
    if (save) renameScreen(id, value);
    if (restoreFocus) requestAnimationFrame(() => {
      if (editingRef.current !== null) return;
      [...(scrollRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
        .find(tab => tab.dataset.screenId === id)?.focus();
    });
  };

  const close = (screen: Screen): void => {
    const hadFocus = scrollRef.current?.contains(document.activeElement);
    closeScreen(screen.id);
    if (hadFocus) requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    });
  };

  // Reorder (spec §3). The spare, the trailing empty unnamed screen, is never
  // sortable and nothing lands after it. Mouse and touch only: keyboard
  // reordering is the context menu's Move left and Move right.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  // The click that ends a drag must not also select the screen.
  const justDraggedRef = useRef(false);
  const last = screens.at(-1);
  const spareId = last && last.columns.length === 0 && screenDisplayName(last) === "" ? last.id : null;
  const sortableIds = screens.filter(screen => screen.id !== spareId).map(screen => screen.id);
  const restrictToScreenStrip: Modifier = ({ transform, draggingNodeRect }) => {
    const strip = scrollRef.current;
    if (!strip || !draggingNodeRect) return transform;
    const bounds = strip.getBoundingClientRect();
    const spare = [...strip.querySelectorAll<HTMLElement>('[data-screen-id]')]
      .find(tab => tab.dataset.screenId === spareId);
    // The spare never transforms. Its leading edge is a stable boundary,
    // unlike sortable neighbours which shift while the pointer crosses them.
    const right = Math.min(bounds.right, spare?.getBoundingClientRect().left ?? bounds.right);
    const min = bounds.left - draggingNodeRect.left;
    const max = Math.max(min, right - draggingNodeRect.right);
    return { ...transform, x: Math.max(min, Math.min(max, transform.x)) };
  };

  return (
    <div className="view-switcher" role="tablist" aria-label="Screens" data-multiple-screens={screens.length > 1}>
      <div className="view-switcher-scroll" ref={scrollRef}>
        <DndContext
          sensors={sensors}
          accessibility={{ container: document.body }}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis, restrictToScreenStrip]}
          onDragEnd={({ active, over }) => {
            justDraggedRef.current = true;
            requestAnimationFrame(() => { justDraggedRef.current = false; });
            if (!over || over.id === active.id) return;
            const toIndex = workspaceStore.getSnapshot().screens.findIndex(screen => screen.id === over.id);
            if (toIndex >= 0) reorderScreen(String(active.id), toIndex);
          }}
        >
          <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
            {strip.entries.map(({ screen: stored, exit }) => {
              const screen = !exit && layoutPreview?.screenId === stored.id
                ? { ...stored, columns: layoutPreview.columns } : stored;
              const index = screens.findIndex(candidate => candidate.id === screen.id);
              const active = workspace.activeView === screenView(screen.id);
              const name = screenDisplayName(screen);
              const label = name || `Screen ${index + 1}`;
              const digit = GO_TO_SCREEN_DIGITS[index];
              const shortcut = digit === undefined ? undefined
                : formatShortcut(SHORTCUT_ACCELERATORS["go-to-screen"].replace(/1$/, String(digit)), services.desktop.getPlatform());
              const props: IndicatorProps = {
                screen, exit, index, active, name, label, shortcut,
                editing: editingId === screen.id,
                onSelect: () => {
                  if (justDraggedRef.current) return;
                  if (editingRef.current === null) jumpToScreen(screen.id);
                },
                onAuxClose: () => close(screen),
                onKeyDown: e => {
                  if (e.target !== e.currentTarget) return;
                  let next: number | undefined;
                  if (e.key === "ArrowRight") next = (index + 1) % screens.length;
                  if (e.key === "ArrowLeft") next = (index + screens.length - 1) % screens.length;
                  if (e.key === "Home") next = 0;
                  if (e.key === "End") next = screens.length - 1;
                  if (next !== undefined) {
                    e.preventDefault();
                    const nextScreenId = screens[next]!.id;
                    jumpToScreen(nextScreenId);
                    [...(scrollRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
                      .find(tab => tab.dataset.screenId === nextScreenId)?.focus();
                  } else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault(); jumpToScreen(screen.id);
                  } else if (e.key === "Delete") { e.preventDefault(); close(screen); }
                },
                onContextMenu: e => {
                  e.preventDefault();
                  void services.desktop.showContextMenu([
                    { id: "rename", label: name ? "Rename screen…" : "Name screen…" },
                    ...(screen.id === spareId ? [] : [
                      { id: "move-left", label: "Move left", enabled: index > 0 },
                      { id: "move-right", label: "Move right", enabled: index < screens.length - 2 },
                    ]),
                    { id: "close", label: "Close screen", accelerator: SHORTCUT_ACCELERATORS["close-screen"] },
                  ]).then(picked => {
                    if (picked === "close") close(screen);
                    if (picked === "move-left") reorderScreen(screen.id, index - 1);
                    if (picked === "move-right") reorderScreen(screen.id, index + 1);
                    if (picked === "rename") {
                      editingRef.current = screen.id;
                      setEditingId(screen.id);
                    }
                  })
                    .catch(error => console.error("[screen-strip] context menu failed:", error));
                },
                onAnimationEnd: event => { if (exit && event.target === event.currentTarget) finishExit(screen.id); },
                onFinishName: finishName,
                nameInputRef: focusNameInput,
                onNameInput: fitNameInput,
                attention: rollupAttention(screen.columns.flatMap(column =>
                  column.panes.map(pane => attention.get(pane.itemId) ?? "idle"))),
              };
              return <ScreenIndicator key={screen.id} {...props} sortable={!exit && screen.id !== spareId} />;
            })}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

export default ViewSwitcher;
