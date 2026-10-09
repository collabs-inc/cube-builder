import { join } from 'node:path';
import { Registry } from './registry.js';
import { BellParser } from './attention/bell.js';
import { AttentionInputParser } from './attention/input.js';
import { adaptReport, parseReport } from './attention/adapters.js';
import { AttentionSpool } from './attention/spool.js';
import { HARNESS_PROFILES, type AttentionHarness } from './attention/hooks.js';
import { emptySession, reduce, derive, DEFAULT_LIMITS, NO_HOOKS, type AttentionEvent, type SessionData } from './attention/state.js';
import type { TerminalItem } from '../shared/model.js';
type Tracked = { launchId?: string; data: SessionData; bell: BellParser; input: AttentionInputParser; seq: number | null; published: string };
/** The extracted reducer consumes only this app's launches and private spool. */
export class Attention {
  private sessions = new Map<string, Tracked>();
  private timer: ReturnType<typeof setInterval>;
  private spool: AttentionSpool;
  constructor(private registry: Registry, private report: (error: unknown) => void) {
    this.spool = new AttentionSpool({ dir: join(registry.stateDir, 'attention'), accept: report => {
      const item = registry.snapshot().items.find((i): i is TerminalItem => i.type === 'term' && i.launchId === report.launchId);
      if (!item) return 'unknown';
      this.register(item);
      for (const event of adaptReport(parseReport(report.text), report.name, Date.now())) this.apply(item.id, event);
      return 'consumed';
    } });
    this.spool.start();
    this.timer = setInterval(() => { for (const id of this.sessions.keys()) this.apply(id, { kind: 'quiet', at: Date.now() }); }, 1000); this.timer.unref();
    for (const item of registry.snapshot().items) if (item.type === 'term') this.register(item);
  }
  register(item: TerminalItem) {
    if (!item.harness || (this.sessions.has(item.id)&&this.sessions.get(item.id)?.launchId===item.launchId)) return;
    const data = emptySession(item.attentionHooks ? HARNESS_PROFILES[item.harness as AttentionHarness] ?? NO_HOOKS : NO_HOOKS);
    data.restoredBlock = item.attention === 'waiting'; data.gone = item.exited;
    this.sessions.set(item.id, { launchId:item.launchId,data, bell: new BellParser(), input: new AttentionInputParser(), seq: null, published: item.attention ?? 'idle' });
  }
  private apply(id: string, event: AttentionEvent) {
    const tracked = this.sessions.get(id); if (!tracked) return;
    const result = reduce(tracked.data, event, DEFAULT_LIMITS); tracked.data = result.data;
    const derived = derive(result.data, Date.now(), DEFAULT_LIMITS), attention = derived.state === 'running' ? 'working' : derived.state === 'blocked' ? 'waiting' : 'idle';
    if (attention === tracked.published && !result.stamp) return;
    tracked.published = attention;
    void this.registry.mutate(null, draft => { const item = draft.items.find(i => i.id === id); if (item?.type === 'term'&&item.launchId===tracked.launchId) { item.attention = attention; if (result.stamp) item.turnEndedAt = new Date().toISOString(); } }).catch(this.report);
  }
  output(id: string, bytes: Uint8Array, seq: number) {
    const tracked = this.sessions.get(id); if (!tracked) return;
    if (tracked.seq !== null && seq <= tracked.seq) return;
    const contiguous = tracked.seq === null ? seq === bytes.length : seq - bytes.length === tracked.seq;
    tracked.seq = seq; if (!contiguous) tracked.bell.resync();
    const bells = tracked.bell.feed(bytes); if (!contiguous) return;
    this.apply(id, { kind: 'output', cursor: seq, bytes: bytes.length, at: Date.now() });
    if (!tracked.data.profile.ends && bells) this.apply(id, { kind: 'bell', at: Date.now() });
  }
  input(id: string, bytes: Uint8Array) { const tracked = this.sessions.get(id); if (tracked) this.apply(id, { kind: 'input', typed: tracked.input.feed(bytes), at: Date.now() }); }
  exited(id: string) { this.apply(id, { kind: 'gone', at: Date.now() }); this.sessions.delete(id); }
  dispose() { clearInterval(this.timer); this.spool.stop(); }
}
