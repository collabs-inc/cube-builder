import { Registry } from './registry.js';
import { Terminals } from './terminals.js';
import { BuilderError } from '../shared/errors.js';
import type { MethodMap } from '../shared/methods.js';
type Handlers = { [K in keyof MethodMap]: (params: MethodMap[K]['params']) => MethodMap[K]['result'] | Promise<MethodMap[K]['result']> };
export function createMethods(registry: Registry, terminals: Terminals) {
  const handlers: Handlers = {
    snapshot: () => registry.snapshot(),
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
