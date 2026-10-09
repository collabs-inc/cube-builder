// The machine's catalog of what exists: which repos live on this daemon
// and which items live in each. Authoritative — every attached client
// renders this, so it is the machine's truth and not any client's.
//
// The renderer imports these via `@port/shared/catalog` (renderer code
// must never import from `src/main/`); cubed's CatalogStore
// (`src/main/cubed/catalog.ts`) re-exports the same types for
// main-process callers. `mergeCatalogs` below is the one function here —
// pure, and needed on both sides of the IPC boundary, unlike
// `virtualizeCatalog` (`packages/router/src/router-catalog.ts`), which stays
// main-side only.

export type CatalogItemType = "term" | "agent" | "note" | "code" | "image" | "pdf" | "artifact" | "app";

export type WorktreeSource =
  | { from: "new" }
  | { from: "branch" }
  | { from: "pr"; number: number; url: string; title: string }
  | { from: "issue"; number: number; url: string; title: string };

/**
 * Live git state for one checkout, observed by cubed's sweep — NOT
 * identity. A checkout's identity is its path; the branch sitting in it is
 * state that changes whenever somebody runs `git checkout`, in the primary
 * working copy exactly as much as in a worktree. Every row that names a
 * directory carries one of these, so the two ranks read the same way and
 * neither has to be special-cased.
 *
 * Absent on a row whose directory cubed has not been able to read (a
 * worktree still being created, a repo whose git invocation failed). Absent
 * means unknown, and unknown must render as unknown rather than as `main`.
 */
export interface CheckoutHead {
  /** The checked-out branch, or null when HEAD is detached. */
  branch: string | null;
  /** Short commit sha. The row's label when `branch` is null. */
  sha: string;
}

export interface WorktreeOrigin {
  /** The owning repo row, in the same catalog. */
  repoId: string;
  /**
   * The branch this worktree was CUT ON — provenance, frozen at creation.
   * It is not what is checked out now: read `CatalogRepo.head` for that.
   * Kept because "started from `feat/x`" stays true after the checkout moves
   * on, and because a row created for a PR or issue is still that PR's row
   * whatever branch it currently holds.
   */
  createdOnBranch: string;
  /**
   * What the branch was cut from. Present for the `new` and `issue` sources;
   * absent for `branch` and `pr`, where the branch already existed and no
   * base was chosen.
   */
  baseBranch?: string;
  source: WorktreeSource;
  /**
   * Present only while the worktree does not yet exist on disk. Absent means
   * ready, so a completed row carries no state field that could go stale.
   */
  creation?: { state: "pending" | "failed"; error?: string };
}

export interface CatalogRepo {
  id: string;
  /**
   * Daemon-written only: the persona whose tool or worker created or first entered this checkout.
   */
  personaId?: string;
  name: string;
  root: string;
  /** A repo cubed created or cloned and may delete. False for a referenced directory. */
  managed: boolean;
  originUrl?: string;
  /** Last requested publication target, retained on failure for retry. */
  githubPublish?: { owner: string; name: string; visibility: "private" | "public" };
  createdAt: string;
  /**
   * Live branch/sha in this row's directory, refreshed by the daemon's
   * worktree sweep. Present on repo rows and worktree rows alike — one
   * mechanism, no primary/non-primary split.
   */
  head?: CheckoutHead;
  worktreeOf?: WorktreeOrigin;
  detachment?: { operationId: string; state: "pending" | "incomplete"; code?: string };
}

export interface CatalogItem {
  id: string;
  /**
   * Absent for an item opened outside any repo — that is supported. On an
   * `artifact`, the artifact root: a checkout id, or a persona item id for
   * a context-folder artifact.
   */
  repoId?: string;
  type: CatalogItemType;
  createdAt: string;
  /** On a `type: "app"` item only; written by the daemon, never by a client. */
  app?: import("./app").AppFields;
  ptySessionId?: string;
  target?: string;
  cwd?: string;
  /**
   * Where this terminal is working, as a daemon-native path. Daemon-written
   * only: from an agent's hook reports, or from a shell's accepted `cwd`
   * patch. Unlike `cwd`, the router never virtualizes it, so it compares
   * directly with a repo row's `root`.
   */
  workingDir?: string;
  /** The conversation this terminal is attached to. Authoritative here. */
  agentSessionId?: string;
  /** Daemon-owned live turn identity, retained when its initiating request leaves the ring. */
  agentActivePromptId?: string | number | null;
  /**
   * `agent` items only: which harness this conversation runs on
   * (an AgentHarnessId). A `term` item keeps using `target` for the same
   * fact; the two are not unified because a term's target may be a shell.
   */
  harness?: string;
  /**
   * An `agent` item that directs other agents. Set at creation, never by a
   * patch: a row cannot become a persona, or stop being one, later.
   */
  role?: "persona";
  /** Stable, daemon-generated seed for the persona's gradient avatar. */
  personaColorSeed?: string;
  /**
   * The persona that owns this terminal, agent or artifact. Daemon-written
   * by spawn, claim_artifact, or a validated client catalog:add-item.
   * Never writable through client patches.
   */
  personaId?: string;
  /**
   * Daemon-observed agent activity. Absent means neither running nor
   * blocked. Written ONLY by cubed's attention tracker — never by a client,
   * and deliberately not in `catalog:update-item`'s allowlist.
   *
   * This is the DAEMON's view, not a client's, which is the whole point: it
   * is the one fact about a session that has to be visible to a client
   * which has never opened it. A client derives activity from the stream it
   * read, and only a client that attached has one; the phone that just
   * unlocked needs to see which row is asking for it before it opens
   * anything.
   */
  agentActivity?: "running" | "blocked";
  /**
   * Set while `blocked` is held on an expired hook lease: the block is real
   * but unconfirmed. Presentation only; it never retires a request.
   */
  agentActivityStale?: boolean;
  /** When the daemon last saw a turn end. Monotonic per item. */
  turnEndedAt?: string;
  /**
   * Stream position at which that turn ended — the session's byte cursor
   * for a `term` item, the conversation's record cursor for an `agent`
   * item. A client acknowledges a completion only once it has applied
   * content at least this far, which is what makes "the user has seen this"
   * answerable rather than assumed.
   */
  turnEndedCursor?: number;
  /**
   * The generation `turnEndedCursor` was measured in, which for a terminal
   * is its `ptySessionId`. A cursor is counted against one ptyd session's
   * ring and is meaningless against another, so the generation travels with
   * it. This is NOT `browserContext.launchId`, which exists before a pty
   * session does and serves reporter authorization elsewhere.
   */
  turnEndedLaunchId?: string;
  /** Last spawned pipe generation for reports; survives clearing ptySessionId on exit. */
  agentReportSessionId?: string;
  /**
   * Legacy projection of `agentActivity === "blocked"`, kept for one
   * release cycle because `ADMISSION_BRIDGE` still admits clients that read
   * this field and nothing else. Generated by `projectLegacy`
   * (src/main/cubed/attention/projection.ts) in the same patch as
   * `agentActivity`, never written independently. Absent means "not
   * waiting" — a row from a daemon that predates the field reads exactly as
   * it always did.
   */
  awaitingPermission?: boolean;
  exitedAt?: string;
  exitCode?: number;
  filePath?: string;
  userTitle?: string;
  agentTitle?: string;
  /** Artifact file revision, used to refresh previews after writes or reconnects. */
  updatedAt?: string;
  /**
   * Site artifacts only: the loopback port a detected dev server listens on.
   * Its presence is what makes an `artifact` a site. Daemon-written.
   */
  port?: number;
  /** Site artifacts only: the loopback address the HTML probe reached. Daemon-written. */
  siteAddress?: "127.0.0.1" | "::1";
  /**
   * Site artifacts only: the PTY session whose printed URL owns this site.
   * Absent for an unclaimed site. Daemon-written.
   */
  siteClaimSessionId?: string;
  /** Site artifacts only: set while a claimed site's server is down or has not passed a recovery probe. */
  stopped?: boolean;
}

export type OwnedSessionRef = {
  kind: "terminal" | "agent";
  itemId: string;
  sessionId: string;
  registrationId: string;
  stopped: boolean;
};

export type DetachRecord = {
  operationId: string;
  /** Other request ids permanently bound to this canonical operation. */
  joinedOperationIds?: string[];
  registrationId: string;
  repoIds: string[];
  roots: string[];
  sessions: OwnedSessionRef[];
  state: "pending" | "incomplete" | "complete";
  code?: string;
};

export interface CatalogDocument {
  version: 1;
  /** Minted only when a document is created fresh. Distinguishes a reset
   * catalog restarting at rev 1 from a stale broadcast. */
  epoch: string;
  rev: number;
  repos: CatalogRepo[];
  items: CatalogItem[];
  detachments?: DetachRecord[];
  detachedRoots?: Array<{ root: string; registrationId: string }>;
}

// -- Per-machine aggregation -------------------------------------------
//
// A machine's raw CatalogDocument tagged with the stable daemon identity
// it came from. The router keeps these separate (one per attached daemon,
// each with its own epoch/rev) rather than merging them, because the
// renderer's accept rule ("different epoch, or greater rev in the same
// epoch") is per-machine — a merged view has nowhere to hang that. Merging
// down to one flat sidebar model (`mergeCatalogs`) is the LAST step,
// done by whoever is about to render, not by whoever fetched the trees.

export interface MachineCatalog {
  machineId: string;
  catalog: CatalogDocument;
}

export type OwnedRepo = CatalogRepo & { machineId: string };
export type OwnedItem = CatalogItem & { machineId: string };

export interface MergedCatalog {
  repos: OwnedRepo[];
  items: OwnedItem[];
}

/** One sidebar model from every attached daemon's tree. Each entry knows
 * its machine, so a mutation on a row always knows where to send. */
export function mergeCatalogs(trees: MachineCatalog[]): MergedCatalog {
  const repos: OwnedRepo[] = [];
  const items: OwnedItem[] = [];
  for (const { machineId, catalog } of trees) {
    for (const repo of catalog.repos) repos.push({ ...repo, machineId });
    for (const item of catalog.items) items.push({ ...item, machineId });
  }
  return { repos, items };
}
