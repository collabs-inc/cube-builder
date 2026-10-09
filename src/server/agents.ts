import { access, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { BuilderError } from '../shared/errors.js';
export const AGENTS = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'opencode', name: 'OpenCode' }] as const;
/** Host-generated wrappers add launch flags and host integration of their own.
 * Builder already owns those arguments; resolve the actual executable instead.
 * Read only a short header, and keep arbitrary user wrappers untouched. */
async function isHostAgentWrapper(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(512);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return /^#![^\n]*\n# Written by cubed \(shell-wrappers\.ts\):/.test(header.toString('utf8', 0, bytesRead));
  } finally { await file.close(); }
}
export async function resolveCommand(command: string, path = process.env.PATH ?? '', cwd = process.cwd()): Promise<string> {
  const candidates = command.includes('/') ? [isAbsolute(command) ? command : resolve(cwd, command)] : path.split(delimiter).filter(Boolean).map(dir => resolve(dir, command));
  const resolveAgent = !command.includes('/') && AGENTS.some(agent => agent.id === command);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      if (resolveAgent && await isHostAgentWrapper(candidate)) continue;
      return candidate;
    } catch {}
  }
  throw new BuilderError('command-missing', `${command} is not installed or executable on this machine`);
}
export async function listAgents(path = process.env.PATH ?? '') {
  return Promise.all(AGENTS.map(async agent => { try { return { ...agent, available: true, command: await resolveCommand(agent.id, path) }; } catch { return { ...agent, available: false, command: null }; } }));
}
