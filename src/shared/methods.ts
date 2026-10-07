import type { BuilderSnapshot, TerminalItem } from './model.js';
import type { ReadResult } from './terminal-protocol.js';
export interface TerminalCreate { requestId: string; cwd: string; command?: string; args?: string[]; cols?: number; rows?: number; repoId?: string | null; harness?: string }
export interface MethodMap {
  snapshot: { params: Record<string, never>; result: BuilderSnapshot };
  'terminals.create': { params: TerminalCreate; result: TerminalItem };
  'terminals.read': { params: { id: string; since: number; maxBytes?: number }; result: ReadResult };
  'terminals.write': { params: { id: string; bytes: string }; result: null };
  'terminals.resize': { params: { id: string; cols: number; rows: number }; result: null };
  'terminals.close': { params: { id: string }; result: null };
  'terminals.stopAll': { params: Record<string, never>; result: null };
}
export type MethodName = keyof MethodMap;
