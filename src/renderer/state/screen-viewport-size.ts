import type { ScreenViewportSize } from "./screen-ops";

// Read live geometry only when opening a pane. Resizing never rearranges a screen.
type SizeProvider = () => ScreenViewportSize | null;
let provider: SizeProvider | null = null;

export function setScreenViewportProvider(next: SizeProvider): () => void {
  provider = next;
  return () => { if (provider === next) provider = null; };
}

export function screenViewportSize(): ScreenViewportSize | null {
  return provider?.() ?? null;
}
