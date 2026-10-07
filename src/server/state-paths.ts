import { homedir } from 'node:os';
import { join } from 'node:path';
export function stateDirectory(): string {
  return process.env.BUILDER_STATE_DIR ?? (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Cube Builder')
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'cube-builder'));
}
