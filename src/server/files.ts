import { readTree } from './ported/tree.js';
import { DEFAULT_IGNORE_PATTERNS } from '../port-shared/file-patterns.js';
import { splitFrontmatter } from '../shared/viewer-item.js';
import type { TreeNode, FolderTableData } from '../port-shared/types.js';
import { readFile, writeFile, readdir, realpath, stat, lstat, rename, rm, mkdir, open, cp } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Registry } from './registry.js';
import { absolutePath, isWithin } from './repos.js';
import { BuilderError } from '../shared/errors.js';
import type { FileItem } from '../shared/model.js';
import { decodeBase64 } from '../shared/bytes.js';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const MAX_TEXT = 4 * 1024 * 1024;
export function fileType(path: string): FileItem['type'] {
  const ext = extname(path).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'artifact';
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp', '.ico'].includes(ext)) return 'image';
  return 'file';
}
export class Files {
  private writes = new Map<string, Promise<unknown>>();
  constructor(private registry: Registry) {}
  async tree(value: string): Promise<TreeNode[]> {
    const root = await realpath(absolutePath(value));
    const result = await readTree({root,depth:2,maxEntries:10000,patterns:DEFAULT_IGNORE_PATTERNS,detectBinary:true,countFiles:true});
    const absolute = (nodes: TreeNode[]): TreeNode[] => nodes.map(node => ({...node,path:join(root,node.path),...(node.children ? {children:absolute(node.children)} : {})}));
    return absolute(result.nodes);
  }
  async table(value: string): Promise<FolderTableData> {
    const listing=await this.list(value), files: FolderTableData['files']=[];
    for(const entry of listing.entries) {
      if(entry.directory||!['.md','.markdown'].includes(extname(entry.path).toLowerCase()))continue;
      const text=await this.read(entry.path);
      files.push({path:entry.path,filename:entry.name,frontmatter:splitFrontmatter(text.content).attributes as Record<string,unknown>,mtime:new Date(entry.modified).toISOString(),ctime:new Date(entry.modified).toISOString()});
    }
    return {folderPath:listing.path,files,columns:[...new Set(files.flatMap(file=>Object.keys(file.frontmatter)))]};
  }
  async info(value: string) {
    const path = absolutePath(value); const s = await lstat(path);
    return { path, name: basename(path), directory: s.isDirectory(), symlink: s.isSymbolicLink(), size: s.size, modified: s.mtimeMs, revision: digest(`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`) };
  }
  async list(value: string) {
    const path = await realpath(absolutePath(value));
    const entries = await readdir(path, { withFileTypes: true });
    const result = await Promise.all(entries.filter(e => e.name !== '.git').map(async e => {
      try { const info = await this.info(join(path, e.name)); if (info.symlink) info.directory = (await stat(info.path)).isDirectory(); return info; } catch { return null; }
    }));
    return { path, parent: dirname(path), entries: result.filter((e): e is NonNullable<typeof e> => e !== null).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
  }
  async read(value: string) {
    const path = await realpath(absolutePath(value));
    const s = await stat(path); if (!s.isFile() || s.size > MAX_TEXT) throw new BuilderError('not-text', 'Open a text file smaller than 4 MiB');
    const bytes = await readFile(path); if (bytes.includes(0)) throw new BuilderError('not-text', 'This file contains binary data');
    return { path, content: bytes.toString('utf8'), revision: digest(bytes), modified: s.mtimeMs };
  }
  async write(params: { path: string; content: string; revision: string | null }) {
    const path = absolutePath(params.path);
    if (typeof params.content !== 'string' || Buffer.byteLength(params.content) > MAX_TEXT) throw new BuilderError('too-large', 'Text exceeds 4 MiB');
    const previous = this.writes.get(path) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      let current: Awaited<ReturnType<Files['read']>> | null = null;
      try { current = await this.read(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if ((current?.revision ?? null) !== params.revision) throw new BuilderError('file-changed', 'File changed on disk. Reload before saving.');
      const target = current?.path ?? path;
      if (!current) { await writeFile(target, params.content, { flag: 'wx', mode: 0o600 }); }
      else {
        const mode = (await stat(target)).mode;
        const temp = join(dirname(target), `.builder-save-${randomUUID()}`);
        try {
          await writeFile(temp, params.content, { mode });
          if ((await this.read(target)).revision !== params.revision) throw new BuilderError('file-changed', 'File changed on disk. Reload before saving.');
          await rename(temp, target);
        } finally { await rm(temp, { force: true }); }
      }
      return this.read(target);
    });
    this.writes.set(path, task);
    try { return await task; } finally { if (this.writes.get(path) === task) this.writes.delete(path); }
  }
  async open(value: string, repoId?: string | null): Promise<FileItem> {
    const path = await realpath(absolutePath(value)); if (!(await stat(path)).isFile()) throw new BuilderError('not-file', 'Choose a file');
    const known = this.registry.snapshot().items.find((i): i is FileItem => i.type !== 'term' && i.filePath === path); if (known) return known;
    const repo = this.registry.snapshot().repos.find(r => r.id === repoId || isWithin(r.root, path) || r.worktrees.some(w => isWithin(w.root, path)));
    const now = new Date().toISOString();
    const item: FileItem = { id: randomUUID(), type: fileType(path), repoId: repo?.id ?? null, cwd: dirname(path), filePath: path, title: basename(path), createdAt: now, updatedAt: now };
    const next = await this.registry.mutate(null, draft => { if (!draft.items.some(i => i.type !== 'term' && i.filePath === path)) draft.items.push(item); });
    return next.items.find((i): i is FileItem => i.type !== 'term' && i.filePath === path)!;
  }
  async close(id: string) { await this.registry.mutate(null, draft => { draft.items = draft.items.filter(i => i.id !== id || i.type === 'term'); }); }
  async rename(params: { path: string; destination: string; revision: string }) {
    const path = absolutePath(params.path), destination = absolutePath(params.destination);
    if ((await this.info(path)).revision !== params.revision) throw new BuilderError('file-changed', 'File changed before rename');
    if (this.registry.snapshot().repos.some(r => r.root === path || r.worktrees.some(w => w.root === path))) throw new BuilderError('repo-root', 'Move repository roots outside Builder, then register their new location');
    try { await lstat(destination); throw new BuilderError('already-exists', 'Destination already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(path, destination);
    await this.registry.mutate(null, draft => { for (const item of draft.items) if (item.type !== 'term' && isWithin(path, item.filePath)) { item.filePath = destination + item.filePath.slice(path.length); item.title = basename(item.filePath); item.cwd = dirname(item.filePath); item.type = fileType(item.filePath); } });
    return this.info(destination);
  }
  /** Port of CubedFiles.trash: keep recoverable bytes in this app's own state. */
  async trash(params: { path: string; revision: string }) {
    const path = absolutePath(params.path), info = await this.info(path);
    if (info.revision !== params.revision) throw new BuilderError('file-changed', 'File changed before moving to trash');
    if (isWithin(path, this.registry.stateDir) || this.registry.snapshot().repos.some(r => isWithin(path, r.root) || r.worktrees.some(w => isWithin(path, w.root)))) throw new BuilderError('repo-root', 'Detach repository roots before moving them to trash');
    const trash = join(this.registry.stateDir, 'trash');
    await mkdir(trash, {recursive:true});
    const destination = join(trash, `${Date.now()}-${randomUUID()}-${basename(path)}`);
    try { await rename(path, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await cp(path, destination, {recursive:true, errorOnExist:true, force:false});
      await rm(path, {recursive:true});
    }
    await this.registry.mutate(null, draft => { draft.items = draft.items.filter(i => i.type === 'term' || !isWithin(path, i.filePath)); });
    return {path:destination};
  }
  async remove(params: { path: string; revision: string }) {
    const path = absolutePath(params.path); const info = await this.info(path);
    if (info.revision !== params.revision) throw new BuilderError('file-changed', 'File changed before deletion');
    if (info.directory) throw new BuilderError('directory-removal', 'Directory deletion is not supported here; remove individual files or use a terminal');
    await rm(path);
    await this.registry.mutate(null, draft => { draft.items = draft.items.filter(i => i.type === 'term' || i.filePath !== path); });
  }
  async upload(params: { directory: string; name: string; data: string }) {
    const directory = await realpath(absolutePath(params.directory));
    if (typeof params.name !== 'string' || !params.name || basename(params.name) !== params.name || params.name === '.' || params.name === '..' || params.name.includes('\\') || params.name.includes('\0')) throw new BuilderError('invalid-name', 'Invalid upload name');
    const bytes = decodeBase64(params.data, 8 * 1024 * 1024, 'Upload');
    const path = join(directory, params.name); const fd = await open(path, 'wx', 0o600);
    try { await fd.writeFile(bytes); } finally { await fd.close(); }
    return this.info(path);
  }
  async mkdir(value: string) { const path = absolutePath(value); await mkdir(path); return this.info(path); }
}
