import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { git } from './git.js';
import type { BuilderWorktree } from '../shared/model.js';
export async function listWorktrees(root: string): Promise<BuilderWorktree[]> {
  let output: string;
  try { output = await git(root, ['worktree', 'list', '--porcelain', '-z']); } catch { return []; }
  const result: BuilderWorktree[] = [];
  for (const block of output.split('\0\0')) {
    const fields = block.split('\0');
    const path = fields.find(f => f.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    const branch = fields.find(f => f.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null;
    result.push({ id: createHash('sha256').update(resolve(path)).digest('hex').slice(0, 20), root: path, name: basename(path), branch, sha: fields.find(f => f.startsWith('HEAD '))?.slice(5, 12), main: result.length === 0 });
  }
  return result;
}
