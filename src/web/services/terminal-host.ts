import { copyText } from './clipboard';
import type { TerminalHost, DataListener } from '../../components/Terminal/host';
import type { BuilderServices } from './types';
import { bytesToBase64 } from './assets';
export function createTerminalHost(api: BuilderServices, cwd: string, report: (error: unknown) => void): TerminalHost {
  const streams = new Map<DataListener, () => void>();
  const send = (promise: Promise<unknown>) => { void promise.catch(report); };
  return {
    getPlatform: () => /Mac/.test(navigator.platform) ? 'darwin' : 'linux',
    openExternal: url => { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); },
    ptyWrite: (id, text) => send(api.call('terminals.write', { id, bytes: bytesToBase64(new TextEncoder().encode(text)) })),
    ptyResize: (id, cols, rows) => send(api.call('terminals.resize', { id, cols, rows })),
    writeClipboardText: copyText,
    onPtyData(id, callback) {
      let firstRead = true;
      let cursor = 0, running = false, pending = false, closed = false;
      async function drain() {
        pending = true; if (running || closed) return; running = true;
        try {
          while (pending && !closed) {
            pending = false;
            const result = await api.call('terminals.read', { id, since: cursor, maxBytes: 1024 * 1024 });
            if (closed) break;
            const replay = firstRead || result.reset; firstRead = false;
            if (result.reset || cursor === 0) callback({ sessionId: id, data: new TextEncoder().encode((result.reset ? '\x1bc' : '') + result.modes), replay });
            callback({ sessionId: id, data: Uint8Array.from(atob(result.data), c => c.charCodeAt(0)), replay });
            cursor = result.seq;
          }
        } catch (error) { if (!closed) report(error); }
        finally { running = false; }
      }
      // Subscribe before reading. Events arriving during a read request another
      // cursor-based read, so neither overlap nor a reconnect can duplicate bytes.
      const unsubscribe = api.subscribe(event => {
        if (event.type === 'snapshot' || (event.type === 'terminal' && event.event.id === id)) void drain();
      });
      streams.set(callback, () => { closed = true; unsubscribe(); });
      void drain();
    },
    offPtyData(_id, callback) { streams.get(callback)?.(); streams.delete(callback); },
    async ptyStashFile(_id, data, mime, name) {
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mime];
      if (!name && !extension) throw new Error('Unsupported pasted image format');
      const result = await api.call('files.upload', { directory: cwd, name: name ?? `pasted-${crypto.randomUUID()}.${extension}`, data });
      return { path: result.path };
    },
    isDirectory: async path => (await api.call('files.stat', { path })).directory,
    onShellBlur(callback) { window.addEventListener('blur', callback); return () => window.removeEventListener('blur', callback); },
  };
}
