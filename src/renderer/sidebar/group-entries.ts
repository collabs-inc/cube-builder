/**
 * Pure grouping/status logic for the repos sidebar, kept free of React
 * and IPC so it can be unit tested without a DOM.
 */



import { CLOUD_PATH_PREFIX, type MachineInfo, type RepoInfo } from "@port/shared/types";
import type { WorktreeOrigin, WorktreeSource } from "@port/shared/catalog";
import { UNAUTHORIZED_MESSAGE } from "@port/shared/backend-pool";
import { PTYD_PIPE_INTERFACE } from "@port/shared/ptyd-protocol";
import { isProvisionPhase, PROVISION_PHASE_COPY } from "../machine-copy";

export type { MachineInfo, RepoInfo };

export interface GroupableEntry {
  id: string;
  repoId: string | null;
}

export interface EntryGroup<TEntry extends GroupableEntry> {
  /** null identifies the trailing "Unscoped" group. */
  repoId: string | null;
  repo: RepoInfo | null;
  entries: TEntry[];
}

/**
 * Groups entries by their `repoId`, one group per repo in `repos`
 * order (present even when empty, so an empty repo still gets a header),
 * followed by a trailing "Unscoped" group for entries whose `repoId` is
 * null or does not match any known repo. The Unscoped group is omitted
 * entirely when it would be empty — there is no repo to anchor its
 * header to.
 */
export function groupEntries<TEntry extends GroupableEntry>(
  entries: TEntry[],
  repos: RepoInfo[],
): EntryGroup<TEntry>[] {
  const groups: EntryGroup<TEntry>[] = repos.map((repo) => ({
    repoId: repo.id,
    repo,
    entries: [],
  }));
  const byId = new Map(groups.map((group) => [group.repoId, group]));

  const unscoped: TEntry[] = [];
  for (const entry of entries) {
    const group = entry.repoId ? byId.get(entry.repoId) : undefined;
    if (group) {
      group.entries.push(entry);
    } else {
      unscoped.push(entry);
    }
  }

  if (unscoped.length > 0) {
    groups.push({ repoId: null, repo: null, entries: unscoped });
  }

  return groups;
}

/**
 * Display order for the sidebar: each repo in catalog order, immediately
 * followed by its worktrees in catalog order. The catalog appends a
 * worktree repo on creation, so its own order *is* creation order and
 * nothing here needs a timestamp to sort by. A worktree whose parent is
 * absent is dropped — it has no row to indent under.
 *
 * Kept separate from groupEntries so the grouping logic stays untouched:
 * the sidebar calls groupEntries(entries, repoDisplayOrder(repos)).
 * Generic over the repo shape so a caller with a richer row type keeps
 * it — only `id` and `worktreeOf` are read.
 */
export function repoDisplayOrder<P extends { id: string; worktreeOf?: WorktreeOrigin }>(
  repos: P[],
): P[] {
  const byParent = new Map<string, P[]>();
  for (const repo of repos) {
    const parentId = repo.worktreeOf?.repoId;
    if (!parentId) continue;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(repo);
    else byParent.set(parentId, [repo]);
  }
  const ordered: P[] = [];
  for (const repo of repos) {
    if (repo.worktreeOf) continue;
    ordered.push(repo, ...(byParent.get(repo.id) ?? []));
  }
  return ordered;
}

/**
 * One checkout of a repo — its own working copy, or a linked worktree —
 * together with the items living in it.
 *
 * The repo's primary working copy is a row here like any other. It used to
 * be implied: a repo's own terminals hung directly off the repo row, which
 * made them siblings of the WORKTREE rows rather than of the other
 * checkouts' terminals. Naming it fixes the nesting and gives the branch
 * sitting in the main checkout somewhere to be displayed.
 */
export interface CheckoutSection<TEntry extends GroupableEntry> {
  repo: RepoInfo;
  /** The repo's own working copy, not a linked worktree. */
  primary: boolean;
  entries: TEntry[];
}

/** A repo and every checkout of it, primary first. */
export interface RepoSection<TEntry extends GroupableEntry> {
  repo: RepoInfo;
  checkouts: CheckoutSection<TEntry>[];
}

/**
 * Folds the flat group list into repo → checkouts → items.
 *
 * Takes the output of `groupEntries(entries, repoDisplayOrder(repos))`,
 * which already orders each repo immediately ahead of its own worktrees, so
 * one pass is enough and the primary lands first by construction. A worktree
 * group whose repo is not in the list is dropped, exactly as
 * `repoDisplayOrder` drops it — it has nothing to nest under.
 *
 * The trailing Unscoped group (`repoId: null`) is not a repo and is left
 * for the caller to render on its own.
 */
export function repoSections<TEntry extends GroupableEntry>(
  groups: EntryGroup<TEntry>[],
): RepoSection<TEntry>[] {
  const sections: RepoSection<TEntry>[] = [];
  const byRepoId = new Map<string, RepoSection<TEntry>>();
  for (const group of groups) {
    const repo = group.repo;
    if (!repo) continue;
    if (!repo.worktreeOf) {
      const section: RepoSection<TEntry> = {
        repo: repo,
        checkouts: [{ repo, primary: true, entries: group.entries }],
      };
      sections.push(section);
      byRepoId.set(repo.id, section);
      continue;
    }
    byRepoId
      .get(repo.worktreeOf.repoId)
      ?.checkouts.push({ repo, primary: false, entries: group.entries });
  }
  return sections;
}

/**
 * What a checkout row is CALLED — its identity, which is stable across
 * `git checkout`. The branch it currently holds is a separate value
 * (`checkoutBranch`) rendered beside it, because the two genuinely differ:
 * a worktree named "Fix OAuth retry" lives on `fix-oauth-retry`, and either
 * one can change without the other.
 *
 * A PR or issue worktree keeps naming its PR or issue: that is what the row
 * was made for and it stays true whatever branch the directory ends up
 * holding. Both name the NOUN and the number and nothing else — `PR #412`,
 * `Issue #88`. The mark used to carry that distinction (a pull-request
 * glyph, a dashed circle) and no longer does, so the label is the only
 * thing left saying which of the two a row is. The issue title is
 * deliberately not in it: the branch pill beside the name already says what
 * the issue is about, and a full title in a fixed-width sidebar spends the
 * horizontal space that pill needs. The number identifies, the branch
 * describes.
 *
 * The repo's own working copy has no name of its own — the repo row
 * directly above already names it — so it is labeled by what it is.
 * Everything else uses the name it was created with.
 *
 * Always present, even when it currently reads the same as the branch. A
 * `branch`-sourced worktree is created with its branch AS its name, so this
 * did suppress the name to avoid printing one string twice — which turned
 * out to be wrong twice over. A row with no name is a row that has lost its
 * identity, and the duplication is temporary anyway: the moment somebody
 * checks something else out, a worktree called `main` sitting on
 * `worktree-improvements` is exactly the pair you need to see.
 */
export function checkoutName(repo: RepoInfo): string {
  const source = repo.worktreeOf?.source;
  if (source?.from === "pr") return `PR #${source.number}`;
  if (source?.from === "issue") return `Issue #${source.number}`;
  if (!repo.worktreeOf) return PRIMARY_WORKTREE_LABEL;
  return repo.name;
}

/**
 * How the repo's own working copy is labeled. Git's own documentation calls
 * this the "main working tree" (the others are "linked working trees"), but
 * "main" is also the commonest branch name in the world and this label sits
 * directly beside a branch pill — so the row would read "main worktree
 * [main]". "Primary" says the same thing with nothing to collide with.
 */
export const PRIMARY_WORKTREE_LABEL = "Primary worktree";

/**
 * The branch a checkout row holds right now, or null when the machine has
 * not observed it. Every rank answers this the same way — the repo's own
 * working copy is a checkout like any other.
 *
 * A detached checkout answers with its short sha: it is on something, and
 * the row should say what rather than go blank. A worktree still being
 * created answers with the branch it is in the middle of claiming.
 */
export function checkoutBranch(repo: RepoInfo): string | null {
  if (repo.head) return repo.head.branch ?? repo.head.sha;
  return repo.worktreeOf?.createdOnBranch ?? null;
}

/** A checkout sitting on a commit rather than a branch. Rendered differently — it is a real state, not a missing value. */
export function isDetached(repo: RepoInfo): boolean {
  return repo.head !== undefined && repo.head.branch === null;
}

/**
 * The GitHub URL a worktree's source names, or null when it doesn't carry
 * one — only `pr` and `issue` sources do (`new` and `branch` cut from a
 * branch that has no associated URL). Gates the worktree context menu's
 * "Open on GitHub" item.
 */
export function worktreeGithubUrl(source: WorktreeSource): string | null {
  return source.from === "pr" || source.from === "issue" ? source.url : null;
}

/**
 * How many worktree rows nest under repo `repoId` — the repo-remove
 * confirm's cascade count (`repoRemoveConfirmDetail` in worktree-copy.ts).
 * Takes the all-rows repo list (every repo and worktree the catalog
 * holds), same as `useCheckedOutRows`'s sibling filter.
 */
export function worktreeCountFor<P extends { id: string; worktreeOf?: WorktreeOrigin }>(
  repos: P[],
  repoId: string,
): number {
  return repos.filter((p) => p.worktreeOf?.repoId === repoId).length;
}

export type DotStatus = "open" | "connecting" | "closed" | "error" | "unknown";

export interface StatusEntry {
  status: string;
  error?: string;
}

export type StatusMap = Record<string, StatusEntry>;

const KNOWN_STATUSES = new Set<string>(["open", "connecting", "closed", "error"]);

/**
 * Resolves the dot status for a repo id. A repo missing from the
 * snapshot (never connected, or the snapshot hasn't arrived yet) resolves
 * to "unknown" rather than "closed" — those read the same visually (faint,
 * neutral) but must never be labeled "closed" in the UI, since that would
 * claim knowledge the shell doesn't have.
 */
export function resolveStatus(
  repoId: string,
  statuses: StatusMap,
): DotStatus {
  const entry = statuses[repoId];
  if (!entry || !KNOWN_STATUSES.has(entry.status)) return "unknown";
  return entry.status as DotStatus;
}

/**
 * Resolves the dot status for the cloud-machine header row. A null machine
 * (unpaired, or its `get()` hasn't resolved yet) has no id to look up and
 * resolves to "unknown" — the same faint/neutral dot a never-reported
 * repo gets. Otherwise defers to `resolveStatus` keyed on the machine's
 * own id: the router broadcasts `repo:status` under the machine id (Task 6
 * connects the cloud machine as a pool member), the same mechanism every
 * repo's status rides.
 */
export function machineHeaderStatus(machine: MachineInfo | null, statuses: StatusMap): DotStatus {
  if (!machine) return "unknown";
  return resolveStatus(machine.id, statuses);
}

export interface LiveDetailEntry {
  /** What the row was launched into — the fact its icon already shows. */
  target: string | null;
  liveCommand: string | null;
  touchedFile: string | null;
}

/**
 * Picks which live-activity string to show on a terminal row, or null to
 * leave the row's gutter empty.
 *
 * The foreground command is shown only when it CONTRADICTS the row's icon.
 * Every agent terminal used to print its own foreground process here —
 * five rows of an agent-driven sidebar all reading "node", because that is
 * what the agent CLIs are — which spent the right edge of every row on the
 * one fact the row's icon already carried. A value that never varies is not
 * a signal.
 *
 * What IS worth the space is the disagreement: the session you opened as
 * claude has exited and you are sitting at a shell, or a build is running
 * where an agent used to be. So the command appears exactly when it is not
 * the harness the row was opened as, and the last file an agent touched
 * fills the gutter the rest of the time.
 */
export function resolveLiveDetail(entry: LiveDetailEntry): string | null {
  const surprising = entry.liveCommand !== null && !repeatsTarget(entry.liveCommand, entry.target);
  if (surprising) return entry.liveCommand;
  return entry.touchedFile || null;
}

/**
 * The agent CLIs are JavaScript programs, and what ptyd sees in the
 * foreground of a `claude` row is the runtime that hosts it — `node` on a
 * cloud machine, `bun` for a natively installed build — not a process
 * called "claude". So a runtime under an agent target is the agent, and
 * saying "node" on every agent row is the exact non-signal this function
 * exists to suppress. A runtime under a plain shell is still news: it is
 * a script the user ran.
 */
const AGENT_RUNTIMES = new Set(["node", "bun", "deno"]);
const AGENT_TARGETS = new Set(["claude", "codex", "opencode"]);

function repeatsTarget(liveCommand: string, target: string | null): boolean {
  if (liveCommand === target) return true;
  return target !== null && AGENT_TARGETS.has(target) && AGENT_RUNTIMES.has(liveCommand);
}

// ── Kind-specific row logic ──
//
// A cloud repo has no real filesystem root (see RepoInfo's `path`),
// so anything that needs to address its files or spawn a terminal inside it
// uses the virtual root instead. PTY creation (Task 7) and the file browser
// (fs:readtree, routed through `/@cloud/<repoId>/…`) both understand
// this prefix, so this is the single correct expression for both kinds.
export function virtualRootFor(repo: RepoInfo): string {
  return repo.path ?? `${CLOUD_PATH_PREFIX}${repo.id}`;
}

/**
 * What a machine section is called. The two headers name the same kind of
 * thing in the same words — a machine, qualified by where it runs — so the
 * pair reads as one axis rather than as a device ("This Mac") sitting beside
 * a place ("Cloud").
 */
export function kindLabel(kind: RepoInfo["kind"]): "Local machine" | "Cloud machine" {
  return kind === "local" ? "Local machine" : "Cloud machine";
}

/** A cloud repo's stale-token error — the pool reports this as UNAUTHORIZED_MESSAGE. */
export function isStaleCloudToken(kind: RepoInfo["kind"], error: string | undefined): boolean {
  return kind === "cloud" && error === UNAUTHORIZED_MESSAGE;
}

/**
 * The status-dot tooltip text for a repo row. A non-error status keeps
 * its fixed label (the caller supplies it — STATUS_LABELS in App.tsx); an
 * error status prefers the stale-token hint over the raw pool message when
 * it applies.
 */
export function errorRowDetail(kind: RepoInfo["kind"], error: string | undefined): string {
  if (isStaleCloudToken(kind, error)) return "Access token stale — Retry";
  return error ?? "Error";
}

/**
 * The status-dot tooltip text for the cloud-machine header row's error
 * state — the machine-header counterpart to `errorRowDetail`. Cloud-kind by
 * construction (the local-machine header surfaces the local daemon's raw error
 * via `errorRowDetail("local", ...)` instead), so this always resolves
 * through the same stale-token hint `errorRowDetail("cloud", ...)` would
 * for a cloud repo sharing that same failure.
 */
export function machineHeaderDetail(error: string | undefined): string {
  return errorRowDetail("cloud", error);
}

/**
 * The local machine section's scoped empty-state action label, or null once
 * any local repo exists — rendered as the dashed "+ Add …" button. Scoped per section (spec amendment 2026-08-09): the
 * old sidebar-global "No repos yet" rendered directly under the Cloud
 * header, where it read as a claim about the whole sidebar — false the
 * moment any repo existed anywhere.
 */
export function localSectionEmptyText(repoCount: number): string | null {
  return repoCount === 0 ? "Add local repo" : null;
}

/**
 * The cloud machine section's scoped empty-state action label — invites
 * adding the first cloud repo once the machine is up and none exist yet. Signing
 * in and connecting GitHub are handled entirely by the whole-app gate
 * (GateModal) before this section is ever reachable, so this only has the
 * machine's own provisioning state left to account for: it returns null
 * for anything short of `running`, since the header row already carries
 * that phase (`machineProvisionOverride`) and duplicating it here would be
 * redundant.
 */
export function cloudSectionEmptyText(machine: MachineInfo | null, repoCount: number): string | null {
  if (!machine || machine.status !== "running") {
    return null;
  }
  if (repoCount === 0) {
    return "Add cloud repo";
  }
  return null;
}

export interface MachineHeaderOverride {
  /** Reuses the pool-connectivity dot vocabulary — "connecting" already
   * pulses, "error" is already a solid destructive dot — so a provisioning
   * phase needs no new status-dot styling. */
  status: DotStatus;
  message: { text: string; isError: boolean };
  /** Offers the confirmed image update for a stranded machine or missing
   * conversation capability. Provisioning failures still use Retry. */
  canUpdate?: boolean;
}

/**
 * Overrides the cloud machine header's normal pool-connectivity display
 * while the machine doesn't have pool connectivity to report yet: mid
 * provisioning (creating/bootstrapping/waking) or failed to provision
 * (`status: "error"`). Returns null once the machine is running or
 * suspended (or its live status hasn't arrived yet — "absent"/"unpaired"),
 * at which point the caller falls back to `machineHeaderStatus`. Never a
 * frozen dot with no text: every phase this returns non-null for carries a
 * visible `message`, and `statusDetail` refines the default phase copy
 * when the machine reports one. The error phase's own Retry lives only in
 * the whole-app gate (GateModal) now — this header is status-only.
 */
export function machineProvisionOverride(machine: MachineInfo | null): MachineHeaderOverride | null {
  if (!machine) return null;
  if (isProvisionPhase(machine.status)) {
    return {
      status: "connecting",
      message: { text: machine.statusDetail || PROVISION_PHASE_COPY[machine.status], isError: false },
    };
  }
  if (machine.status === "error") {
    return {
      status: "error",
      message: { text: machine.statusDetail || "Something went wrong", isError: true },
    };
  }
  return null;
}

/** Prefix every stranded reason carries — the renderer's copy of
 *  cloud-attach.ts's STRANDED_MESSAGE_PREFIX. Duplicated on purpose, not
 *  imported: the renderer cannot import main-process modules. */
const STRANDED_MESSAGE_PREFIX = "This machine needs a full update";

/** The stranded state: the machine is running, and cannot run this app's
 *  cubed. Distinguished from an ordinary error by the message the main
 *  process produced, because it is the only machine error with a remedy
 *  the user can take.
 *
 *  The reason reaches the renderer through TWO channels, and the button has
 *  to appear for either. The one production actually uses is the POOL
 *  ERROR: the reason is produced by a `throw` out of the cloud sandbox's
 *  `ensure()` (and by `reportCloudError` for a demotion after the fact),
 *  both of which land in `pool.setError(machine.id, …)` and surface as
 *  `reposState.statuses[machine.id].error`. The other is the machine
 *  row's own `statusDetail`, written by the edge functions into the
 *  Supabase row — the server-side channel, which no code writes a stranded
 *  reason into today but which is the natural place for one to arrive from
 *  if the backend ever learns to detect this itself. Keying on only the
 *  row-derived field is what made this override dead code in production.
 *
 *  The pool error is checked first: it is the live, first-hand observation
 *  this client just made, where the row's detail is whatever the backend
 *  last wrote. */
export function machineStrandedOverride(
  machine: MachineInfo | null,
  poolError?: string | undefined,
): MachineHeaderOverride | null {
  const reason = strandedReason(poolError, machine?.statusDetail);
  if (reason === null) return machineProvisionOverride(machine);
  return { status: "error", message: { text: reason, isError: true }, canUpdate: true };
}

/** Optional upgrade for a usable cloud machine that cannot launch conversations yet. */
export function machineConversationUpdateOverride(
  connection: { status: string; ptydInterface?: number } | undefined,
): MachineHeaderOverride | null {
  const iface = connection?.ptydInterface;
  if (connection?.status !== "open" || typeof iface !== "number" ||
      !Number.isInteger(iface) || iface < 0 || iface >= PTYD_PIPE_INTERFACE) return null;
  return {
    status: "open",
    message: { text: "Update this machine to enable conversation agents. Terminals remain available.", isError: false },
    canUpdate: true,
  };
}

/** The first candidate carrying the stranded prefix, or null. */
function strandedReason(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (candidate && candidate.startsWith(STRANDED_MESSAGE_PREFIX)) return candidate;
  }
  return null;
}

export type RepoVerbId =
  | "new-worktree"
  | "browse-files"
  | "retry"
  | "remove"
  | "destroy";

export interface RepoVerb {
  id: RepoVerbId;
  label: string;
  enabled: boolean;
}

/**
 * The kind-specific trailing verbs for a **repo** row's context menu
 * ("New terminal here" / "New agent" are common to every kind and built
 * separately in ReposSidebar.tsx — they don't vary here; a worktree row
 * gets its own entirely separate menu, also built there, so this is only
 * ever called with a repo repo).
 *
 * Deliberately not a function of the row's connection status: no verb here
 * recovers a connection. A dead daemon is reconnected automatically
 * (`router.retryRepo`, on a "closed" status — packages/router/src/router.ts),
 * and a stale cloud token affects every repo on the machine at once, so
 * neither is a per-row action — see `machineProvisionOverride` for the
 * machine-status-level error path.
 */
export function verbsForRepo(repo: RepoInfo): RepoVerb[] {
  // Worktree creation isn't kind-specific — both a local and a cloud repo
  // check out worktrees the same way — so this verb is common to both
  // branches below, unlike browse-files/retry/remove/destroy.
  const newWorktree: RepoVerb = { id: "new-worktree", label: "New worktree…", enabled: true };

  const browseFiles: RepoVerb = {
    id: "browse-files",
    label: "Browse files",
    enabled: true,
  };

  if (repo.kind === "local") {
    return [
      newWorktree,
      browseFiles,
      { id: "remove", label: "Remove repo…", enabled: true },
    ];
  }

  // Named the same as the local verb, and named at all: a bare "Remove…"
  // does not say what it removes, which is the whole of issue #139's damage.
  // The id still differs because the two route differently — repo:remove
  // against the local daemon, repo:remove-cloud through the cloud machine.
  return [
    newWorktree,
    browseFiles,
    { id: "destroy", label: "Remove repo…", enabled: true },
  ];
}
