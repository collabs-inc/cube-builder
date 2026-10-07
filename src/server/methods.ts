import { Registry } from './registry.js';
import { Terminals } from './terminals.js';
import { BuilderError } from '../shared/errors.js';
import type { MethodMap } from '../shared/methods.js';
import { Repos } from './repos.js';
import { Files } from './files.js';
import { Previews } from './previews.js';
type Handlers = { [K in keyof MethodMap]: (params: MethodMap[K]['params']) => MethodMap[K]['result'] | Promise<MethodMap[K]['result']> };
export function createMethods(registry: Registry, terminals: Terminals, repos: Repos, files: Files, previews: Previews) {
  const handlers: Handlers = {
    snapshot: () => registry.snapshot(),
    'repos.add': p => repos.add(p.path),
    'repos.create': p => repos.create(p.path),
    'repos.clone': p => repos.clone(p.url, p.path),
    'repos.remove': async p => { await repos.remove(p.id); return null; },
    'repos.refresh': p => repos.refresh(p.id),
    'worktrees.create': p => repos.createWorktree(p),
    'worktrees.remove': async p => { await repos.removeWorktree(p); return null; },
    'files.list': p => files.list(p.path),
    'files.stat': p => files.info(p.path),
    'files.read': p => files.read(p.path),
    'files.write': p => files.write(p),
    'files.open': p => files.open(p.path, p.repoId),
    'files.close': async p => { await files.close(p.id); return null; },
    'files.rename': p => files.rename(p),
    'files.remove': async p => { await files.remove(p); return null; },
    'files.mkdir': p => files.mkdir(p.path),
    'files.upload': p => files.upload(p),
    'previews.create': p => previews.create(p.itemId),
    'terminals.create': params => terminals.create(params),
    'terminals.read': params => terminals.read(params),
    'terminals.write': async params => { await terminals.write(params); return null; },
    'terminals.resize': async params => { await terminals.resize(params); return null; },
    'terminals.close': async params => { await terminals.close(params.id); return null; },
    'terminals.stopAll': async () => { await terminals.stopAll(); return null; },
  };
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!Object.hasOwn(handlers, method)) throw new BuilderError('unknown-method', `Unknown method: ${method}`);
    return (handlers[method as keyof MethodMap] as (p: unknown) => unknown)(params);
  };
}
