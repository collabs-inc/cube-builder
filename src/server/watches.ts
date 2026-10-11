import { watch, type FSWatcher } from 'chokidar';
import { watch as watchParent, type FSWatcher as NativeWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, dirname, extname, relative } from 'node:path';
import { EventEmitter } from 'node:events';
import { Registry } from './registry.js';
import { Files } from './files.js';

const EXCLUDED = new Set(['.git', 'node_modules', 'bower_components', 'dist', 'build', 'out', '.next', '.cache', '.venv', 'venv', 'site-packages', '__pycache__', '.builder-save']);

export function watchFailure(error: unknown, root: string): Error {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
    return new Error(`Builder cannot watch ${root}: Linux inotify watch capacity is exhausted (not disk space). Reduce watched repositories or ask the machine administrator to raise fs.inotify.max_user_watches to at least 524288. Open files still refresh by polling.`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class Watches extends EventEmitter {
  private watchers = new Map<string, FSWatcher | NativeWatcher>();
  private modes = new Map<string, boolean>();
  private closing = new Set<Promise<void>>();
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
    const repoRoots = new Set(snapshot.repos.flatMap(r => [r.root, ...r.worktrees.map(w => w.root)]));
    const roots = new Map([...repoRoots].map(root => [root, true]));
    // Standalone files need only their immediate parent, never its descendants.
    for (const item of snapshot.items) if (item.type !== 'term' && ![...repoRoots].some(root => item.filePath.startsWith(root + '/'))) {
      if (!roots.has(dirname(item.filePath))) roots.set(dirname(item.filePath), false);
    }
    for (const [root, watcher] of this.watchers) if (!roots.has(root) || roots.get(root) !== this.modes.get(root)) {
      this.release(watcher); this.watchers.delete(root); this.modes.delete(root);
    }
    for (const [root, recursive] of roots) if (!this.watchers.has(root)) {
      if (!recursive) {
        try {
          const watcher = watchParent(root, (_event, name) => {
            if (name && !String(name).startsWith('.builder-save')) this.changed(join(root, String(name)));
          });
          watcher.on('error', error => {
            watcher.close();
            if (this.watchers.get(root) === watcher) { this.watchers.delete(root); this.modes.delete(root); }
            if (!this.closed) this.emit('failure', watchFailure(error, root));
          });
          this.watchers.set(root, watcher); this.modes.set(root, false);
          console.info(`Builder watch: root=${root} recursive=false directories=1`);
        } catch (error) { queueMicrotask(() => { if (!this.closed) this.emit('failure', watchFailure(error, root)); }); }
        continue;
      }
      const watcher = watch(root, {
        // Filtering happens during traversal, before native watches are allocated.
        ignored: path => relative(root, path).split(/[\\/]/).some(part => EXCLUDED.has(part) || part.startsWith('.builder-save-')),
        followSymlinks: false,
        ignoreInitial: false,
      });
      let reported = false;
      watcher.on('error', error => {
        // A failed crawl can report thousands of ENOSPC errors, one per entry.
        if (!reported && !this.closed) { reported = true; this.emit('failure', watchFailure(error, root)); }
      });
      watcher.on('all', (_event, path) => {
        if (this.closed || this.watchers.get(root) !== watcher) return;
        this.changed(path);
      });
      watcher.on('ready', () => {
        if (this.closed || this.watchers.get(root) !== watcher) return;
        const directories = Object.keys(watcher.getWatched()).length;
        console.info(`Builder watch: root=${root} recursive=${recursive} directories=${directories}`);
      });
      this.watchers.set(root, watcher); this.modes.set(root, recursive);
      if (recursive) void this.discover(root).catch(error => { if (!this.closed) this.emit('failure', error); });
    }
  };
  private changed(path: string) {
    if (this.closed) return;
    this.paths.add(path);
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush(); }, 150);
  }
  private release(watcher: FSWatcher | NativeWatcher) {
    const closing = Promise.resolve(watcher.close());
    this.closing.add(closing);
    void closing.finally(() => this.closing.delete(closing));
  }

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
  async close() { this.closed = true; clearInterval(this.pollTimer); clearTimeout(this.timer); this.registry.off('changed', this.sync); for (const watcher of this.watchers.values()) this.release(watcher); this.watchers.clear(); this.modes.clear(); this.paths.clear(); await Promise.all(this.closing); }
}
