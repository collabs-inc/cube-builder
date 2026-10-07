import type { BuilderSnapshot } from '../shared/model.js';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BuilderError } from '../shared/errors.js';
export class Registry extends EventEmitter {
  warning?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private stateDir: string, private data: BuilderSnapshot) { super(); }
  static async open(stateDir: string): Promise<Registry> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const empty: BuilderSnapshot = { revision: 0, repos: [], items: [], capabilities: { platform: process.platform, home: homedir() } };
    const registry = new Registry(stateDir, empty);
    let raw: string;
    try { raw = await readFile(join(stateDir, 'registry.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return registry; throw error; }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || !Array.isArray(parsed.repos) || !Array.isArray(parsed.items)) throw new Error('Invalid registry');
      if (!parsed.repos.every((r: any) => r && typeof r.id === 'string' && typeof r.root === 'string' && Array.isArray(r.worktrees))) throw new Error('Invalid repository');
      if (!parsed.items.every((i: any) => i && typeof i.id === 'string' && ['term', 'file', 'artifact', 'image', 'pdf'].includes(i.type))) throw new Error('Invalid item');
      registry.data = { revision: parsed.revision, repos: parsed.repos, items: parsed.items, capabilities: empty.capabilities };
    } catch {
      const backup = `registry.corrupt-${Date.now()}-${randomUUID()}.json`;
      await rename(join(stateDir, 'registry.json'), join(stateDir, backup));
      registry.warning = `Builder state was unreadable. Preserved ${backup} for recovery.`;
    }
    return registry;
  }
  snapshot(): BuilderSnapshot { return structuredClone({ ...this.data, ...(this.warning ? { warning: this.warning } : {}) }); }
  mutate(revision: number | null, change: (draft: BuilderSnapshot) => void): Promise<BuilderSnapshot> {
    const task = this.queue.then(async () => {
      if (revision !== null && revision !== this.data.revision) throw new BuilderError('state-changed', 'Workspace changed; refresh and retry');
      const draft = this.snapshot(); change(draft);
      draft.revision = this.data.revision + 1;
      const temporary = join(this.stateDir, `registry.tmp-${randomUUID()}`);
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, revision: draft.revision, repos: draft.repos, items: draft.items }), { mode: 0o600 });
        await rename(temporary, join(this.stateDir, 'registry.json'));
      } finally { await rm(temporary, { force: true }); }
      this.data = draft;
      const snapshot = this.snapshot(); this.emit('changed', snapshot); return snapshot;
    });
    this.queue = task.catch(() => {}); return task;
  }
  async flush(): Promise<void> { await this.queue; }
}
