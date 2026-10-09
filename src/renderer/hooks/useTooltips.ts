/**
 * The app's tooltip engine: one delegated listener that shows a styled
 * label for any element carrying `data-tooltip`.
 *
 * It is a document-level listener rather than a component because the
 * alternative — a Tooltip wrapper around each button — would put a wrapper
 * element inside flex rows whose geometry is carefully tuned (`.row-action`
 * inside `.checkout-row`, `.rail-pane-action` inside `.rail-pane-header`),
 * and a bare attribute costs those layouts nothing.
 *
 * It used to live inside the sidebar's file-panel component, in that
 * component's own `useEffect`, which worked only by accident: the panel
 * toggle and `SidebarFooter`'s Settings button already carried
 * `data-tooltip` from outside it, and they got tooltips solely because the
 * sidebar mounted that panel unconditionally and merely HID it when the
 * repos panel was showing. Anything that ever unmounted the files panel
 * would have silently taken the tooltips off two unrelated surfaces — as,
 * in the end, deleting it did. It is called once from `App`
 * now, which is where a document-level listener belongs and which is also
 * what lets the rail's pane headers — outside the sidebar entirely — use
 * it.
 *
 * `data-tooltip` and `title` are deliberately not both set on the same
 * element: the OS renders `title` itself, on its own delay, in its own
 * style, and a control carrying both shows two tooltips that disagree
 * about when to appear. Buttons keep `aria-label` for the accessible name.
 * Pair `data-tooltip` with `data-shortcut` to show a keyboard hint. Use
 * SHORTCUT_ACCELERATORS for app actions, or an accelerator such as "Escape"
 * for a local handler. Only label shortcuts the control's scope supports.
 */



import { useEffect } from "react";
import { formatShortcut } from "@port/shared/shortcuts";
import { services } from "../services";

/** Distance between the hovered element and the tooltip's near edge. */
const GAP_PX = 8;
/** Keep-out from the viewport's left and right edges. */
const EDGE_PX = 8;

export function useTooltips(): void {
  useEffect(() => {
    // Tooltips are a hover vocabulary, and this system listens on
    // mouseenter — which touch screens fire synthetically on tap, with no
    // matching mouseleave ever coming, so the label sticks to the screen
    // (the mobile branch shipped exactly that bug once). A device whose
    // primary pointer can't hover simply gets no tooltips; every
    // data-tooltip control also carries an aria-label. matchMedia is read
    // once per mount rather than watched: hover capability changes only
    // with hardware, and a hybrid device that starts mouse-first keeps
    // tooltips harmlessly.
    if (window.matchMedia("(hover: none)").matches) return;
    let tooltipEl: HTMLDivElement | null = null;
    let activeTarget: Element | null = null;

    function show(target: Element) {
      if (target === activeTarget) return;
      activeTarget = target;
      const label = (target as HTMLElement).dataset.tooltip;
      if (!label) return;

      if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.className = "app-tooltip";
        document.body.appendChild(tooltipEl);
      }

      tooltipEl.textContent = label;
      const shortcut = (target as HTMLElement).dataset.shortcut;
      if (shortcut) {
        const keys = document.createElement("kbd");
        keys.className = "app-tooltip-shortcut";
        keys.textContent = formatShortcut(shortcut, services.desktop.getPlatform());
        tooltipEl.append(keys);
      }

      // Measured unpositioned and invisible first: the width depends on the
      // label just assigned, and centring needs that width before the box
      // can be placed.
      const rect = target.getBoundingClientRect();
      tooltipEl.classList.remove("visible");
      tooltipEl.style.left = "";
      tooltipEl.style.top = "";

      const tw = tooltipEl.offsetWidth;
      const th = tooltipEl.offsetHeight;
      const vw = window.innerWidth;

      let left = rect.left + rect.width / 2 - tw / 2;
      if (left + tw > vw - EDGE_PX) left = vw - EDGE_PX - tw;
      if (left < EDGE_PX) left = EDGE_PX;

      // Above the target, except when there is no room — a pane header sits
      // near the window's top edge, and a tooltip placed off-screen there
      // reads as the button simply having none.
      const above = rect.top - th - GAP_PX;
      tooltipEl.style.left = `${left}px`;
      tooltipEl.style.top = `${above < EDGE_PX ? rect.bottom + GAP_PX : above}px`;

      if ((target as HTMLElement).dataset.tooltipSide === "right") {
        tooltipEl.style.left = `${Math.min(rect.right + GAP_PX, vw - EDGE_PX - tw)}px`;
        tooltipEl.style.top = `${Math.max(EDGE_PX, Math.min(rect.top + (rect.height - th) / 2, window.innerHeight - EDGE_PX - th))}px`;
      }

      requestAnimationFrame(() => {
        // Leaving or clicking before this frame must not resurrect the label.
        if (activeTarget === target && target.isConnected) tooltipEl?.classList.add("visible");
      });
    }

    function hide() {
      activeTarget = null;
      tooltipEl?.classList.remove("visible");
    }

    const onEnter = (e: Event) => {
      const target = (e.target as Element)?.closest?.("[data-tooltip]");
      if (target) show(target);
    };
    const onLeave = (e: MouseEvent) => {
      const leaving = (e.target as Element)?.closest?.("[data-tooltip]");
      if (!leaving) return;
      const entering = (e.relatedTarget as Element)?.closest?.("[data-tooltip]");
      if (entering === leaving) return;
      hide();
    };
    // A click that opens a context menu or a modal leaves the pointer over
    // a control that is about to be covered, and the tooltip would outlive
    // the surface it labels.
    const onDown = () => hide();

    document.addEventListener("mouseenter", onEnter, true);
    document.addEventListener("mouseleave", onLeave as EventListener, true);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", hide);

    return () => {
      document.removeEventListener("mouseenter", onEnter, true);
      document.removeEventListener("mouseleave", onLeave as EventListener, true);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", hide);
      tooltipEl?.remove();
    };
  }, []);
}
