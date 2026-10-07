import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { BuilderError } from '../shared/errors.js';
export const AGENTS = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'opencode', name: 'OpenCode' }] as const;
export async function resolveCommand(command: string, path = process.env.PATH ?? '', cwd = process.cwd()): Promise<string> {
  const candidates = command.includes('/') ? [isAbsolute(command) ? command : resolve(cwd, command)] : path.split(delimiter).filter(Boolean).map(dir => resolve(dir, command));
  for (const candidate of candidates) { try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch {} }
  throw new BuilderError('command-missing', `${command} is not installed or executable on this machine`);
}
export async function listAgents(path = process.env.PATH ?? '') {
  return Promise.all(AGENTS.map(async agent => { try { return { ...agent, available: true, command: await resolveCommand(agent.id, path) }; } catch { return { ...agent, available: false, command: null }; } }));
}
