// Adapted from packages/components/src/Terminal/wrapped-link.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import type { IBuffer, IBufferRange, Terminal } from '@xterm/xterm';

/** Expand only displayed URL text on soft-wrapped rows. Labels and hard
 * newlines retain xterm's own range and destination handling. */
export function wrappedUrlRange(buffer: Pick<IBuffer, 'getLine'>, cols: number, uri: string, hovered: IBufferRange): IBufferRange | null {
  if (!/^https?:\/\//i.test(uri) || cols <= 0) return null;
  const limit = Math.ceil(uri.length / cols) + 2;
  let first = hovered.start.y - 1, last = hovered.end.y - 1;
  for (let n = 0; n < limit && first > 0 && buffer.getLine(first)?.isWrapped; n++) first--;
  for (let n = 0; n < limit && buffer.getLine(last + 1)?.isWrapped; n++) last++;
  let text = '';
  const cells: { x: number; y: number }[] = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) return null;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      if (cell?.getWidth() === 0) continue;
      const chars = cell?.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1 });
    }
  }
  for (let offset = text.indexOf(uri); offset >= 0; offset = text.indexOf(uri, offset + 1)) {
    const start = cells[offset]!, end = cells[offset + uri.length - 1]!;
    const contains = (p: {x:number;y:number}) => (p.y > start.y || p.y === start.y && p.x >= start.x) && (p.y < end.y || p.y === end.y && p.x <= end.x);
    if (start.y !== end.y && contains(hovered.start) && contains(hovered.end)) return { start, end };
  }
  return null;
}

/** Public xterm hover hooks supplement its row-only OSC 8 underline. No
 * private renderer APIs or changes to activation/selection are required. */
export function installWrappedLinkHighlight(term: Terminal): () => void {
  const original = term.options.linkHandler;
  if (!original) return () => {};
  let overlay: HTMLElement | undefined;
  let active: { uri: string; range: IBufferRange; buffer: IBuffer } | undefined;
  const clear = () => { overlay?.remove(); overlay = undefined; active = undefined; };
  const handler = {
    ...original,
    hover(event: MouseEvent, uri: string, range: IBufferRange) {
      clear(); original.hover?.(event, uri, range);
      const full = wrappedUrlRange(term.buffer.active, term.cols, uri, range);
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
      if (!full || !screen) return;
      active = { uri, range: full, buffer: term.buffer.active };
      overlay = document.createElement('div');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.className = 'terminal-wrapped-link-highlight';
      Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '10', color: term.options.theme?.foreground ?? 'currentColor' });
      for (let y = full.start.y; y <= full.end.y; y++) {
        const row = y - 1 - term.buffer.active.viewportY;
        if (row < 0 || row >= term.rows) continue;
        const left = y === full.start.y ? full.start.x - 1 : 0;
        const end = y === full.end.y ? full.end.x : term.cols;
        const line = document.createElement('div');
        Object.assign(line.style, { position: 'absolute', left: `${left / term.cols * 100}%`, width: `${(end-left) / term.cols * 100}%`, top: `calc(${(row+1) / term.rows * 100}% - 1px)`, borderBottom: '1px solid currentColor' });
        overlay.append(line);
      }
      screen.append(overlay);
    },
    leave(event: MouseEvent, uri: string, range: IBufferRange) { clear(); original.leave?.(event, uri, range); },
  };
  term.options.linkHandler = handler;
  const checkContent = () => {
    if (!active) return;
    const full = wrappedUrlRange(term.buffer.active, term.cols, active.uri, active.range);
    if (term.buffer.active !== active.buffer || !full ||
      full.start.x !== active.range.start.x || full.start.y !== active.range.start.y ||
      full.end.x !== active.range.end.x || full.end.y !== active.range.end.y) clear();
  };
  const listeners = [term.onScroll?.(clear), term.onResize?.(clear), term.onWriteParsed?.(checkContent)];
  return () => { clear(); listeners.forEach(listener => listener?.dispose()); if (term.options.linkHandler === handler) term.options.linkHandler = original; };
}
