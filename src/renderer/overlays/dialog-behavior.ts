/**
 * The keyboard and focus behaviour every modal surface in this app shares,
 * lifted out of Dialog.tsx (#69) so SettingsModal can join it instead of
 * hand-rolling a second implementation.
 *
 * The point of sharing is the STACK. Only the topmost surface reacts to
 * keys, which is what makes a confirm raised from inside Settings cancel
 * itself without also closing the panel underneath it. A surface that keeps
 * its own listener sits outside that stack, and the ordering then holds only
 * by accident — which is exactly the bug #69 reports: SettingsModal's
 * window-level Escape listener fired after Dialog's capture-phase one had
 * already consumed the key, so one press cancelled the confirm AND threw
 * away the panel it was raised from.
 *
 * Extracted verbatim: same code, same order, same listener. Dialog.test.tsx
 * is the guard on that and did not change when this moved.
 */



import { useEffect, useRef, type RefObject } from "react";
import { initialFocusTarget, nextFocusTarget } from "./dialog-focus";

/**
 * Only the topmost surface reacts to keys. Two surfaces are stacked rarely
 * but really (a confirm raised over a picker, or over Settings), and without
 * this both would trap Tab and both would close on one Escape.
 */
const stack: symbol[] = [];

export interface DialogBehaviorOptions {
  /** Escape routes here. */
  onClose: () => void;
  /**
   * Enter's action, handled at the document level. Opt-in: a surface whose
   * body has its own Enter semantics (a repo list where Enter activates the
   * focused option) must not have them swallowed here.
   *
   * `| undefined` is explicit because the project sets
   * `exactOptionalPropertyTypes`: Dialog forwards its own optional prop
   * straight through, so the value really can arrive as undefined rather
   * than being absent.
   */
  onEnter?: (() => void) | undefined;
}

/**
 * Wires one modal surface into the shared stack: focus entry on mount, a Tab
 * cycle that cannot leave `rootRef`, Escape and optional Enter while topmost,
 * and focus restored to whatever was focused before, on unmount.
 */
export function useDialogBehavior(
  rootRef: RefObject<HTMLElement | null>,
  { onClose, onEnter }: DialogBehaviorOptions,
): void {
  // The effect below must run exactly once per surface: it captures the
  // element to restore focus to and moves focus in. Keying it on the
  // callbacks instead would re-run it on every render a caller triggers
  // (`pending` flipping a button's label, say), re-capturing "previously
  // focused" as something already inside the surface and yanking focus back
  // to the initial target mid-interaction. Refs keep the handlers current
  // without making them dependencies.
  const handlers = useRef({ onClose, onEnter });
  handlers.current = { onClose, onEnter };

  useEffect(() => {
    const token = Symbol("dialog");
    stack.push(token);
    const isTopmost = () => stack[stack.length - 1] === token;

    // Captured before focus moves, restored on unmount — otherwise closing a
    // surface drops focus on <body> and the next Tab restarts from the top of
    // the app rather than from whatever opened it.
    const previouslyFocused = document.activeElement;
    const opened = rootRef.current;
    if (opened) initialFocusTarget(opened).focus();

    // Capture phase, on the document: focus may legitimately sit on the
    // surface container itself, and a bubble-phase listener on the shell
    // would then miss keys aimed at anything outside it.
    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !isTopmost()) return;
      if (e.key === "Escape") {
        // Consumed in the capture phase, always: Sidebar.tsx's narrow drawer
        // listens on document in the BUBBLE phase and bails on
        // defaultPrevented, so acting any later would let one Escape close
        // the drawer and this surface both.
        e.preventDefault();
        // A nested dismissible layer — a combobox popup — owns Escape while
        // it is open. Its own React onKeyDown runs immediately after this
        // capture listener and closes it; the surface stays put. Declarative
        // on purpose: no registry, no context, and greppable from either side.
        if (root.querySelector("[data-escape-claimant]")) return;
        handlers.current.onClose();
        return;
      }
      // An Enter that commits an input method's composition belongs to the field.
      if (e.key === "Enter" && !e.isComposing && handlers.current.onEnter) {
        e.preventDefault();
        handlers.current.onEnter();
        return;
      }
      if (e.key === "Tab") {
        const target = nextFocusTarget(root, document.activeElement, e.shiftKey);
        if (!target) return;
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const index = stack.indexOf(token);
      if (index !== -1) stack.splice(index, 1);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [rootRef]);
}
