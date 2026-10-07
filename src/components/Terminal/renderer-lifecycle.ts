// Adapted from packages/components/src/Terminal/renderer-lifecycle.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import type { ITerminalAddon } from "@xterm/xterm";

// Hidden keep-alive terminals count too. Leave GPU capacity for the rest of the app.
const MAX_GPU_TERMINALS = 8;
let gpuTerminals = 0;

interface RendererHost {
  rows: number;
  loadAddon(addon: ITerminalAddon): void;
  refresh(start: number, end: number): void;
  onRender(listener: () => void): { dispose(): void };
}

/** A bounded GPU renderer with an immediate, in-place DOM fallback. */
export function installTerminalRenderer(
  terminal: RendererHost,
  container: HTMLElement,
  createAddon: () => ITerminalAddon,
): () => void {
  container.dataset.terminalRenderer = "dom";
  if (gpuTerminals >= MAX_GPU_TERMINALS) return () => {};
  gpuTerminals++;
  let alive = true;
  let released = false;
  let addon: ITerminalAddon | undefined;
  let loading: HTMLDivElement | undefined;
  let paint: { dispose(): void } | undefined;

  const release = (): void => {
    if (released) return;
    released = true;
    gpuTerminals--;
    container.removeEventListener("webglcontextlost", onLoss, true);
    // Disposing the addon restores xterm's DOM renderer without losing its buffer.
    try { addon?.dispose(); } catch { /* Initialization may have failed partway through. */ }
    container.dataset.terminalRenderer = "dom";
  };
  const clearLoading = (): void => {
    paint?.dispose();
    paint = undefined;
    loading?.remove();
    loading = undefined;
  };
  const onLoss = (event: Event): void => {
    if (released || loading || !(event.target instanceof HTMLCanvasElement)) return;
    // Capture before xterm's listener: it otherwise waits three seconds before
    // falling back, leaving Chromium's lost-canvas placeholder on screen.
    event.preventDefault();
    event.stopImmediatePropagation();
    event.target.style.visibility = "hidden";
    loading = container.ownerDocument.createElement("div");
    loading.className = "terminal-renderer-loading";
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-label", "Restoring terminal display");
    container.append(loading);
    queueMicrotask(() => {
      if (!alive) return;
      paint = terminal.onRender(clearLoading);
      release();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
  };
  container.addEventListener("webglcontextlost", onLoss, true);
  try {
    addon = createAddon();
    terminal.loadAddon(addon);
    container.dataset.terminalRenderer = "webgl";
  } catch {
    release();
  }
  return () => {
    alive = false;
    clearLoading();
    release();
  };
}
