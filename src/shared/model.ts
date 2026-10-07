export interface BuilderWorktree { id: string; root: string; name: string; branch: string | null; main: boolean }
export interface BuilderRepo { id: string; root: string; name: string; worktrees: BuilderWorktree[] }
export interface ItemBase { id: string; repoId: string | null; cwd: string; title: string; createdAt: string; updatedAt: string }
export interface TerminalItem extends ItemBase { type: 'term'; sessionId: string; requestId: string; command: string; args: string[]; exited: boolean; exitCode: number | null; harness?: string; attention?: 'working' | 'waiting' | 'idle' }
export interface FileItem extends ItemBase { type: 'file' | 'artifact' | 'image' | 'pdf'; filePath: string }
export type BuilderItem = TerminalItem | FileItem;
export interface BuilderSnapshot { revision: number; repos: BuilderRepo[]; items: BuilderItem[]; capabilities: { platform: string; home: string }; warning?: string }
