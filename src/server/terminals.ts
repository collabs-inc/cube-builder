import { browserCommand } from './browser.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCommand } from './agents.js';
import { Attention } from './attention.js';
import { AgentSessions } from './agent-sessions.js';
import { injectAttentionArgs } from './attention/hooks.js';
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
  private attention: Attention;
  private agentSessions: AgentSessions;
  private launching = new Map<string, Promise<TerminalItem>>();
  constructor(private registry: Registry, private worker: WorkerClient) {
    super(); this.attention = new Attention(registry, error => this.emit('failure', error));
    this.agentSessions=new AgentSessions(registry,()=>worker.list());
    worker.on('event', this.onEvent);
  }
  private onEvent = (event: TerminalEvent) => {
    const item = this.registry.snapshot().items.find(i => i.type === 'term' && i.sessionId === event.id);
    if (!item) return;
    if (event.type === 'data') this.attention.output(item.id, Buffer.from(event.data, 'base64'), event.seq);
    else this.attention.exited(item.id);
    this.emit('event', { ...event, id: item.id });
    if (event.type === 'exit') void this.registry.mutate(null, draft => {
      const row = draft.items.find(i => i.id === item.id);
      if (row?.type === 'term' && row.sessionId === event.id) { row.exited = true; row.exitCode = event.exitCode; row.updatedAt = new Date().toISOString(); }
    }).catch(error => this.emit('failure', error));
  };
  async reconcile() {
    const live = await this.worker.list();
    const rows = this.registry.snapshot().items.filter((i): i is TerminalItem => i.type === 'term');
    const missing = live.filter(s => !rows.some(row => row.sessionId === s.id || row.supersededSessionIds?.includes(s.id)));
    if (!missing.length && !rows.some(row => { const s = live.find(s => s.id === row.sessionId); return row.exited !== (s?.exited ?? true) || row.exitCode !== (s?.exitCode ?? null); })) return;
    await this.registry.mutate(null, draft => {
      for (const session of missing) {
        if (draft.items.some(i => i.type === 'term' && i.sessionId === session.id)) continue;
        const r = session.recovery;
        const recoveredId=r?.catalogItemId??session.id;
        const index=draft.items.findIndex(i=>i.id===recoveredId);
        const previous=draft.items[index];
        const recovered:TerminalItem={ ...previous, id: recoveredId, supersededSessionIds:r?.supersededSessionIds,agentSessionId:r?.agentSessionId,resumed:r?.resumed,type: 'term', repoId: r?.repoId ?? null, cwd: session.cwd, title: basename(session.command), createdAt: previous?.createdAt??session.createdAt, updatedAt: session.createdAt, requestId: session.requestId, sessionId: session.id, command: session.command, args: r?.args ?? session.args, harness: r?.harness, launchId: r?.launchId, attentionHooks: r?.attentionHooks, exited: session.exited, exitCode: session.exitCode };
        if(index<0)draft.items.push(recovered);else draft.items[index]=recovered;
      }
      for (const row of draft.items) if (row.type === 'term') { const s = live.find(s => s.id === row.sessionId); row.exited = s?.exited ?? true; row.exitCode = s?.exitCode ?? null; }
    });
    for (const item of this.registry.snapshot().items) if (item.type === 'term') this.attention.register(item);
  }
  create(params: TerminalCreate): Promise<TerminalItem> {
    const requestId = text(params.requestId, 'request ID', 160);
    const key=params.catalogItemId?`item:${params.catalogItemId}`:requestId;
    const pending = this.launching.get(key); if (pending) return pending;
    const task = this.createNew(params).finally(() => this.launching.delete(key));
    this.launching.set(key, task); return task;
  }
  private async createNew(params: TerminalCreate): Promise<TerminalItem> {
    const requestId = text(params.requestId, 'request ID', 160);
    const existing = this.registry.snapshot().items.find((i): i is TerminalItem => i.type === 'term' && i.requestId === requestId);
    if (existing) return existing;
    const previous=params.catalogItemId?this.item(params.catalogItemId):undefined;
    if(previous&&!previous.exited)return previous;
    const supersededSessionIds=previous?[...(previous.supersededSessionIds??[]),previous.sessionId]:undefined;
    const cwd = text(params.cwd, 'working directory');
    const requested = text(params.command ?? params.harness ?? process.env.SHELL ?? '/bin/sh', 'command');
    const command = await resolveCommand(requested, process.env.PATH, cwd);
    const args = params.args ?? [];
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0')) || args.length > 100) throw new BuilderError('invalid-request', 'Invalid command arguments');
    const harness = params.harness ? text(params.harness, 'agent harness', 80) : undefined;
    const launchId = randomUUID(), spool = join(this.registry.stateDir, 'attention');
    await mkdir(spool, { recursive: true, mode: 0o700 });
    const injected = harness ? injectAttentionArgs(harness, command, args, spool, launchId, process.env) : null;
    const session = await this.worker.spawn({ recovery: { catalogItemId:params.catalogItemId,supersededSessionIds,agentSessionId:params.agentSessionId,resumed:params.resumed,repoId: params.repoId ?? null, harness, launchId, attentionHooks: !!injected, args }, requestId, cwd, command, args: injected?.args ?? args, env: { ...injected?.env, BROWSER: await browserCommand(this.registry.stateDir) }, cols: integer(params.cols ?? 80, 'columns', 1, 1000), rows: integer(params.rows ?? 24, 'rows', 1, 1000) });
    const now = new Date().toISOString();
    const item: TerminalItem = { ...previous, id: previous?.id??session.id, supersededSessionIds,agentSessionId:params.agentSessionId,resumed:params.resumed,type: 'term', repoId: params.repoId ?? null, cwd, title: basename(command), createdAt: previous?.createdAt??now, updatedAt: now, requestId, sessionId: session.id, command, args, harness, launchId, attentionHooks: !!injected, attention: harness ? 'idle' : undefined, exited: session.exited, exitCode: session.exitCode };
    await this.registry.mutate(null, draft => {
      const index=draft.items.findIndex(i=>i.id===item.id);
      if(index>=0&&previous)draft.items[index]=item;
      else if(index<0)draft.items.push(item);
    });
    if(previous)await this.worker.forget(previous.sessionId).catch(error=>{if(!(error instanceof BuilderError)||error.code!=='session-missing')throw error});
    // The child can exit before the registry write completes.
    this.attention.register(item);
    await this.reconcile();
    return this.registry.snapshot().items.find(i => i.id === item.id) as TerminalItem;
  }
  private item(id: unknown): TerminalItem {
    text(id, 'terminal ID', 160);
    const item = this.registry.snapshot().items.find(i => i.id === id);
    if (item?.type !== 'term') throw new BuilderError('item-missing', 'Terminal no longer exists');
    return item;
  }
  read(params: { id: string; since: number; maxBytes?: number }) { const row = this.item(params.id); return this.worker.read(row.sessionId, { since: params.since, maxBytes: params.maxBytes }); }
  async write(params: { id: string; bytes: string }) { const row = this.item(params.id); await this.worker.write(row.sessionId, params.bytes); this.attention.input(row.id, Buffer.from(params.bytes, 'base64')); }
  resize(params: { id: string; cols: number; rows: number }) { const row = this.item(params.id); if (!row.exited) return this.worker.resize(row.sessionId, params.cols, params.rows); }
  async close(id: string) { const row = this.item(id); try { await this.worker.forget(row.sessionId); } catch (error) { if (!(error instanceof BuilderError) || error.code !== 'session-missing') throw error; } this.attention.exited(id); await this.registry.mutate(null, draft => { draft.items = draft.items.filter(i => i.id !== id); }); }
  async stopAll() { await this.worker.stopAll(); await this.reconcile(); }
  dispose() { this.worker.off('event', this.onEvent); this.attention.dispose(); this.agentSessions.close(); }
}
