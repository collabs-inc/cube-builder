import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { EventEmitter } from 'node:events';
import { Registry } from './registry.js';
import { Files } from './files.js';

export class Watches extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();
  private paths = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private fingerprints = new Map<string, string>();
  private polling = false;
  private pollTimer: ReturnType<typeof setInterval>;
  constructor(private registry: Registry, private files: Files) { super(); registry.on('changed', this.sync); this.sync(); this.pollTimer = setInterval(() => { void this.pollOpened(); }, 1000); this.pollTimer.unref(); }
  private sync = () => {
    if (this.closed) return;
    const snapshot = this.registry.snapshot();
    const roots = new Set(snapshot.repos.flatMap(r => [r.root, ...r.worktrees.map(w => w.root)]));
    // Watch only an opened file's parent when it is outside a registered repo.
    for (const item of snapshot.items) if (item.type !== 'term' && ![...roots].some(root => item.filePath.startsWith(root + '/'))) roots.add(dirname(item.filePath));
    for (const [root, watcher] of this.watchers) if (!roots.has(root)) { watcher.close(); this.watchers.delete(root); }
    for (const root of roots) if (!this.watchers.has(root)) {
      try {
        const watcher = watch(root, { recursive: true }, (_event, name) => {
          if (!name || name.split(/[\\/]/).some(part => ['.git', 'node_modules', '.builder-save'].includes(part) || part.startsWith('.builder-save-'))) return;
          this.paths.add(join(root, name));
          clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush(); }, 150);
        });
        watcher.on('error', error => this.emit('failure', error));
        this.watchers.set(root, watcher);
        if (snapshot.repos.some(r => r.root === root || r.worktrees.some(w => w.root === root))) void this.discover(root).catch(error => this.emit('failure', error));
      } catch (error) { queueMicrotask(() => this.emit('failure', error)); }
    }
  };
  private async pollOpened() {
    if (this.closed || this.polling) return; this.polling = true;
    try {
      const paths = new Set(this.registry.snapshot().items.flatMap(item => item.type === 'term' ? [] : [item.filePath]));
      for (const path of this.fingerprints.keys()) if (!paths.has(path)) this.fingerprints.delete(path);
      const changed: string[] = [];
      for (const path of paths) {
        let fingerprint = 'missing';
        try { const s = await stat(path); fingerprint = `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch {}
        if (this.fingerprints.get(path) !== fingerprint) { this.fingerprints.set(path, fingerprint); changed.push(path); }
      }
      // Linux recursive fs.watch can retain the old inode after an atomic
      // editor save. Poll only opened files to close that gap at bounded cost.
      if (!this.closed && changed.length) this.emit('changed', changed);
    } finally { this.polling = false; }
  }
  private async discover(root: string) {
    for (const entry of await readdir(root, { withFileTypes: true })) if (!this.closed && entry.isFile() && extname(entry.name).toLowerCase() === '.html') await this.files.open(join(root, entry.name));
  }
  private async flush() {
    const paths = [...this.paths]; this.paths.clear();
    if (this.closed) return;
    this.emit('changed', paths);
    for (const path of paths) {
      if (extname(path).toLowerCase() === '.html' && this.registry.snapshot().repos.some(r => r.root === dirname(path) || r.worktrees.some(w => w.root === dirname(path)))) {
        try { if ((await stat(path)).isFile()) await this.files.open(path); } catch { /* Deleted files are shown as missing until closed. */ }
      }
    }
  }
  close() { this.closed = true; clearInterval(this.pollTimer); clearTimeout(this.timer); this.registry.off('changed', this.sync); for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); }
}
