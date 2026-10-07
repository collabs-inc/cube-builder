import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { Registry } from './registry.js';
import { WorkerClient } from './worker-client.js';
import { BuilderError } from '../shared/errors.js';
import type { TerminalItem } from '../shared/model.js';
import type { TerminalCreate } from '../shared/methods.js';
import type { TerminalEvent } from '../shared/terminal-protocol.js';
import { text, integer } from './validation.js';

export class Terminals extends EventEmitter {
  constructor(private registry: Registry, private worker: WorkerClient) {
    super(); worker.on('event', this.onEvent);
  }
  private onEvent = (event: TerminalEvent) => {
    const item = this.registry.snapshot().items.find(i => i.type === 'term' && i.sessionId === event.id);
    if (!item) return;
    this.emit('event', { ...event, id: item.id });
    if (event.type === 'exit') void this.registry.mutate(null, draft => {
      const row = draft.items.find(i => i.id === item.id);
      if (row?.type === 'term') { row.exited = true; row.exitCode = event.exitCode; row.updatedAt = new Date().toISOString(); }
    }).catch(error => this.emit('failure', error));
  };
  async reconcile() {
    const live = await this.worker.list();
    const rows = this.registry.snapshot().items.filter((i): i is TerminalItem => i.type === 'term');
    if (!rows.some(row => { const s = live.find(s => s.id === row.sessionId); return row.exited !== (s?.exited ?? true) || row.exitCode !== (s?.exitCode ?? null); })) return;
    await this.registry.mutate(null, draft => {
      for (const row of draft.items) if (row.type === 'term') { const s = live.find(s => s.id === row.sessionId); row.exited = s?.exited ?? true; row.exitCode = s?.exitCode ?? null; }
    });
  }
  async create(params: TerminalCreate): Promise<TerminalItem> {
    const requestId = text(params.requestId, 'request ID', 160);
    const existing = this.registry.snapshot().items.find((i): i is TerminalItem => i.type === 'term' && i.requestId === requestId);
    if (existing) return existing;
    const cwd = text(params.cwd, 'working directory');
    const command = text(params.command ?? process.env.SHELL ?? '/bin/sh', 'command');
    const args = params.args ?? [];
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0')) || args.length > 100) throw new BuilderError('invalid-request', 'Invalid command arguments');
    const session = await this.worker.spawn({ requestId, cwd, command, args, cols: integer(params.cols ?? 80, 'columns', 1, 1000), rows: integer(params.rows ?? 24, 'rows', 1, 1000) });
    const now = new Date().toISOString();
    const item: TerminalItem = { id: session.id, type: 'term', repoId: params.repoId ?? null, cwd, title: basename(command), createdAt: now, updatedAt: now, requestId, sessionId: session.id, command, args, exited: session.exited, exitCode: session.exitCode };
    const snapshot = await this.registry.mutate(null, draft => { if (!draft.items.some(i => i.id === item.id)) draft.items.push(item); });
    // The child can exit before the registry write completes.
    await this.reconcile();
    return snapshot.items.find(i => i.id === item.id) as TerminalItem;
  }
  private item(id: unknown): TerminalItem {
    text(id, 'terminal ID', 160);
    const item = this.registry.snapshot().items.find(i => i.id === id);
    if (item?.type !== 'term') throw new BuilderError('item-missing', 'Terminal no longer exists');
    return item;
  }
  read(params: { id: string; since: number; maxBytes?: number }) { const row = this.item(params.id); return this.worker.read(row.sessionId, { since: params.since, maxBytes: params.maxBytes }); }
  write(params: { id: string; bytes: string }) { const row = this.item(params.id); return this.worker.write(row.sessionId, params.bytes); }
  resize(params: { id: string; cols: number; rows: number }) { const row = this.item(params.id); return this.worker.resize(row.sessionId, params.cols, params.rows); }
  async close(id: string) { const row = this.item(id); await this.worker.kill(row.sessionId); await this.registry.mutate(null, draft => { draft.items = draft.items.filter(i => i.id !== id); }); }
  async stopAll() { await this.worker.stopAll(); await this.reconcile(); }
  dispose() { this.worker.off('event', this.onEvent); }
}
