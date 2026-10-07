import type { MethodMap, MethodName } from '../../shared/methods.js';
import type { BuilderEvent } from '../../shared/events.js';
export interface BuilderServices {
  call<K extends MethodName>(method: K, params: MethodMap[K]['params']): Promise<MethodMap[K]['result']>;
  subscribe(callback: (event: BuilderEvent) => void, status?: (connected: boolean) => void): () => void;
}
