




import type { LaunchChoice } from "@port/shared/launch-menu";



/**
 * The services-layer interface: everything the renderer needs from its
 * host. `src/preload/app.ts` is the authoritative list of what exists —
 * this file mirrors it, grouped and stripped of any group-name prefix the
 * preload method name carried (ptyCreate -> pty.create). No behavior is
 * added; this is a thin regrouping of the same surface.
 *
 * `electron.ts` implements this by delegating to `window.api`. A future
 * web build implements it with a cubed WebSocket client instead — this
 * file is the seam between the two; a web build is expected to stub most
 * of `desktop` (revealInFinder, openInTerminal, the updater, and
 * getPathForFile are desktop-only by nature and have no browser
 * equivalent).
 */



import type { AppConfig, ContextMenuItem, FolderTableData, FsChangeEvent, TreeNode } from "@port/shared/types";
import type { CatalogDocument, CatalogItem, CatalogItemType, CatalogRepo, MachineCatalog, WorktreeSource } from "@port/shared/catalog";

import type { Capabilities } from "@port/shared/capabilities";
import type { ReorderRefusal, ReorderScope } from "@port/shared/catalog-order";

import type { ImportPayload } from "@port/shared/cubed-protocol";
import type { PersistableWorkspaceState } from "../state/workspace";

export type Unsubscribe = () => void;

// -- pty ----------------------------------------------------------------

export interface PtyCreateOptions {
  /** Create only; the caller attaches from the retained output before consuming live frames. */
  deferAttach?: boolean;
  cwd?: string | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  target?: string | undefined;
  env?: Record<string, string> | undefined;
  agentSessionId?: string | undefined;
  repoId?: string | undefined;
  /** Existing catalog row this process belongs to, including native-agent resumes. */
  catalogItemId?: string | undefined;
  /** Resume `agentSessionId`'s conversation instead of creating it. */
  resume?: boolean | undefined;
}

export interface PtySession {
  sessionId: string;
  shell: string;
  displayName: string;
  target: string;
  command: string;
  args: string[];
  cwdHostPath: string;
  cwdGuestPath?: string;
  /**
   * The output cursor for this session, always present (a fresh spawn
   * carries one too, so a client that never reattaches until after a
   * later restart still has a starting cursor). Held by the tile — see
   * terminal-item-logic.ts's `sinceSeqFor` — and passed back on the next
   * reconnect so the tile receives only what it hasn't already rendered.
   */
  seq: number;
  /**
   * Whether resume arguments were actually applied. Never assume this from
   * having *asked* for a resume: a target without resume support spawns
   * fresh, and a marker claiming otherwise is the exact failure the design
   * forbids.
   */
  resumed?: boolean;
}

/** The two cursors a reattach can carry — see terminals.ts's TermOpenParams. */
export interface PtyReconnectOptions {
  /** Owning machine from the catalog, including terminals without a repo. */
  machineId?: string;
  /** The tile's held output cursor; 0 or absent replays from the retained start. */
  sinceSeq?: number;
  /** Upper bound on the reply; ptyd keeps the TRAILING bytes. Absent means 4 MiB. */
  maxBytes?: number;
}

/**
 * A term:open reattach response. Not `PtySession & {...}`: router.ts's
 * `ptyReconnect` handler never returns `args` (only `ptyCreate`'s response
 * does), so a type that required it here would lie about the one field
 * a caller could get burned trusting.
 */
export interface PtyReconnectResult {
  sessionId: string;
  shell: string;
  displayName: string;
  target: string;
  command: string;
  cwdHostPath: string;
  cwdGuestPath?: string;
  seq: number;
  scrollback: string;
  /** True when `sinceSeq` couldn't be served incrementally — `scrollback`
   * is a full replay, not a delta, and the caller must discard whatever
   * it already rendered before applying it. */
  reset?: boolean;
  /** Byte position of `scrollback`'s first byte (see terminals.ts). Absent from an old daemon. */
  scrollbackStart?: number;
  /** True once this session's pty has exited (ptyd still retains it —
   * see MAX_RETAINED_EXITED). `scrollback` then carries its final output. */
  exited?: boolean;
  /** Present only when `exited` is true. */
  exitCode?: number;
}

export interface PtyMeta {
  shell: string;
  cwd: string;
  createdAt: string;
  displayName?: string;
  target?: string;
  cwdHostPath?: string;
  cwdGuestPath?: string;
  agentSessionId?: string;
}

export interface PtyDiscoverEntry {
  sessionId: string;
  meta: PtyMeta;
}

export interface PtyReadMetaResult {
  shell: string;
  cwd: string;
  createdAt: string;
  target?: string;
  agentSessionId?: string;
}

export type PtyDataPayload = { sessionId: string; data: Uint8Array; replay?: boolean; seq?: number };
export type PtyExitPayload = { sessionId: string; exitCode: number };
export type PtyStatusPayload = { sessionId: string; foreground: string };

export type PtyDataCallback = (payload: PtyDataPayload) => void;
export type PtyExitCallback = (payload: PtyExitPayload) => void;
export type PtyStatusCallback = (payload: PtyStatusPayload) => void;

export interface PtyService {
  stopAll(): Promise<void>;
  stashFile(sessionId: string, bytes: string, mime: string, name?: string): Promise<{ path: string }>;
  create(opts: PtyCreateOptions): Promise<PtySession>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  kill(sessionId: string): Promise<void>;
  reconnect(
    sessionId: string,
    cols: number,
    rows: number,
    repoId?: string,
    options?: PtyReconnectOptions,
  ): Promise<PtyReconnectResult>;
  discover(): Promise<PtyDiscoverEntry[]>;
  readMeta(sessionId: string, repoId?: string): Promise<PtyReadMetaResult | null>;
  capture(sessionId: string, lines?: number): Promise<string>;
  forgetRecord(sessionId: string, repoId?: string): Promise<void>;
  onData(sessionId: string, cb: PtyDataCallback): void;
  offData(sessionId: string, cb: PtyDataCallback): void;
  onExit(sessionId: string, cb: PtyExitCallback): void;
  offExit(sessionId: string, cb: PtyExitCallback): void;
  onAnyExit(cb: PtyExitCallback): Unsubscribe;
  /**
   * A session the daemon no longer has — its ptyd died and came back
   * without it. Distinct from `onAnyExit`: an exit means the process
   * finished and the tile is done, while this means only the pty is gone
   * and the conversation behind it may still be recoverable from its
   * durable record. Consumers must not treat it as an exit.
   */
  onSessionLost(cb: (payload: { sessionId: string }) => void): Unsubscribe;
  onStatusChanged(cb: PtyStatusCallback): Unsubscribe;
  /**
   * The window a gap re-attach delivered, broadcast after `onData` already
   * fired for the same delivery — so a tile that adopts it can widen its
   * held backfill window to what actually arrived instead of re-deriving
   * it from the bytes.
   */
  onWindow(
    cb: (payload: { sessionId: string; start: number; end: number; reset: boolean }) => void,
  ): Unsubscribe;
}

// -- files ----------------------------------------------------------------

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  createdAt: string;
  modifiedAt: string;
  fileCount?: number;
}

export interface FileStats {
  revision?: string;
  ctime: string;
  mtime: string;
}

export interface WriteResult {
  revision?: string;
  ok: boolean;
  mtime: string;
  conflict?: boolean;
}

export interface ImageFullResult {
  url: string;
  width: number;
  height: number;
}

export interface FilesService {
  readDocument(path: string): Promise<{content:string;stats:FileStats}>;
  previewUrl(path: string): Promise<string>;
  /** Saves a file as-is, or a folder as a tar.gz archive. */
  downloadFile(path: string): Promise<void>;
  listDownloads(): Promise<import("@port/shared/file-download").FileDownloadState[]>;
  cancelDownload(id: string): Promise<void>;
  retryDownload(id: string): Promise<void>;
  dismissDownload(id: string): Promise<void>;
  revealDownload(id: string): Promise<void>;
  onDownloadsChanged(cb: (states: import("@port/shared/file-download").FileDownloadState[]) => void): () => void;
  readDir(path: string): Promise<DirEntry[]>;
  trashFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  moveFile(oldPath: string, newParentDir: string): Promise<string>;
  readFolderTable(folderPath: string): Promise<FolderTableData>;
  importWebArticle(url: string, targetDir: string): Promise<{ path: string }>;
  readFile(path: string): Promise<string>;
  renameFile(oldPath: string, newTitle: string): Promise<string>;
  getFileStats(path: string): Promise<FileStats>;
  getImageThumbnail(path: string, size: number): Promise<string>;
  getImageFull(path: string): Promise<ImageFullResult>;
  resolveImagePath(reference: string, fromNotePath: string): Promise<string | null>;
  saveDroppedImage(noteDir: string, fileName: string, buffer: ArrayBuffer): Promise<string>;
  writeFile(path: string, content: string, expectedMtime?: string): Promise<WriteResult>;
  /** Files a dropped OS file into a repo folder. The daemon owns the final
   *  name (collisions count up), so the returned path — not destDir +
   *  filename — is what was written. */
  importFile(destDir: string, filename: string, payload: ImportPayload): Promise<string>;
  readTree(params: { root: string }): Promise<TreeNode[]>;
  isDirectory(filePath: string): Promise<boolean>;
  onFileRenamed(cb: (oldPath: string, newPath: string) => void): Unsubscribe;
  onFilesDeleted(cb: (paths: string[]) => void): Unsubscribe;
  onFsChanged(cb: (events: FsChangeEvent[]) => void): Unsubscribe;
}

// -- repos --------------------------------------------------------------

export type RepoStatus = "open" | "connecting" | "closed" | "error";

export interface RepoStatusEvent {
  repoId: string;
  status: RepoStatus;
  error?: string;
  ptydInterface?: number;
}

/**
 * Mutations and connection status only — the repo LIST is not here.
 * Which repos exist is a fact about each machine's catalog, so the
 * renderer derives its list from `state/catalog.ts` (see
 * `state/repo-views.ts`) and these calls land in the sidebar through
 * the catalog broadcast that follows them. What they return is the single
 * catalog row the machine minted, for a caller that needs to act on the
 * repo it just created — never a list.
 */
export interface ReposService {
  create(machineId: string, args: import("@port/shared/repo-create").CreateRepoArgs): Promise<{ repo: CatalogRepo }>;
  githubOwners(machineId: string): Promise<import("@port/shared/repo-create").GithubOwnersResult>;
  publish(machineId: string, args: import("@port/shared/repo-create").PublishRepoArgs): Promise<import("@port/shared/repo-create").PublishRepoResult>;
  add(): Promise<{ repo: CatalogRepo } | null>;
  remove(id: string, operationId: string): Promise<import("@port/shared/cubed-protocol").DetachResult>;
  statusSnapshot(): Promise<Record<string, { status: RepoStatus; error?: string; ptydInterface?: number }>>;
  onStatus(cb: (event: RepoStatusEvent) => void): Unsubscribe;
}

// -- catalog (the machine's own sidebar contents) ---------------------------

export interface CatalogAddRepoArgs {
  machineId: string;
  gitUrl?: string;
  root?: string;
  name?: string;
}

export interface CatalogAddRepoResult {
  repo: CatalogRepo;
  adopted?: boolean;
}

export interface CatalogAddItemArgs {
  machineId: string;
  type: CatalogItemType;
  personaId?: string;
  repoPaths?: string[];
  cloneRepos?: string[];
  role?: "persona";
  repoId?: string;
  /**
   * The harness (or shell) this item runs. For `type: "agent"` main reads
   * it as the harness to resolve an ACP launch for and stores it on the row
   * as `harness`; for `type: "term"` it stays the row's `target`.
   */
  target?: string;
  cwd?: string;
  agentSessionId?: string;
  filePath?: string;
  userTitle?: string;
  agentTitle?: string;
  // Term-creation params forwarded straight to cubed's term:open — typed
  // no further here than the daemon-only `TermOpenParams` it becomes
  // (src/main/cubed/terminals.ts), which this layer cannot import.
  open?: unknown;
}

export interface CatalogUpdateItemPatch {
  userTitle?: string;
  agentTitle?: string;
  cwd?: string;
  filePath?: string;
  type?: CatalogItemType;
  agentSessionId?: string;
  ptySessionId?: string;
  exitedAt?: string;
  exitCode?: number;
}

export interface CatalogItemResult {
  item: CatalogItem;
}

export interface CatalogOkResult {
  ok: boolean;
}

export type CatalogReorderResult = { ok: true } | { ok: false; reason: ReorderRefusal };

export interface CatalogService {
  // One tree per attached daemon, tagged with its stable machine id —
  // NOT pre-merged. The caller feeds each entry through the catalog
  // store's acceptSnapshot(machineId, catalog) (state/catalog.ts), the
  // same per-machine acceptance path onChanged uses, so cold start and
  // steady state render through one path rather than two.
  get(): Promise<MachineCatalog[]>;
  addRepo(args: CatalogAddRepoArgs): Promise<CatalogAddRepoResult>;
  /** `force` skips the work-loss guard (dirty/unpushed changes) — see the
   * sidebar's removal confirm flow. */
  removeRepo(
    machineId: string,
    id: string,
    opts?: { force?: boolean },
  ): Promise<CatalogOkResult>;
  addItem(args: CatalogAddItemArgs): Promise<CatalogItemResult>;
  updateItem(
    machineId: string,
    id: string,
    patch: CatalogUpdateItemPatch,
  ): Promise<CatalogItemResult>;
  removeItem(machineId: string, id: string): Promise<CatalogOkResult>;
  /** Hand-arranged order: a full-membership permutation of one scope (spec §1.4). */
  reorder(machineId: string, scope: ReorderScope, ids: string[]): Promise<CatalogReorderResult>;
  onChanged(cb: (payload: { machineId: string; catalog: CatalogDocument }) => void): Unsubscribe;
  // A machine this client is no longer paired with — sign-out or
  // machine:destroy. The caller drops that machine's whole tree (and its
  // cache) via the catalog store's evictMachine.
  onEvicted(cb: (payload: { machineId: string }) => void): Unsubscribe;
}

// -- worktrees (git worktrees as catalog rows) + GitHub reads --------------
//
// Every call takes the owning machineId first — the renderer always has it
// (on the `OwnedRepo`, or via `resolveMachineId`), so main never has to
// look a machine up before it has that machine's tree. Removal is NOT
// here: an existing worktree row is removed through
// `catalog.removeRepo(machineId, id, { force })`, same as any repo.

export interface WorktreeCreateArgs {
  parentId: string;
  name: string;
  source: WorktreeSource;
  baseBranch?: string;
}

export interface WorktreeInspectResult {
  dirty: number;
  unpushedCommits: number;
  /** Mirrors cubed's `WorktreeInspect.missing` — the directory is gone. */
  missing: boolean;
}

export interface WorktreeRepoInfo {
  worktreesDir?: string;
  hasGithubRemote: boolean;
  /** Short name, e.g. "main". Null when it cannot be determined. */
  defaultBranch: string | null;
}

export interface WorktreeBranch {
  name: string;
  /** Only on origin — checking it out needs a tracking branch. */
  remote: boolean;
}

export interface GithubPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isCrossRepository: boolean;
}

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
}

export type GithubResolveResult =
  | { kind: "pr"; pr: GithubPr }
  | { kind: "issue"; issue: GithubIssue };

export interface WorktreesService {
  create(machineId: string, args: WorktreeCreateArgs): Promise<{ id: string }>;
  retry(machineId: string, id: string): Promise<void>;
  inspect(machineId: string, id: string): Promise<WorktreeInspectResult>;
  repoInfo(machineId: string, parentId: string): Promise<WorktreeRepoInfo>;
  listBranches(machineId: string, parentId: string): Promise<{ branches: WorktreeBranch[] }>;
  listPrs(machineId: string, parentId: string): Promise<{ prs: GithubPr[] }>;
  listIssues(machineId: string, parentId: string): Promise<{ issues: GithubIssue[] }>;
  resolve(
    machineId: string,
    parentId: string,
    kind: "pr" | "issue",
    number: number,
  ): Promise<GithubResolveResult>;
}

// -- prefs --------------------------------------------------------------

export interface PrefsService {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  getWorkspace(key: string, workspacePath: string): Promise<unknown>;
  setWorkspace(key: string, value: unknown, workspacePath: string): Promise<void>;
}

// -- workspace (single-renderer persisted layout) --------------------------

export interface WorkspaceService {
  load(): Promise<PersistableWorkspaceState | null>;
  save(state: PersistableWorkspaceState): Promise<void>;
}

// -- desktop (Electron-only; main<->renderer routing, native UI) -----------

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  progress?: number;
  version?: string;
  releaseNotes?: string;
  error?: string;
}

export interface TerminalTargetOption {
  id: string;
  label: string;
  isDefault?: boolean;
  /** Agent harnesses only: whether THIS machine can run it right now. */
  installed?: boolean;
  /** Present only for a harness this machine can't run — see main/terminal-target.ts. */
  installCommand?: string;
}

export interface AgentActivityEvent {
  kind: string;
  sessionId: string;
  filePath?: string;
  touchType?: string;
  timestamp?: number;
  repoId?: string;
}

// The three platforms Cube ships on. Narrower than the preload's
// NodeJS.Platform (which also covers aix/freebsd/etc.) so callers don't
// have to handle platforms this app never runs on; electron.ts casts at
// the boundary.
export type DesktopPlatform = "darwin" | "win32" | "linux";

/** What the desktop knows about the Mac it runs on; null where there is no such Mac (the browser). */
export interface LocalComputerInfo {
  homeDir: string;
  cpus: number;
  cpuModel: string | null;
  memoryMb: number;
  /** The volume holding the home directory. */
  storageGb: number | null;
  storageUsedBytes: number | null;
}

export interface ConnectedTool {
  id: string;
  name: string;
  url: string;
  installed: boolean;
  /** Whether the tool can be opened at a directory from here. */
  openable: boolean;
}

/**
 * The host's own services: the local machine's specs and home, the terminal
 * tools detected on it (the Tools and Machine surfaces list them), and
 * opening one of them at a directory. The browser has none of this and
 * answers empty.
 */
export interface ComputerService {
  localInfo(): Promise<LocalComputerInfo | null>;

}

export interface DesktopService {
  /** What this host can do — see capabilities.ts. */
  capabilities: Capabilities;
  getPlatform(): DesktopPlatform;
  getConfig(): Promise<AppConfig>;
  getAppVersion(): Promise<string>;
  getDeviceId(): Promise<string>;
  listTerminalTargets(machineId?: string): Promise<TerminalTargetOption[]>;

  // Legacy nav/viewer selection sends (fire-and-forget, no reply).
  selectFile(path: string | null): void;
  selectFolder(path: string): void;

  openInTerminal(path: string, launch?: LaunchChoice): void;
  revealInFinder(path: string): void;

  // Main->renderer UI routing signals.
  onFileSelected(cb: (path: string | null) => void): Unsubscribe;
  onFolderSelected(cb: (path: string) => void): Unsubscribe;
  onOpenTerminal(cb: (path: string, launch?: LaunchChoice) => void): Unsubscribe;

  showContextMenu(items: ContextMenuItem[]): Promise<string | null>;
  openFolder(): Promise<string | null>;

  openExternal(url: string): void;

  onShortcut(cb: (action: string) => void): Unsubscribe;
  onSettingsToggle(cb: (action: "open" | "close", pane: string | null) => void): Unsubscribe;
  openSettings(
    pane?: "appearance" | "terminal" | "hotkeys",
  ): void;
  closeSettings(): void;
  toggleSettings(): void;

  onLoadingDone(cb: () => void): Unsubscribe;

  setTheme(mode: string): Promise<void>;

  getPathForFile(file: File): string;

  dragPaths: {
    set(paths: string[]): void;
    clear(): void;
    get(): Promise<string[]>;
  };
  onNavDragActive(cb: (active: boolean) => void): Unsubscribe;

  onAgentEvent(cb: (event: AgentActivityEvent) => void): Unsubscribe;
  onShellBlur(cb: () => void): Unsubscribe;

  clipboard: {
    writeText(text: string): Promise<void>;
  };
}

export interface Services {
  log(line: string): void;
  artifacts: { artifactUrl(machineId: string, args: import("@port/shared/artifact").ArtifactUrlArgs): Promise<string> };
  /** The Computer page's view of THIS host — see ComputerService. */
  computer: ComputerService;
  pty: PtyService;
  files: FilesService;
  repos: ReposService;
  catalog: CatalogService;
  worktrees: WorktreesService;
  prefs: PrefsService;
  workspace: WorkspaceService;
  desktop: DesktopService;
}
