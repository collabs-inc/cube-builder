/**
 * The web build's accidental-close interceptor. Cmd/Ctrl+W is a
 * browser-reserved shortcut: no page can capture it (preventDefault on the
 * keydown is ignored in every engine, installed PWAs included), so the one
 * lever a tab has is `beforeunload` — which turns an instant close into a
 * "Leave site?" confirm. That is the VS Code web / Codespaces answer to
 * the same habit, and the blast radius here is already low (PTYs live on
 * the machine; a closed tab loses arrangement context, never a session).
 *
 * Detection is the `web-host` class src/windows/web/main.tsx puts on the
 * root element, same as narrow-history.ts — on Electron this installs
 * nothing (the desktop's own Cmd+W means "hide pane" and must stay
 * uninterrupted).
 *
 * The condition is evaluated at fire time rather than armed/disarmed by a
 * subscription: the prompt appears only when this client has items open
 * (`mountedItemIds` non-empty — hidden items count, deliberately, since
 * hide-then-close would otherwise sidestep the guard). A signed-out or
 * empty-workspace tab closes silently. Browsers additionally require a
 * user gesture before honoring the prompt at all, so a background tab a
 * user never touched still closes clean.
 */



import { workspaceStore } from "./workspace";

let installed = false;

function isWebHost(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("web-host");
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (workspaceStore.getSnapshot().mountedItemIds.length === 0) return;
  event.preventDefault();
  // Chromium historically keys the prompt off returnValue, not
  // preventDefault; setting both is the cross-engine spelling.
  event.returnValue = "";
}

/** Idempotent; returns a disposer. A no-op (noop disposer) off the web. */
export function installUnloadGuard(): () => void {
  if (installed || !isWebHost()) return () => {};
  installed = true;
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    installed = false;
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}

export function _resetForTest(): void {
  installed = false;
  window.removeEventListener("beforeunload", onBeforeUnload);
}
