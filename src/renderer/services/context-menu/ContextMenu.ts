// src/windows/web/shim/context-menu/ContextMenu.ts
//
// `showContextMenu`'s browser half. On the desktop the renderer hands
// `ContextMenuItem[]` to main, which pops a NATIVE `Menu` and resolves the
// clicked item's id (src/main/ipc-misc.ts's "context-menu:show"). A tab has
// no native menu to pop, so this draws the same menu in the DOM and keeps
// the contract exactly: one promise per popup, resolving the chosen id, or
// `null` if the user dismissed it. `capabilities.nativeMenus` is false in
// the browser precisely so the UI knows this is what it is getting.
//
// Three details are copied from the Electron side rather than invented:
//
// 1. A SEPARATOR IS AN ITEM WITH id === "separator" — not a `type` field.
//    `ContextMenuItem` (packages/shared/src/types.ts) has no `type` at all;
//    ipc-misc.ts branches on the id, and every call site passes
//    `{ id: "separator", label: "" }`. Anything else here would render the
//    app's separators as clickable blank rows.
//
// 2. A SUBMENU PARENT NEVER RESOLVES. Electron's template gives a parent no
//    `click` handler, so selecting it only opens the child. The repo
//    row's "New agent" (ReposSidebar.tsx) is exactly this shape, and it
//    is a primary browser flow — hence real nested menus here rather than a
//    flattened list.
//
// 3. DISMISSAL RESOLVES null, ONCE. Electron's `popup({ callback })` fires
//    on close whether or not something was clicked; the promise must settle
//    exactly once either way, or a caller awaiting it hangs forever. Every
//    exit path here goes through `settle()`, which is idempotent.
//
// Positioning uses the last pointer position observed on the document,
// captured on `contextmenu` and `pointerdown` in the CAPTURE phase so it is
// recorded before React's own handler (which is what calls `show`) runs.
// A native menu gets the cursor from the OS; this is the browser's
// equivalent, and it is why the controller — not `show` — owns listeners.
//
// Styling is inline and token-based (`var(--card)`, `var(--border)`, …) so
// the menu follows the app's light/dark theme without needing a stylesheet
// of its own; the fallbacks after each token keep it legible if it is ever
// mounted in a document that never loaded @cube/theme.
import type { ContextMenuItem } from "@port/shared/types";
import { formatShortcut } from "@port/shared/shortcuts";

const SEPARATOR_ID = "separator";

const MENU_STYLE = [
  "position:fixed",
  "z-index:2147483647",
  "min-width:180px",
  "max-width:320px",
  "padding:4px",
  "border-radius:8px",
  "border:1px solid var(--border, rgba(0,0,0,0.15))",
  "background:var(--card, #f2f2f2)",
  "color:var(--card-foreground, #111)",
  "box-shadow:0 8px 24px rgba(0,0,0,0.24)",
  "font-family:var(--font-sans, system-ui, sans-serif)",
  "font-size:13px",
  "outline:none",
  "overflow:auto",
  "max-height:calc(100vh - 16px)",
].join(";");

const ITEM_STYLE = [
  "display:flex",
  "align-items:center",
  "justify-content:space-between",
  "gap:12px",
  "padding:5px 8px",
  "border-radius:5px",
  "white-space:nowrap",
  "user-select:none",
  "outline:none",
].join(";");

const SEPARATOR_STYLE = [
  "height:1px",
  "margin:4px 6px",
  "background:var(--border, rgba(0,0,0,0.15))",
].join(";");

const BACKDROP_STYLE = ["position:fixed", "inset:0", "z-index:2147483646"].join(";");

/** Highlight for the active row — a token blend so it works in both themes. */
const ACTIVE_BACKGROUND = "var(--muted-background, rgba(127,127,127,0.18))";

/** All `place` needs of a window — and all a test has to fake. */
interface Viewport {
  innerWidth: number;
  innerHeight: number;
}

interface Entry {
  el: HTMLElement;
  item: ContextMenuItem;
  /** Separators and disabled items are rendered but never focusable. */
  selectable: boolean;
}

interface Panel {
  el: HTMLElement;
  entries: Entry[];
  /** Index into `entries`, or -1 for "nothing active yet". */
  active: number;
}

/**
 * How many menus are up, across every controller in the page. A native menu
 * is modal — while it is open the app's accelerators do not fire, because
 * the OS routes the key to the menu — and a DOM menu has to say so out loud:
 * the shortcut handler (desktop.ts) consults this, since its own listener is
 * capture-phase on `window` and therefore runs BEFORE the menu's
 * document-capture one.
 *
 * A counter rather than a boolean because two controllers (production has
 * one; a test makes several) must not be able to clear each other's flag.
 */
let openMenuCount = 0;

/** True while any context menu is up — see `openMenuCount`. */
export function isContextMenuOpen(): boolean {
  return openMenuCount > 0;
}

export interface ContextMenuController {
  /** Pops a menu and resolves the chosen item's id, or null if dismissed. */
  show(items: ContextMenuItem[]): Promise<string | null>;
  /** Cancels any open menu (resolving null) and detaches the pointer tracking. */
  dispose(): void;
}

function hasSubmenu(item: ContextMenuItem): boolean {
  return Array.isArray(item.submenu) && item.submenu.length > 0;
}

/**
 * Keeps a menu inside the viewport: flips it back over the anchor when it
 * would overflow, then clamps. Every rect is 0×0 in a DOM without layout
 * (happy-dom), which reduces this to "use the anchor as given" — correct,
 * and the reason it is written to tolerate zeroes rather than assume them.
 */
function place(el: HTMLElement, x: number, y: number, flipWidth: number, view: Viewport): void {
  const rect = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (rect.width > 0 && left + rect.width > view.innerWidth) {
    left = Math.max(0, left - rect.width - flipWidth);
  }
  if (rect.height > 0 && top + rect.height > view.innerHeight) {
    top = Math.max(0, view.innerHeight - rect.height);
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

export function createContextMenuController(doc: Document = document, platform = "linux"): ContextMenuController {
  const view: Viewport = doc.defaultView ?? { innerWidth: 0, innerHeight: 0 };
  let pointer = { x: 0, y: 0 };

  const trackPointer = (event: Event): void => {
    const mouse = event as MouseEvent;
    if (typeof mouse.clientX !== "number") return;
    pointer = { x: mouse.clientX, y: mouse.clientY };
  };
  doc.addEventListener("contextmenu", trackPointer, true);
  doc.addEventListener("pointerdown", trackPointer, true);

  let open: { close: (id: string | null) => void } | null = null;

  function show(items: ContextMenuItem[]): Promise<string | null> {
    // A second popup while one is up is a dismissal of the first, exactly as
    // a native menu behaves when another one is popped over it.
    open?.close(null);

    return new Promise<string | null>((resolve) => {
      const panels: Panel[] = [];
      let settled = false;

      const backdrop = doc.createElement("div");
      backdrop.setAttribute("data-context-menu-backdrop", "");
      backdrop.style.cssText = BACKDROP_STYLE;

      function settle(id: string | null): void {
        if (settled) return;
        settled = true;
        openMenuCount--;
        doc.removeEventListener("keydown", onKeyDown, true);
        backdrop.remove();
        for (const panel of panels) panel.el.remove();
        open = null;
        resolve(id);
      }

      function paintActive(panel: Panel): void {
        panel.entries.forEach((entry, index) => {
          entry.el.style.background = index === panel.active ? ACTIVE_BACKGROUND : "transparent";
        });
      }

      function activate(panel: Panel, index: number): void {
        panel.active = index;
        paintActive(panel);
        panel.entries[index]?.el.focus();
      }

      /** Closes every panel above `depth`. */
      function closeTo(depth: number): void {
        while (panels.length > depth + 1) {
          const panel = panels.pop()!;
          panel.el.remove();
        }
      }

      function choose(panel: Panel, entry: Entry): void {
        if (!entry.selectable) return;
        if (hasSubmenu(entry.item)) {
          openSubmenu(panel, entry);
          return;
        }
        settle(entry.item.id);
      }

      function openSubmenu(panel: Panel, entry: Entry): void {
        const depth = panels.indexOf(panel);
        closeTo(depth);
        const index = panel.entries.indexOf(entry);
        if (index >= 0) activate(panel, index);
        const rect = entry.el.getBoundingClientRect();
        const child = buildPanel(entry.item.submenu ?? []);
        place(child.el, rect.right, rect.top, rect.width, view);
        const first = child.entries.findIndex((e) => e.selectable);
        if (first >= 0) activate(child, first);
      }

      function buildPanel(items: ContextMenuItem[]): Panel {
        const el = doc.createElement("div");
        el.setAttribute("role", "menu");
        el.tabIndex = -1;
        el.style.cssText = MENU_STYLE;

        const panel: Panel = { el, entries: [], active: -1 };

        for (const item of items) {
          if (item.id === SEPARATOR_ID) {
            const rule = doc.createElement("div");
            rule.setAttribute("role", "separator");
            rule.style.cssText = SEPARATOR_STYLE;
            el.appendChild(rule);
            continue;
          }
          const row = doc.createElement("div");
          row.setAttribute("role", "menuitem");
          // The item's own id on the node: what a test (and a Playwright
          // smoke) matches on, since a parent row's text also carries its
          // chevron.
          row.setAttribute("data-menu-id", item.id);
          row.tabIndex = -1;
          const enabled = item.enabled !== false;
          row.setAttribute("aria-disabled", enabled ? "false" : "true");
          if (hasSubmenu(item)) row.setAttribute("aria-haspopup", "true");
          row.style.cssText = ITEM_STYLE;
          row.style.opacity = enabled ? "1" : "0.45";
          row.style.cursor = enabled ? "default" : "not-allowed";
          row.textContent = item.label;
          if (item.accelerator) {
            const shortcut = doc.createElement("span");
            shortcut.textContent = formatShortcut(item.accelerator, platform);
            shortcut.setAttribute("data-menu-shortcut", "");
            shortcut.style.opacity = "0.65";
            row.appendChild(shortcut);
          }
          if (hasSubmenu(item)) {
            const chevron = doc.createElement("span");
            chevron.textContent = "›";
            chevron.setAttribute("aria-hidden", "true");
            chevron.style.opacity = "0.6";
            row.appendChild(chevron);
          }

          const entry: Entry = { el: row, item, selectable: enabled };
          panel.entries.push(entry);

          row.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            choose(panel, entry);
          });
          row.addEventListener("mouseenter", () => {
            if (!entry.selectable) return;
            activate(panel, panel.entries.indexOf(entry));
            if (hasSubmenu(item)) openSubmenu(panel, entry);
            else closeTo(panels.indexOf(panel));
          });
          el.appendChild(row);
        }

        panels.push(panel);
        doc.body.appendChild(el);
        return panel;
      }

      function move(panel: Panel, delta: number): void {
        const count = panel.entries.length;
        if (count === 0) return;
        let index = panel.active;
        for (let step = 0; step < count; step++) {
          index = index < 0 ? (delta > 0 ? 0 : count - 1) : (index + delta + count) % count;
          if (panel.entries[index]?.selectable) {
            activate(panel, index);
            return;
          }
        }
      }

      function onKeyDown(event: KeyboardEvent): void {
        const panel = panels[panels.length - 1];
        if (!panel) return;
        const entry = panel.active >= 0 ? panel.entries[panel.active] : undefined;
        switch (event.key) {
          case "Escape":
            event.preventDefault();
            event.stopPropagation();
            if (panels.length > 1) {
              const child = panels.pop()!;
              child.el.remove();
              const back = panels[panels.length - 1]!;
              back.entries[back.active]?.el.focus();
            } else {
              settle(null);
            }
            return;
          case "ArrowDown":
            event.preventDefault();
            move(panel, 1);
            return;
          case "ArrowUp":
            event.preventDefault();
            move(panel, -1);
            return;
          case "ArrowRight":
            if (entry && hasSubmenu(entry.item)) {
              event.preventDefault();
              openSubmenu(panel, entry);
            }
            return;
          case "ArrowLeft":
            if (panels.length > 1) {
              event.preventDefault();
              const child = panels.pop()!;
              child.el.remove();
              const back = panels[panels.length - 1]!;
              back.entries[back.active]?.el.focus();
            }
            return;
          case "Home":
            event.preventDefault();
            panel.active = -1;
            move(panel, 1);
            return;
          case "End":
            event.preventDefault();
            panel.active = -1;
            move(panel, -1);
            return;
          case "Enter":
          case " ":
            if (!entry) return;
            event.preventDefault();
            choose(panel, entry);
            return;
          default:
            return;
        }
      }

      // mousedown, not click: a click that starts on the backdrop and ends
      // elsewhere still has to dismiss, and dismissing on the press is what
      // a native menu does.
      backdrop.addEventListener("mousedown", (event) => {
        if (event.target !== backdrop) return;
        event.preventDefault();
        settle(null);
      });
      backdrop.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        settle(null);
      });

      // Counted before the first node lands, released in settle() — which
      // every exit path goes through exactly once.
      openMenuCount++;
      doc.body.appendChild(backdrop);
      const root = buildPanel(items);
      place(root.el, pointer.x, pointer.y, 0, view);
      root.el.focus();
      doc.addEventListener("keydown", onKeyDown, true);

      open = { close: settle };
    });
  }

  return {
    show,
    dispose(): void {
      open?.close(null);
      doc.removeEventListener("contextmenu", trackPointer, true);
      doc.removeEventListener("pointerdown", trackPointer, true);
    },
  };
}
