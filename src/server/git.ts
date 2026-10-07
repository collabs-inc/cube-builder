import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BuilderError } from '../shared/errors.js';
const run = promisify(execFile);
export async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  try { return (await run('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout; }
  catch (error) { const e = error as Error & { stderr?: string }; throw new BuilderError('git-failed', e.stderr?.trim() || e.message); }
}
