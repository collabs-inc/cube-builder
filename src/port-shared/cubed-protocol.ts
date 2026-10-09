// The interface number a cubed bundle speaks, for the local
// version-at-attach check (docs/superpowers/specs/
// 2026-08-16-local-cubed-version-attach-design.md).
//
// The rule it serves: two bundles at the same interface are wire-compatible
// by definition, so their code does not matter; a code change that DOES
// matter is, by definition, an interface change and must bump this. There
// is deliberately no other ordering — not the bundle hash (identity, not
// order), not the app version (0.9.0 for every dev build), not a timestamp
// (skewed clocks, rebuilt commits). This number is the one fact that is
// ordered, and it is ordered on purpose.
//
// BUMP THIS when a cubed WS verb is added, removed, or changes shape.
// cubed-interface.test.ts hashes the verb table and fails if it changed
// without this changing, so a forgotten bump is a red test, not silent
// skew between a new client and an old daemon.
// 9 adds channel:check / channel:hold — the server-published-update pull
// loop's manual-trigger and hold-toggle verbs, plus a lastChannelCheck
// field on daemon:ping (a payload shape change the hash below cannot see,
// same as interface 5/6's precedent, which is why this comment states it).
// 10 adds term:stash-paste — a pasted clipboard image stashed onto the
// daemon's machine so a path can be typed at the pty (issue #13).
// 11 adds no verb — term:stash-paste changed SHAPE. It takes an optional
// `filename`, and with one it accepts any mime and preserves the name
// (a file dragged from the user's desktop into a terminal whose pty runs
// on another machine). A daemon at 10 answers such a request by
// rejecting the mime, so the two are not wire-compatible.
// 12 is two breaks under one number, per interface 8's precedent — neither
// ever shipped separately (the channel's newest published bundle was 11
// when they merged):
//   - the port-forwarding surface: forward:hello / forward:open /
//     forward:list, plus the forward:close and forward:end events the hash
//     cannot see. A daemon at 11 answers forward:hello with "Unknown
//     channel", which is the client's own signal to stay dark. Still
//     within 12 (never shipped): forward:list and forward:listeners carry
//     { ports, urls }, where ports is the CLAIMED ∩ listening set — only
//     ports a live terminal printed a localhost URL for — per the
//     2026-08-31 terminal-claimed-port-forwarding design doc.
//   - fs:importfile — a dropped file imported into a repo folder, with
//     contentBase64 (capped) or a daemon-local sourcePath (uncapped),
//     never overwriting (collisions land as "name 2.ext"). A daemon at 11
//     answers it with "Unknown channel"; the router refuses ahead of time
//     on the interface instead (tree drops surface "machine needs an
//     update").
// 13 adds the ACP conversation surface: `agent:open` (the ring replay a
// client rebuilds a conversation from), `agent:send` (one JSON-RPC message
// onto the adapter's stdin), `agent:kill`, and `agent:resume` — registered
// under this number but implemented in a later task, deliberately, so the
// verb table is final in one step rather than moving twice. It also carries
// two EVENTS the verb-table hash cannot see, `agent:frame` and `agent:exit`,
// and a `catalog:add-item` SHAPE change: `type: "agent"` is now accepted and
// requires `harness` plus a `launch` (AgentLaunch — the adapter's command,
// args and cwd) that no earlier daemon knows what to do with. A daemon at 12
// answers every one of these with "Unknown channel" or "unknown item type
// agent"; the router refuses ahead of time on the interface instead, so the
// user sees "machine needs an update" rather than a raw verb error.
// 14 adds automatic HTML artifact items for ordinary checkouts, artifact:ticket,
// and GET /artifact for sandboxed previews on desktop and web.
// 15 adds catalog:create-repo, github:owners, github:publish-repo, and
// the pending publication target on catalog repo rows for retry.
// 16 adds fs:file-ticket and streaming GET /file for previews and downloads.
// 17 adds managed project previews and preview:status/start/restart/stop.
// 18 adds machine-owned agent authentication status/start/logout operations.
// 19 adds guarded idle-agent restart after authentication.
// 20 adds machine:export-ticket and machine:storage. The ticket is minted
// only on the authenticated socket and redeems GET /machine-export; neither
// request accepts a client path because the daemon fixes the root.
// 21 extends fs:file-ticket downloads to directories, streamed as tar.gz archives.
// 22 adds catalog:detach-repo and durable detachment state; catalog:update-item
// refuses new session bindings without Cube custody metadata.
// 23 adds immutable export jobs and repeatable authenticated byte-range downloads.
// 24 removes managed project previews (preview:status/start/restart/stop) and
// adds site artifacts: catalog artifact items carrying port, siteAddress,
// siteClaimSessionId and stopped, written by cubed. forward:listeners and
// forward:list no longer carry urls.
// 25 adds catalog:reorder, a full-membership permutation of one scope (a
// checkout's items, a repo's worktrees, or a machine's top-level repos).
// 26 adds the inventory verbs agent:tools, agent:automations and
// agent:list-targets: the CLIs and MCP servers found on the machine, the
// automations it has enabled, and the agent targets available to launch.
// 27 adds catalog:reset-workspace for safe local cleanup before account deletion.
// 28 adds personas: an `agent` item may carry role "persona", and
// cubed serves that session an MCP tool server over POST /mcp.
// 29 adds persona context folders: persona:repos, persona:set-repos, persona:events,
// persona:events-changed, repository personaId stamps and client personaId on
// catalog:add-item.
// 30 adds the operation registry: ops:invoke runs one of the registry's verbs
// as the user, persona events carry actor/verb/target/outcome/pointer, and the
// persona's MCP tools are generated from the same registry.
// 31 adds ssh:status, ssh:authorize, ssh:revoke and ssh:revoke-others, so a
// client can read the machine's SSH readiness and manage the per-device keys
// in its authorized_keys.
// 32 adds the daemon-written workingDir item field and the repo-items
// reorder scope (a repo's items across its primary checkout and worktrees).
// 33 adds leased machine:status telemetry snapshots.
// 34 adds machine:prepare-stop, the prepaid stop gate the guest calls
// before a manual stop.
// 35 adds agent:auth-import for copying harness credentials during onboarding.
// 36 adds the app:* verbs (apps: install, run, gate, hostname sign-in).
// 37 adds app:info for installed app version, source and disk usage details.
// 38 adds admitted daemon:receiving events so slow single-frame uploads stay live.
export const CUBED_INTERFACE_VERSION = 38;
export const MACHINE_STATUS_INTERFACE_VERSION = 33;
export const PERSONA_INTERFACE_VERSION = 29;

/** What `ops:invoke` answers; a failed operation rejects instead. */
export type OpInvokeResult =
  | { status: "done"; result: unknown }
  | { status: "unknown"; result: unknown; message?: string | null }
  | { status: "pending" };

export interface PersonaRepoEntry { path: string; repoId: string | null }
export interface PersonaReposResult {
  /** Git siblings of registered checkouts, including those absent from the catalog. */
  checkouts?: { path: string; repoId: string; name: string }[];
  entries: PersonaRepoEntry[];
  cloning: string[];
  homeDir: string;
  contextDir: string;
}

/** Who performed an action. `worker` is produced only by observation. */
export type Actor =
  | { kind: "user" }
  | { kind: "persona"; itemId: string }
  | { kind: "worker"; itemId: string; personaId: string };

/**
 * The eight registry operations, in the registry's order — see
 * docs/superpowers/specs/2026-09-20-action-visibility-parity-design.md.
 * cubed's registry test holds its operations to this list.
 */
export const OP_VERBS = [
  "add_repo", "clone_repo", "create_worktree", "remove_worktree", "remove_repo",
  "spawn_agent", "send_to_agent", "stop_agent",
] as const;
export type OpVerb = (typeof OP_VERBS)[number];

/** Recorded from observation rather than invocation; `operationId` is always null. */
export type ObservedVerb = "commit" | "push" | "merge" | "edit_files";

/**
 * Event producers that are not operations. `legacy` is what an event file
 * written before these fields normalizes to.
 */
export type LegacyVerb =
  | "publish_repo" | "rename_item" | "close_item" | "change_known_repos" | "legacy";

export type EventVerb = OpVerb | ObservedVerb | LegacyVerb;

/**
 * What an event is about. Every member carries the label captured before the
 * operation ran, so a removed repository or a stopped item still reads
 * correctly later.
 */
export type OpTarget =
  | { kind: "repo"; repoId: string; label: string }
  | { kind: "branch"; repoId: string; label: string; branch: string }
  | { kind: "commit"; repoId: string; label: string; sha: string }
  | { kind: "item"; itemId: string; label: string }
  | { kind: "pr"; repoId: string; label: string; prNumber: number }
  | { kind: "paths"; repoId: string; label: string; paths: string[] };

/** What a line opens when clicked. A destructive verb records null. */
export type Pointer =
  | { kind: "item"; itemId: string }
  | { kind: "repo"; repoId: string }
  | { kind: "url"; url: string };

/** The raw record of an action, with no display decision baked in. */
export interface PersonaEventFields {
  actor: Actor;
  verb: EventVerb;
  /** Set for registry events; null for observed and legacy ones. */
  operationId: string | null;
  target: OpTarget | null;
  outcome: "ok" | "failed" | "unknown";
  pointer: Pointer | null;
}

export interface PersonaEvent extends PersonaEventFields {
  id: string;
  at: string;
  text: string;
  cursor: number;
  deliveredIn: string | null;
}

/**
 * How a wake-up prompt begins, and so also the block of reports another
 * prompt carries: the renderer recognizes a replayed carried block by it.
 */
export const WAKE_UP_PREFIX = "Worker reports.";
export const LOCAL_REPO_DETACH_INTERFACE_VERSION = 22;
export const FILE_DOWNLOAD_INTERFACE_VERSION = 16;
export const FOLDER_DOWNLOAD_INTERFACE_VERSION = 21;
export const MACHINE_EXPORT_INTERFACE_VERSION = 20;
export const MACHINE_EXPORT_JOBS_INTERFACE_VERSION = 23;

// The one cap for byte-carrying transfers to a daemon — term:stash-paste
// and fs:importfile both enforce it, on the daemon and again client-side
// so an oversized file is refused before any bytes are encoded. Local
// fs:importfile sends carry a sourcePath instead of bytes and are
// deliberately uncapped: nothing crosses the wire.
//
// A transfer is ONE JSON message on the machine's shared socket, so this
// cap is bounded by more than bandwidth: the base64 form must fit in one
// V8 string (2^29 - 24 chars, so ~384MB raw at most; the test pins the
// margin), both ends briefly hold several copies, and terminal traffic
// on that socket waits behind the frame. 250MB was chosen knowing those
// costs; going higher means chunked transfers, not a bigger number.
export const MAX_TRANSFER_BYTES = 250 * 1024 * 1024;
/** The cap as user-facing copy, derived so messages cannot drift from it. */
export const MAX_TRANSFER_LABEL = `${MAX_TRANSFER_BYTES / (1024 * 1024)} MB`;

// cubed's WebSocketServer maxPayload — set explicitly so an oversize frame
// is a bounded refusal we chose, not `ws`'s inherited 100MiB default whose
// overflow closes the socket (1009) and takes every attached terminal
// with it. Sized with headroom over MAX_TRANSFER_BYTES's base64 form
// (4/3 inflation) plus the JSON envelope; the test beside this pins the
// relation so neither constant moves without the other.
export const CUBED_WS_MAX_PAYLOAD_BYTES = 360 * 1024 * 1024;

// fs:importfile's two payload forms: bytes for a cloud repo (and every
// browser drop), a daemon-local absolute path for a local desktop drop.
// Exactly one, never both — the daemon rejects an ambiguous request.
export type ImportPayload = { contentBase64: string } | { sourcePath: string };

// Repeated requests reconcile the same durable daemon-owned detachment.
export type DetachRequest = { id: string; operationId: string };
export type DetachResult = {
  operationId: string;
  state: "pending" | "incomplete" | "complete";
  code?: "session_stop_failed" | "session_custody_pending" | "persistence_failed" | "creation_pending" | "registration_changed";
};
/** One release cycle: a socket that never asks for admission is admitted on its first ordinary verb. Flip to false in the release that closes the bridge (spec Rollout). */
export const ADMISSION_BRIDGE = true;

export interface DaemonPingArgs { expect?: string; txn?: string }

export interface DaemonPingReply {
  pid: number;
  uptime: number;
  protocolVersion: 1;
  version: string;
  bundleId: string | null;
  cubedInterface: number | null;
  build: number | null;
  ptydInterface: number | null;
  probation: boolean;
  installing: boolean;
  /** Older daemons may omit the environment. */
  env?: "production" | "staging" | "dev" | undefined;
  admitted: boolean;
  release: boolean;
}

export const NEGOTIATION_VERBS: ReadonlySet<string> = new Set(["daemon:ping", "cubed:install"]);
