import type { ResourceSpecs, ResourcePrice } from "./manual-pricing";
// A worktree row's provenance is a catalog fact, so its type lives with
// the catalog shapes; RepoInfo re-exposes it unchanged rather than
// restating it (type-only, so nothing is imported at runtime).
import type { PlanId } from "./pricing";
import type { CatalogItem, CheckoutHead, WorktreeOrigin } from "./catalog";

export interface TreeNode {
  /**
   * Root-relative on the cubed wire; rewritten to an absolute (local) or
   * virtual /@cloud/<id>/… (cloud) path by RepoRouter before it reaches a
   * renderer. See the cloud-file-browsing design, D8.
   */
  path: string;
  name: string;
  kind: "folder" | "file";
  ctime: string;
  mtime: string;
  /** Folders only; populated when the caller asked for counts. */
  fileCount?: number;
  children?: TreeNode[];
  /**
   * Files only, present only when the caller passed detectBinary. True for a
   * file that is binary but still shown (images and PDFs) — non-viewable
   * binaries are dropped from the listing entirely, not labelled.
   */
  isBinary?: boolean;
  /** Folders only: children were cut short by depth/maxEntries. */
  truncated?: true;
}

/**
 * Shape of a fs:writefile reply. Main (src/main/files.ts) and the app
 * renderer (src/windows/app/src/services/types.ts) each declare their own
 * copy scoped to their own IPC boundary; this one is for callers with no
 * boundary of their own to declare it on — packages/components (Editor.tsx
 * / CodeEditorView.tsx take an onTextChange/onContentChange callback typed
 * against it) and @cube/router's `router.ts` (its `writeFile`'s return
 * type).
 */
export interface WriteResult {
  ok: boolean;
  mtime: string;
  conflict?: boolean;
}

/**
 * One entry from a directory listing — main/files.ts's fsReadDir and the
 * daemon's directory listing op both return these, and filterDirEntries
 * applies the workspace ignore rules to them before the renderer sees them.
 * `fileCount` is only ever set on a directory entry, after filtering.
 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  createdAt: string;
  modifiedAt: string;
  fileCount?: number;
}

export interface ViewerItem {
  id: string;
  title: string;
  type: string;
  isEditable: boolean;
  isTitleEditable?: boolean;
  url?: string;
  fileUrl?: string;
  summary?: string;
  quotes?: Quote[];
  quotesTitle?: string;
  text?: string;
  rawContext?: string;
  createdAt: number;
  modifiedAt: number;
  relatedConcepts?: Concept[];
  sources?: ItemSource[];
  isPinned?: boolean;
  cube_reviewed?: boolean;
  frontmatter?: Record<string, unknown>;
}

export interface Quote {
  text: string;
}

export interface ItemSource {
  [sourceName: string]: SourceItem[];
}

export interface SourceItem {
  id: string;
  title: string;
  type: string;
  author?: string;
  url?: string;
  urlThumbnail?: string;
  summary?: string;
  text?: string;
  excerpts?: string[];
  relatedConcepts?: Concept[];
  modifiedAt?: number;
}

export interface Concept {
  id: string;
  title: string;
  similarityScore?: string;
  degree?: number;
}

// ── File watcher types ──

export type FileChangeType = 1 | 2 | 3;
export const FileChangeType = {
  Added: 1 as const,
  Updated: 2 as const,
  Deleted: 3 as const,
};

export interface FileChange {
  path: string;
  type: FileChangeType;
}

export interface FsChangeEvent {
  dirPath: string;
  changes: FileChange[];
}

// ── Folder table types ──

export interface FolderTableFile {
  path: string;
  filename: string;
  frontmatter: Record<string, unknown>;
  mtime: string;
  ctime: string;
}

export interface FolderTableData {
  folderPath: string;
  files: FolderTableFile[];
  columns: string[];
}

// ── App config types (mirrors main/config.ts) ──

export interface AppConfig {
  window_state: { x: number; y: number; width: number; height: number; isMaximized?: boolean } | null;
  ui: Record<string, unknown>;
}

// ── Agent harness ids ──
//
// CLI agents a terminal item can launch directly instead of a shell. Single
// source of truth shared by the two places that need it: the single
// renderer's title-trust gate (TerminalItem.tsx's `acceptTitles`, derived
// from AGENT_TARGETS) and the main process's launch authority
// (main/terminal-target.ts).
export const AGENT_HARNESS_IDS = ["claude", "codex", "opencode"] as const;
export type AgentHarnessId = (typeof AGENT_HARNESS_IDS)[number];

/**
 * The harnesses `spawn_agent` launches as a persona's worker, shared by the
 * registry that refuses the rest and the UI that routes only these to it. A
 * worker reports through its turn-completion hook, and OpenCode runs none.
 */
export const WORKER_HARNESSES: ReadonlySet<string> = new Set<AgentHarnessId>(["claude", "codex"]);

/**
 * Whether a catalog item is a persona's worker: an owned terminal or agent
 * running one of WORKER_HARNESSES. A shell or OpenCode terminal in a persona's
 * tree is owned but no worker — it never reports, so it is never waited on.
 * Liveness and activity are each caller's own question.
 */
export function isWorkerItem(item: CatalogItem): boolean {
  return item.personaId !== undefined && (item.type === "term" || item.type === "agent")
    && WORKER_HARNESSES.has(item.harness ?? item.target ?? "");
}

/**
 * What a terminal item launches into — a plain shell, a WSL distro (the
 * `wsl:${string}` variant carries the distro name), or one of the agent
 * CLIs in AGENT_HARNESS_IDS above. "auto" defers to the platform default.
 * main/config.ts's isTerminalTarget is the runtime type guard for this
 * union; it stays there since it isn't derived from a shared const array.
 */
export type TerminalTarget =
  | `catalog:${string}`
  | "auto"
  | "powershell"
  | "shell"
  | "claude"
  | "codex"
  | "opencode"
  | `wsl:${string}`;

// Marks a pty:create rejection caused by a harness this machine cannot run
// (main/terminal-target.ts's assertHarnessInstalled). The rest of the
// message is written for the user, so the renderer shows it in the tile
// instead of the generic "Session ended" — see terminal-item-logic.ts's
// sessionEndedMessage, which finds this prefix inside whatever wrapping
// Electron's IPC layer has added by then.
export const HARNESS_MISSING_PREFIX = "harness-not-installed: ";

// Marks the one rejection that definitively means a session is gone rather
// than temporarily unreachable: cubed's terminals.open throws it when
// neither the live nor the exited list knows the id. Every other failure —
// a timeout, a closed socket — may still have a live session behind it, so
// only this marker may be treated as proof of death (see
// restore-session.ts's isDeadSessionError, and the router's own
// reattach-time twin). Matched as a substring because the message picks up
// wrapping on its way through Electron's IPC layer.
export const DEAD_SESSION_MARKER = "session-not-found";

// ── Shared "context-menu:show" IPC shape ──
//
// One level of nesting is all any caller needs today (a "New agent"
// submenu offering the harness choices). Lives here rather than in
// window-api.d.ts so main-process and preload code can import it without
// pulling in that file's ambient `Window.api` augmentation — which would
// silently defeat its own TS2339 guardrail against unguarded `window.api`
// access outside a renderer.
export interface ContextMenuItem {
  id: string;
  label: string;
  enabled?: boolean;
  /** Shortcut hint; the app's shortcut dispatcher owns key handling. */
  accelerator?: string;
  submenu?: ContextMenuItem[];
}

// ── Virtual cloud paths ──
//
// A cloud repo's files never sit under a real path on this
// machine, so the renderer addresses them through a synthetic absolute
// path instead: `/@cloud/<repoId>/<rel>`. The router (main process) and
// the renderer both need this prefix — the router to route requests and
// rebuild watch events, the renderer to recognize and display these paths
// — so it lives here rather than in main-process-only code. Parsing lives
// in path-utils.ts, alongside the other synthetic-path parser
// (`parseWslUncPath`).
export const CLOUD_PATH_PREFIX = "/@cloud/";

/**
 * The local machine's pool/status id — the router's sentinel for the shared
 * local daemon (`MACHINE_REPO_ID` aliases this). Shared so the renderer's
 * This Mac header can resolve the daemon's `repo:status` entry by the same
 * key the router broadcasts it under.
 */
export const LOCAL_MACHINE_ID = "machine";

/**
 * One forwarded port pair — a remote port a cloud dev server is listening
 * on, mirrored to a local one. The source of truth: main's own
 * `src/main/port-forward/local-listeners.ts` re-exports this rather than
 * declaring its own, so the renderer's services layer can use this exact
 * shape without ever reaching into `src/main/`.
 */
export interface ForwardEntry {
  remotePort: number;
  localPort: number;
  /** App infrastructure: forwarded for app/OAuth connectivity, omitted from the developer ports UI. */
  appOwned?: true;
}

// ── Renderer-visible repo shape ──
//
// The registry (repo-registry.ts) has no secrets of its
// own to strip anymore — machineToken/endpointUrl live on CloudMachine, not
// on a repo — but RepoInfo remains the stripped-down shape the main
// process sends across IPC: both the single-renderer app and this package's
// own preload typings share this one definition rather than each declaring
// its own. `path` is present only for a local repo; a cloud repo has
// no real filesystem root, so callers that need one address it through the
// virtual `CLOUD_PATH_PREFIX`-prefixed path instead (see path-utils.ts's
// `parseCloudPath`).
export interface RepoInfo {
  id: string;
  name: string;
  kind: "local" | "cloud";
  path?: string;
  /** Present only on a worktree row — its owning repo, the branch it was cut
   * on, and, while the checkout does not yet exist on disk, its creation
   * state. Carried verbatim from the catalog repo it views (see
   * repo-views.ts): the sidebar nests and gates rows on exactly these
   * fields. It does NOT say what is checked out now — read `head` for that. */
  worktreeOf?: WorktreeOrigin;
  /** Whether the machine OWNS this directory — one of cubed's own clones,
   * which removing the repo deletes outright — rather than merely
   * referencing a directory the user picked, which removal leaves alone.
   * Not derivable from `kind`: a cloud repo is always a clone, but a local
   * one may be either, and the remove confirm has to say which. */
  managed: boolean;
  /** Live branch/sha in this repo's directory, as the machine last
   * observed it. Absent means unknown, which is not the same as detached. */
  head?: CheckoutHead;
}

// Mirrors packages/cloud-account/src/machine.ts's CloudMachineStatus —
// duplicated rather than imported so this shared package stays
// main-process-independent (same rationale as services/types.ts's
// MachineStatus, which this supersedes once Task 4 wires it through).
export type CloudMachineStatus =
  | "absent"
  | "creating"
  | "bootstrapping"
  | "waking"
  | "running"
  | "suspended"
  | "error";

// ── Renderer-visible cloud machine shape ──
//
// The stripped-down counterpart to RepoInfo for CloudMachine — the
// renderer needs to know a machine is paired and show its name and status,
// never its machineToken. "unpaired" covers a cached CloudMachine record
// with no live account-service state yet (e.g. signed out, or before the
// first refresh completes) — distinct from `machine:get` returning null
// outright, which means no CloudMachine is cached at all.
export type MachineInfoStatus = CloudMachineStatus | "unpaired";

export interface MachineInfo {
  /** Freshness of the lifecycle row, independent of daemon connectivity. */
  freshness?: import("./app-plane-outcome").AppPlaneFreshness;
  id: string;
  name: string;
  status?: MachineInfoStatus;
  statusDetail?: string | null;
  endpointUrl?: string | null;
  /** Label only, without the zone. Null until the machine claims one. */
  sshHostname?: string | null;
}

// ── Whole-app readiness ──
//
// Cloud lifecycle/readiness is separate from the workspace's durable
// returning-user presentation. Transport recovery lives in CloudRecoveryState.
/** What the client may do toward the hosted machine — the one decision
 * readiness, pairing and the router all read. See the free-tier spec,
 * "Hosted entitlement and authority". */
export type HostedAuthority = "entitled" | "cached" | "unknown" | "none";

export type ReadinessStep =
  | "signed-out"
  | "loading"
  | "local"
  | "provisioning"
  | "recovering"
  | "ready";

export interface Readiness {
  /** Validated durable onboarding for the installed account and machine. */
  returningUser?: boolean;
  step: ReadinessStep;
  /** Absent only before an account is installed. */
  authority: HostedAuthority;
  detail: string | null;
  error: string | null;
}

/** The `error` a `local` readiness carries for a suspended account — a
 * contract value, not copy. Only deriveReadiness produces it. */
export const BILLING_SUSPENDED = "billing-suspended";

/**
 * The `provisioning` detail deriveReadiness emits while the machine is
 * running but the first gh check hasn't answered (gh "unknown"). Part of
 * the Readiness contract rather than free-form copy: the producer
 * (packages/cloud-account/src/readiness.ts) and the renderer's copy module
 * (src/windows/app/src/machine-copy.ts) both re-export it, and GateModal's
 * phase rail keys its "nearly done" rendering on the machine being running
 * while this step persists. User-facing: U+2026, not "...".
 */
export const GH_CONNECTING_DETAIL = "Connecting your GitHub account…";

/** Result of cubed's github:auth-status op — GitHub auth state on the machine. */
export interface GithubAuthStatus {
  authenticated: boolean;
  /** GitHub login, when authenticated and the profile fetch succeeded. */
  login?: string;
  /** Why not authenticated — "not signed in" or an install/tooling problem. */
  reason?: string;
}

/**
 * One repo entry from cubed's github:list-repos op — mirrors
 * src/main/cubed/github-repos.ts's own GithubRepo (duplicated rather than
 * imported so this shared package doesn't pull in cubed's module graph,
 * the same rationale as CloudMachineStatus/MachineStatus above).
 */
export interface GithubRepo {
  nameWithOwner: string;
  isPrivate: boolean;
}

// ── Billing ──
//
// Mirrors supabase/functions/_shared/billing-db.ts's BillingStatus/BillingRow
// — duplicated rather than imported across the Deno/app boundary (the edge
// functions run on Deno and this package ships inside the Electron app;
// neither can depend on the other's module graph), same discipline as
// ensure-core.ts's CloudMachineRef duplicating packages/machines' shape in
// the opposite direction. Unlike MachineInfo/CloudMachineState this app has
// no main-only field to strip (no token, nothing sensitive), so
// packages/cloud-account/src/billing.ts imports this same type directly rather
// than keeping a parallel main-process-only shape.
export type BillingStatus = "none" | "trialing" | "active" | "grace" | "suspended";

export interface PrepaidSwitchCapability { available: boolean; deadline: string | null }
export type PrepaidSwitchAction =
  | { action: "preview" }
  | { action: "confirm"; requestId: string; quoteId: string }
  | { action: "status"; id?: string };
export type PrepaidSwitchResult =
  | { kind: "preview"; preview: { cohort: string; specs: ResourceSpecs; price: ResourcePrice; quoteId: string;
      goodwillMicroUsd: string; openingBalanceMicroUsd: string; machineState: "started" | "stopped" } }
  | { kind: "progress"; id: string; phase: string };

export interface BillingState {
  prepaidSwitch?: PrepaidSwitchCapability;
  manual?: import("./manual-pricing").ManualSummary | null;
  mode?: "prepaid_manual";
  planId?: PlanId | null;
  status: BillingStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
}

export type CloudRecoveryState = {
  phase: "offline" | "connecting" | "connected" | "retrying" | "action-required";
  attempt: number;
  failure: import("./app-plane-outcome").AppPlaneFailure | null;
};
/** Serializable roll acceptance/refusal; readiness is settled by the caller. */
export interface MachineRollResponse {
  txn: string;
  client_version: string;
  backend_version?: string;
  result: "accepted" | "refused:release-mismatch" | "refused:already-current" | "failed";
  message?: string;
}
