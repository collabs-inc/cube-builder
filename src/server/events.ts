import { WebSocket, type WebSocketServer } from 'ws';
import type { BuilderEvent } from '../shared/events.js';
export function broadcast(sockets: WebSocketServer, event: BuilderEvent): void {
  const data = JSON.stringify(event);
  for (const socket of sockets.clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, 'Reconnect to replay terminal output'); continue; }
    socket.send(data);
  }
}
