/**
 * Terminal key bar for the narrow item screen — Esc, Tab, ^C, the arrows
 * and Paste, the inputs a phone keyboard cannot produce (key-bar-keys.ts
 * has the delivery rationale). Rendered by App.tsx as the flex sibling
 * BELOW the rail, only while the active item is a terminal: a note or a
 * file has a real editor with its own keyboard handling.
 *
 * The buttons never take focus. Focus leaving xterm's textarea is what
 * dismisses the soft keyboard, so a tap that stole it would close the
 * keyboard on every arrow press. `preventDefault` on pointerdown covers a
 * mouse; iOS Safari moves focus on the TOUCH events instead, and only a
 * non-passive `touchstart` listener can cancel that — React registers
 * touch listeners passive, so the bar attaches its own natively. Without
 * it every tap blurred the textarea (keyboard down) while xterm's keyup
 * handler focused it again (keyboard up): a toggle on every key.
 * Cancelling touchstart also cancels the synthesized click, which is why
 * Paste fires on pointerup rather than onClick. No data-tooltip, like
 * the rest of the mobile chrome (hover-driven tooltips strand on touch).
 */



import { useEffect, useRef } from "react";
import { ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import type { Icon } from '@phosphor-icons/react';
import "./MobileKeyBar.css";
import { useCatalog } from "../state/catalog";
import { useWorkspace } from "../state/workspace";
import { CLEAR_KEY, KEY_BAR_KEYS, pasteIntoTerminal, sendKeyBarKey, type KeyBarKey } from "./key-bar-keys";
import { startRepeat } from "./press-repeat";
import { MobileAttachments } from "./MobileAttachments";

const keepFocus = (e: React.PointerEvent) => e.preventDefault();
const KEY_ICONS: Partial<Record<string, Icon>> = { ArrowLeft, ArrowUp, ArrowDown, ArrowRight };

export function MobileKeyBar() {
  const { activeItemId } = useWorkspace();
  const catalog = useCatalog();
  const item = catalog.items.find((i) => i.id === activeItemId);
  // The held key's repeat, stopped on release, on a cancelled touch, and
  // on unmount (the item screen going away under a held finger).
  const stopRepeat = useRef<(() => void) | null>(null);
  const release = () => {
    stopRepeat.current?.();
    stopRepeat.current = null;
  };
  useEffect(() => release, []);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const keepFocusOnTouch = (e: TouchEvent) => e.preventDefault();
    bar.addEventListener("touchstart", keepFocusOnTouch, { passive: false });
    return () => bar.removeEventListener("touchstart", keepFocusOnTouch);
  }, [item?.type]);
  if (item?.type !== "term") return null;

  // Keys send on pointerDOWN (a hardware key does too), and hold to
  // repeat (press-repeat.ts) — so there is no onClick here, which would
  // send a second copy on release. Pointer capture keeps the release
  // event on the button a finger slid off of.
  const press = (k: KeyBarKey) => (e: React.PointerEvent<HTMLButtonElement>) => {
    keepFocus(e);
    release();
    if (typeof e.currentTarget.setPointerCapture === "function") {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // A pointer that is already gone (synthetic events) has no capture.
      }
    }
    stopRepeat.current = startRepeat(() => sendKeyBarKey(k));
  };

  const keyButton = (k: KeyBarKey) => {
    const KeyIcon = KEY_ICONS[k.presses[0]?.key ?? ""];
    return (
      <button
        key={k.name}
        type="button"
        tabIndex={-1}
        className={k.wide ? "mobile-key mobile-key-word" : "mobile-key"}
        aria-label={k.name}
        onPointerDown={press(k)}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onContextMenu={(e) => e.preventDefault()}
      >
        {KeyIcon ? <KeyIcon size={16} aria-hidden="true" /> : k.label}
      </button>
    );
  };

  return (
    <div className="mobile-key-bar" role="toolbar" aria-label="Terminal keys" ref={barRef}>
      {KEY_BAR_KEYS.map(keyButton)}
      <button
        type="button"
        tabIndex={-1}
        className="mobile-key mobile-key-word"
        aria-label="Paste"
        onPointerDown={keepFocus}
        onPointerUp={() => void pasteIntoTerminal()}
      >
        paste
      </button>
      {/* Keep Clear away from the arrows — see CLEAR_KEY. */}
      {keyButton(CLEAR_KEY)}
      <MobileAttachments key={item.id} />
    </div>
  );
}
