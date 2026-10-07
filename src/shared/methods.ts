import type { BuilderSnapshot, TerminalItem, BuilderRepo, BuilderWorktree, FileInfo, FileItem, TextFile, DirectoryListing } from './model.js';
import type { ReadResult } from './terminal-protocol.js';
export interface TerminalCreate { requestId: string; cwd: string; command?: string; args?: string[]; cols?: number; rows?: number; repoId?: string | null; harness?: string }
export interface MethodMap {
  'agents.list': { params: Record<string, never>; result: { id: string; name: string; available: boolean; command: string | null }[] };
  snapshot: { params: Record<string, never>; result: BuilderSnapshot };
  'repos.add': { params: { path: string }; result: BuilderRepo };
  'repos.create': { params: { path: string }; result: BuilderRepo };
  'repos.clone': { params: { url: string; path: string }; result: BuilderRepo };
  'repos.remove': { params: { id: string }; result: null };
  'repos.refresh': { params: { id: string }; result: BuilderRepo };
  'worktrees.create': { params: { repoId: string; path: string; branch: string; start?: string }; result: BuilderWorktree };
  'worktrees.remove': { params: { repoId: string; path: string }; result: null };
  'files.list': { params: { path: string }; result: DirectoryListing };
  'files.stat': { params: { path: string }; result: FileInfo };
  'files.read': { params: { path: string }; result: TextFile };
  'files.write': { params: { path: string; content: string; revision: string | null }; result: TextFile };
  'files.open': { params: { path: string; repoId?: string | null }; result: FileItem };
  'files.close': { params: { id: string }; result: null };
  'files.rename': { params: { path: string; destination: string; revision: string }; result: FileInfo };
  'files.remove': { params: { path: string; revision: string }; result: null };
  'files.mkdir': { params: { path: string }; result: FileInfo };
  'files.upload': { params: { directory: string; name: string; data: string }; result: FileInfo };
  'previews.create': { params: { itemId: string }; result: { url: string; expiresAt: number } };
  'terminals.create': { params: TerminalCreate; result: TerminalItem };
  'terminals.read': { params: { id: string; since: number; maxBytes?: number }; result: ReadResult };
  'terminals.write': { params: { id: string; bytes: string }; result: null };
  'terminals.resize': { params: { id: string; cols: number; rows: number }; result: null };
  'terminals.close': { params: { id: string }; result: null };
  'terminals.stopAll': { params: Record<string, never>; result: null };
}
export type MethodName = keyof MethodMap;
