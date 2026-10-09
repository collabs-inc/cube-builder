export const WORKER_PROTOCOL = 2;
export interface RecoveryInfo { catalogItemId?: string; supersededSessionIds?: string[]; agentSessionId?: string; resumed?: boolean; repoId: string | null; harness?: string; launchId: string; attentionHooks: boolean; args: string[] }
export interface SpawnParams {
  recovery?: RecoveryInfo;
  requestId: string; cwd: string; command: string; args: string[];
  env?: Record<string, string>; cols: number; rows: number;
}
export interface SessionInfo {
  recovery?: RecoveryInfo;
  id: string; requestId: string; pid: number; cwd: string; command: string;
  args: string[]; cols: number; rows: number; createdAt: string;
  exited: boolean; exitCode: number | null;
}
export interface ReadResult { data: string; seq: number; start: number; reset: boolean; modes: string; exited: boolean; exitCode: number | null }
export type TerminalEvent = { type: 'data'; id: string; data: string; seq: number } | { type: 'exit'; id: string; exitCode: number };
