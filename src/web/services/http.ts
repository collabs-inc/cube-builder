import type { BuilderServices } from './types.js';
import type { MethodMap, MethodName } from '../../shared/methods.js';
import type { BuilderEvent } from '../../shared/events.js';
export const services: BuilderServices = {
  async call<K extends MethodName>(method: K, params: MethodMap[K]['params']): Promise<MethodMap[K]['result']> {
    const response = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), method, params }) });
    if (!response.ok) throw new Error(`Builder request failed (${response.status})`);
    const reply = await response.json();
    if (!reply.ok) throw Object.assign(new Error(reply.error?.message ?? 'Builder operation failed'), { code: reply.error?.code });
    return reply.result;
  },
  subscribe(callback, status) {
    let stopped = false; let socket: WebSocket | undefined; let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 250;
    function connect() {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
      socket.onopen = () => { delay = 250; status?.(true); };
      socket.onmessage = event => { try { callback(JSON.parse(event.data) as BuilderEvent); } catch { /* Ignore malformed events; next snapshot reconciles state. */ } };
      socket.onclose = () => { status?.(false); if (!stopped) { retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 5000); } };
    }
    connect();
    return () => { stopped = true; clearTimeout(retry); socket?.close(); };
  },
};
