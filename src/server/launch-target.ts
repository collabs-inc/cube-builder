import { randomUUID } from 'node:crypto';
import { commandExists, resolveAutoTarget, resolveTerminalTarget } from './ported/terminal-target.js';
import type { TerminalTarget } from '../port-shared/types.js';

/** Resolve installation-local defaults before minting a conversation identity. */
export function resolveBuilderTarget(options: {target?:string;cwd?:string;agentSessionId?:string;resume?:boolean}, exists=commandExists) {
  const target=resolveAutoTarget((options.target??'auto') as TerminalTarget,exists);
  const id=options.agentSessionId??(target==='claude'?randomUUID():undefined);
  return resolveTerminalTarget(target,options.cwd,id,options.resume&&!!options.agentSessionId,exists);
}
