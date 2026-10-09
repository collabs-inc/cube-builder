export interface BuilderWorktree { baseBranch?: string; creation?: {state:"pending"|"failed";error?:string}; sha?: string; createdAt?: string; createdOnBranch?: string; source?: import("../port-shared/catalog.js").WorktreeSource; id: string; root: string; name: string; branch: string | null; main: boolean }
export interface BuilderRepo { createdAt?: string; managed?: boolean; originUrl?: string; id: string; root: string; name: string; worktrees: BuilderWorktree[] }
export interface ItemBase { userTitle?: string; agentTitle?: string; agentSessionId?: string; id: string; repoId: string | null; cwd: string; title: string; createdAt: string; updatedAt: string }
export interface TerminalItem extends ItemBase { supersededSessionIds?: string[]; resumed?: boolean; type: 'term'; sessionId: string; requestId: string; command: string; args: string[]; exited: boolean; exitCode: number | null; harness?: string; launchId?: string; attentionHooks?: boolean; turnEndedAt?: string; attention?: 'working' | 'waiting' | 'idle' }
export interface FileItem extends ItemBase { type: 'file' | 'artifact' | 'image' | 'pdf'; filePath: string }
export type BuilderItem = TerminalItem | FileItem;
export interface BuilderSnapshot { epoch: string; revision: number; repos: BuilderRepo[]; items: BuilderItem[]; capabilities: { platform: string; home: string }; warning?: string }
export interface FileInfo { path: string; name: string; directory: boolean; symlink: boolean; size: number; modified: number; revision: string }
export interface TextFile { modified?: number; path: string; content: string; revision: string }
export interface DirectoryListing { path: string; parent: string; entries: FileInfo[] }
