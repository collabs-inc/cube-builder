import { mkdir, realpath, stat, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Registry } from './registry.js';
import { git } from './git.js';
import { listWorktrees } from './worktrees.js';
import { BuilderError } from '../shared/errors.js';
import { text } from './validation.js';
import type { BuilderRepo } from '../shared/model.js';

export function absolutePath(value: unknown): string {
  const path = text(value, 'path');
  if (!isAbsolute(path)) throw new BuilderError('invalid-path', 'Use an absolute path on this machine');
  return resolve(path);
}
export function isWithin(root: string, path: string): boolean { return path === root || path.startsWith(root + sep); }
export class Repos {
  constructor(private registry: Registry) {}
  get(id: string): BuilderRepo {
    const repo = this.registry.snapshot().repos.find(r => r.id === id);
    if (!repo) throw new BuilderError('repo-missing', 'Repository is no longer registered'); return repo;
  }
  async add(path: string): Promise<BuilderRepo> {
    const root = await realpath(absolutePath(path));
    if (!(await stat(root)).isDirectory()) throw new BuilderError('invalid-directory', 'Choose a directory');
    const existing = this.registry.snapshot().repos.find(r => r.root === root); if (existing) return existing;
    const repo: BuilderRepo = { id: randomUUID(), root, name: basename(root), createdAt: new Date().toISOString(), managed: false, worktrees: await listWorktrees(root) };
    const next = await this.registry.mutate(null, draft => { if (!draft.repos.some(r => r.root === root)) draft.repos.push(repo); });
    return next.repos.find(r => r.root === root)!;
  }
  async create(path: string): Promise<BuilderRepo> {
    const root = absolutePath(path);
    await mkdir(dirname(root), { recursive: true }); await mkdir(root);
    try { await git(root, ['init', '-b', 'main']); }
    catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
    return this.add(root);
  }
  async clone(url: string, path: string): Promise<BuilderRepo> {
    text(url, 'Git URL'); const root = absolutePath(path);
    await mkdir(dirname(root), { recursive: true });
    // Clone only into a directory this operation created. A failure never
    // removes a destination that was already present.
    await mkdir(root);
    try { await git(dirname(root), ['clone', '--', url, root], 5 * 60_000); }
    catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
    return this.add(root);
  }
  async remove(id: string): Promise<void> {
    this.get(id);
    await this.registry.mutate(null, draft => { draft.repos = draft.repos.filter(r => r.id !== id); for (const item of draft.items) if (item.repoId === id) item.repoId = null; });
  }
  async refresh(id: string): Promise<BuilderRepo> {
    const repo = this.get(id); const worktrees = await listWorktrees(repo.root);
    const canonical=new Map(await Promise.all(repo.worktrees.map(async tree=>[tree.id,await realpath(tree.root).catch(()=>tree.root)] as const)));
    await this.registry.mutate(null, draft => { const row = draft.repos.find(r => r.id === id); if (row) {
      const old=row.worktrees;
      const refreshed=worktrees.map(tree=>{const previous=old.find(w=>(canonical.get(w.id)??w.root)===tree.root);return previous?{...previous,...tree,id:previous.id}:tree});
      row.worktrees=[...old.filter(tree=>tree.creation&&!refreshed.some(w=>w.id===tree.id)),...refreshed].sort((a,b)=>{const ai=old.findIndex(w=>w.id===a.id),bi=old.findIndex(w=>w.id===b.id);return (ai<0?old.length:ai)-(bi<0?old.length:bi)});
    } }); return this.get(id);
  }
  async createWorktree(params: { repoId: string; path: string; branch: string; start?: string }) {
    const repo = this.get(params.repoId); const path = absolutePath(params.path); const branch = text(params.branch, 'branch', 200);
    await git(repo.root, ['check-ref-format', '--branch', branch]);
    await mkdir(dirname(path), { recursive: true });
    await git(repo.root, ['worktree', 'add', '-b', branch, '--', path, ...(params.start ? [text(params.start, 'start revision')] : [])]);
    const canonical=await realpath(path);
    return (await this.refresh(repo.id)).worktrees.find(w => w.root === canonical)!;
  }
  async removeWorktree(params: { repoId: string; path: string }) {
    const repo = await this.refresh(params.repoId); const path = await realpath(absolutePath(params.path));
    const tree = repo.worktrees.find(w => resolve(w.root) === path);
    if (!tree || tree.main) throw new BuilderError('invalid-worktree', 'Only a registered secondary worktree can be removed');
    if (this.registry.snapshot().items.some(i => i.type === 'term' && !i.exited && isWithin(path, i.cwd))) throw new BuilderError('worktree-busy', 'Close running terminals in this worktree first');
    if ((await git(path, ['status', '--porcelain', '--untracked-files=all'])).trim()) throw new BuilderError('worktree-dirty', 'Worktree has uncommitted changes');
    await git(repo.root, ['worktree', 'remove', '--', path]); await this.refresh(repo.id);
  }
}
