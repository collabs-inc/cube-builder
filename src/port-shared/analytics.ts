import type { SshSetupProperties, SshKeyOperationProperties } from "./ssh-telemetry";
export type { SshSetupProperties, SshKeyOperationProperties, SshServerEvent } from "./ssh-telemetry";
import type { InitialProbeOutcome } from "./cubed-attach";
import { AppPlaneError, cloudRecoveryCode, isCloudRecoveryCode, type CloudRecoveryCode } from "./app-plane-outcome";
// The one definition of what this app reports. Every surface — the main
// process, the renderer, the browser tab, the router — imports the event map
// from here, so there is exactly one place to read to know what leaves a
// user's machine.
//
// This file IS the privacy policy, mechanically. `Capture` accepts only a
// declared event name with its declared props, so a file path, repo name or
// prompt cannot be passed without a compile error. Three bucketing functions
// below exist for the same reason: a WSL distro name, a readiness error
// message, and an updater error message are all free text arriving from elsewhere,
// and all are reduced to a closed enum before they can reach an event.
//
// The project key is a constant, not an environment variable, deliberately.
// A `phc_…` project API key is a write-only public token that ships inside
// every binary and bundle anyway, and the env-var design this replaces is
// why the inherited integration reported nothing at all for the life of the
// repo: nobody ever set the variables, and nothing said so.

import type { BillingStatus, MachineInfoStatus, ReadinessStep } from "./types";
import { BILLING_SUSPENDED } from "./types";
import type { CatalogItemType } from "./catalog";
import type { AppFields } from "./app";
import { LOCAL_MACHINE_ID } from "./types";
import type { PlanId } from "./pricing";
import type { AttachOutcome, AttachPhase, AttachReason, AttachResult } from "./cubed-attach";

export const POSTHOG_PROJECT_KEY = "phc_nHe7UmYsqHEm87TDdV4iogAoC86yfvporgDzACzBoMDx";
export const POSTHOG_HOST = "https://us.i.posthog.com";

/** No `staging`: a staging build reports nothing, so it could never appear. */
export type AnalyticsEnv = "production" | "dev";

export type AnalyticsSurface = "desktop" | "web";

/** Stamped on every event by each surface's own capture wrapper. */
export interface AnalyticsBaseProps {
  env: AnalyticsEnv;
  surface: AnalyticsSurface;
  app_version: string;
  /** Desktop only. */
  platform?: string;
  arch?: string;
  electron_version?: string;
}

export type TerminalTargetKind =
  | "auto"
  | "shell"
  | "powershell"
  | "wsl"
  | "claude"
  | "codex"
  | "opencode"
  | "gh-login"
  /** Not a terminal at all — a note, code, image or pdf item. */
  | "none"
  | "other";

export type ReadinessErrorKind = "none" | "gh" | "stranded" | "provision" | "billing_suspended" | "other";

export type UpdateErrorKind = "network" | "signature" | "disk" | "other";

export type ExitKind = "exited" | "killed" | "dead";

export type AppViewKind = "market" | "studio" | "finder" | "tools" | "automations" | "machine" | "settings" | "installed";
export type AppNavigationSource = "sidebar" | "strip" | "switcher" | "mobile_home" | "workspace" | "catalog" | "programmatic" | "settings";
export type AppProduct = Exclude<AppViewKind, "installed"> | "television" | "openmausbot" | "t3-code" | "kandev"
  | "vibe-kanban" | "openwork" | "paperclip" | "openhands" | "superset" | "custom";
export interface AppAnalyticsProps {
  machine: "local" | "cloud";
  source: "git" | "repo";
  serves: "server" | "files";
  app_product: AppProduct;
}
export type AppOperationAction = "install" | "run_repo" | "scaffold" | "start" | "stop" | "restart" | "update" | "uninstall" | "customise";
export type AppOperationErrorKind = "none" | "machine_update" | "unavailable" | "permission" | "invalid_manifest"
  | "unsupported_platform" | "install_failed" | "start_failed" | "update_failed" | "busy" | "not_found" | "cancelled" | "timeout" | "other";
export interface AppOperationProps {
  action: AppOperationAction;
  machine: "local" | "cloud";
  app_product: AppProduct;
  source?: "git" | "repo";
  serves?: "server" | "files";
}

/** Only exact, reviewed public repository identities become product names. */
const APP_PRODUCTS: Readonly<Record<string, AppProduct>> = {
  "telepath-computer/television": "television", "collabs-inc/television": "television",
  "milind-soni/openmausbot": "openmausbot", "collabs-inc/openmausbot": "openmausbot",
  "pingdotgg/t3code": "t3-code", "collabs-inc/t3code": "t3-code",
  "kdlbs/kandev": "kandev", "collabs-inc/cube-kandev": "kandev",
  "bloopai/vibe-kanban": "vibe-kanban", "collabs-inc/cube-vibe-kanban": "vibe-kanban",
  "different-ai/openwork": "openwork", "collabs-inc/cube-openwork": "openwork",
  "paperclipai/paperclip": "paperclip", "collabs-inc/paperclip": "paperclip",
  "openhands/openhands": "openhands", "collabs-inc/openhands": "openhands",
  "superset-sh/superset": "superset", "collabs-inc/superset": "superset",
};

export function appProductForRepository(repository: string): AppProduct {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(repository);
  return match ? APP_PRODUCTS[match[1]!.toLowerCase()] ?? "custom" : "custom";
}

export function appAnalyticsProps(item: { machineId: string; app: AppFields }): AppAnalyticsProps {
  return {
    machine: item.machineId === LOCAL_MACHINE_ID ? "local" : "cloud",
    source: "gitUrl" in item.app.source ? "git" : "repo",
    serves: item.app.serves,
    app_product: "gitUrl" in item.app.source ? appProductForRepository(item.app.source.gitUrl) : "custom",
  };
}

/** Never return any part of an error, manifest, command, URL or path. */
export function appOperationErrorKind(error: unknown): AppOperationErrorKind {
  const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "").toLowerCase();
  if (/machine-needs-update|unknown channel/.test(message)) return "machine_update";
  if (/cancelled|canceled|install was stopped|aborted/.test(message)) return "cancelled";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/hosted_not_entitled|permission|eacces|unauthorized|forbidden/.test(message)) return "permission";
  if (/not installed|not registered|not found/.test(message)) return "not_found";
  if (/being updated|being removed|busy|not finished installing/.test(message)) return "busy";
  if (/platform|only.*linux|only.*macos/.test(message)) return "unsupported_platform";
  if (/cube\.json|manifest/.test(message)) return "invalid_manifest";
  if (/update failed|could not update/.test(message)) return "update_failed";
  if (/install.*failed|could not install/.test(message)) return "install_failed";
  if (/could not start|did not.*ready|exited/.test(message)) return "start_failed";
  if (/unreachable|connect|network|offline|could not reach|could not clone/.test(message)) return "unavailable";
  return "other";
}

/** Public attempt codes shown by the account UI. */
export type AuthAttemptCode =
  | "browser_unavailable"
  | "provider_denied"
  | "invalid_callback"
  | "exchange_failed"
  | "session_unavailable";

/**
 * Safe terminal diagnostic codes. Adapter-only detail stays bounded here;
 * no SDK message or callback value is eligible for capture.
 */
export type AuthAttemptDiagnosticCode =
  | AuthAttemptCode
  | "pkce_code_verifier_not_found"
  | "exchange_timeout"
  | "attempt_canceled"
  | "session_conflict";

export interface AuthAttemptFinishedProperties {
  surface: AnalyticsSurface;
  outcome: "signed-in" | "canceled" | "failed";
  code: AuthAttemptDiagnosticCode | null;
  elapsed_ms: number;
  build: string;
}

export interface CloudRecoveryFinishedProperties {
  surface: AnalyticsSurface;
  outcome: "connected" | "offline" | "action-required" | "failed";
  code: CloudRecoveryCode | null;
  retry_count: number;
  elapsed_ms: number;
  build: string;
  /** Present for adapter failure evidence; absent for coordinator completion. */
  phase?: "attach-probe" | "liveness-probe" | "ensure" | "attach";
}

export interface AnalyticsEventMap {
  ssh_setup_finished: SshSetupProperties;
  ssh_key_operation_finished: SshKeyOperationProperties;
  machine_started: Record<string, never>;
  machine_paused: { cause: "user" | "credit" | "unexpected-stop" | "repair" };
  prepaid_switch_previewed: { cohort: "active" | "trialing" | "grace" | "suspended" };
  feature_interest: { feature: "ssh" };
  // -- activation --
  app_launched: { is_first_launch: boolean };
  signed_in: { method: "oauth" | "password" };
  signed_out: Record<string, never>;
  readiness_changed: {
    from: ReadinessStep;
    to: ReadinessStep;
    ms_in_previous: number;
    error_kind: ReadinessErrorKind;
  };
  repo_added: { kind: "local" | "cloud"; source: "folder" | "clone" | "worktree" };
  item_created: { type: CatalogItemType; target: TerminalTargetKind; machine: "local" | "cloud" };
  /**
   * An app install this client started settled: the item first reached
   * `running` (`ok`) or `failed`. A failed install carries no `serves`,
   * because until the manifest is read the item's `serves` is a placeholder.
   * Never a repository URL, name or path.
   */
  app_installed: { source: "git" | "repo"; machine: "local" | "cloud"; outcome: "ok" | "failed"; serves?: "server" | "files" };
  /** The Apps surface's Open. */
  app_opened: { serves: "server" | "files"; source: "git" | "repo"; machine: "local" | "cloud" };
  /** The Apps surface's Remove, after its confirmation succeeded. */
  app_removed: { serves: "server" | "files"; source: "git" | "repo"; machine: "local" | "cloud" };
  /** An explicit client operation, followed by exactly one observed settlement. */
  app_operation_started: AppOperationProps;
  app_operation_finished: AppOperationProps & { outcome: "ok" | "failed" | "cancelled" | "timeout" | "existing"; error_kind: AppOperationErrorKind; duration_ms: number };
  app_view_opened: { app: AppViewKind; app_product: AppProduct; source: AppNavigationSource; narrow_mode: boolean };
  app_view_resumed: { app: AppViewKind; app_product: AppProduct; destination: "app" | "home"; narrow_mode: boolean };
  app_view_dwell: { app: AppViewKind; app_product: AppProduct; duration_ms: number; narrow_mode: boolean };
  app_home_viewed: { source: "initial" | "home_button"; narrow_mode: true };
  app_sidebar_changed: { open: boolean };
  app_launchers_reordered: { app_count: number; from_index: number; to_index: number };
  app_switcher_opened: { app_count: number };
  app_switcher_closed: { outcome: "committed" | "cancelled"; changed_app: boolean };
  app_view_load_started: AppAnalyticsProps;
  app_view_load_finished: AppAnalyticsProps & { outcome: "loaded" | "failed" | "canceled"; problem: "none" | "unreachable" | "blocked" | "no_address" | "timeout"; duration_ms: number };
  app_view_retry: AppAnalyticsProps;
  app_external_opened: AppAnalyticsProps & { reason: "blocked_signin" };
  market_catalog_load_finished: { machine: "local" | "cloud"; reason: "initial" | "revisit" | "retry"; outcome: "ok" | "failed"; entry_count: number; error_kind: "none" | "http" | "invalid-catalog" | "network" | "timeout" };
  market_catalog_retry_requested: { machine: "local" | "cloud" };
  market_detail_opened: { machine: "local" | "cloud"; app_product: AppProduct; installed: boolean; has_recipe: boolean };
  market_detail_back: { machine: "local" | "cloud" };
  market_searched: { machine: "local" | "cloud"; query_length: number; result_count: number };
  market_link_opened: { machine: "local" | "cloud"; app_product: AppProduct; location: "card" | "detail"; kind: "repository" | "integration" | "creator" | "website" | "installed_source" | "installed_version" | "catalog_version" | "license" | "stars" | "recipe" | "issues" | "releases" };
  market_app_action_requested: { machine: "local" | "cloud"; action: "add_repo" | "create_new" };
  market_repo_validation_started: { machine: "local" | "cloud" };
  market_repo_validation_finished: { machine: "local" | "cloud"; outcome: "ok" | "failed" | "cancelled"; error_kind: "none" | "invalid_url" | "not_public" | "not_found" | "missing_manifest" | "invalid_manifest" | "invalid_response" | "rate_limited" | "http" | "network" | "timeout" | "aborted"; duration_ms: number };
  app_install_decision: { machine: "local" | "cloud"; app_product: AppProduct; origin: "market" | "market-repo" | "add-dialog" | "apps-surface"; decision: "confirm" | "cancel"; has_recipe: boolean };
  app_management_action: { machine: "local" | "cloud"; app_product: AppProduct; origin: "market" | "manage-dialog" | "apps-surface"; action: "update" | "uninstall" | "customise" | "view_log" | "hide_log" | "refresh_log" | "retry_address" | "copy_url" | "open_browser" | "source_link"; stage: "requested" | "confirmed" | "cancelled" };
  app_management_viewed: { machine: "local" | "cloud"; view: "add-dialog" | "manage-dialog" | "apps-surface" | "new-app-dialog" };
  app_new_submitted: { machine: "local" | "cloud"; retry: boolean };
  app_new_cancelled: { machine: "local" | "cloud"; after_partial_creation: boolean };

  // -- engagement --
  /** The user added a screen (the view strip's plus). No props: names are user content. */
  screen_created: Record<string, never>;
  /** The user closed a screen from its tab's context menu. */
  screen_closed: Record<string, never>;
  session_heartbeat: {
    terminals_open: number;
    agents_running: number;
    items_mounted: number;
    columns: number;
    repos_local: number;
    repos_cloud: number;
    narrow_mode: boolean;
    machine_state: MachineInfoStatus;
    apps_installed: number;
    apps_running: number;
  };
  terminal_session_ended: {
    target: TerminalTargetKind;
    duration_ms: number;
    exit_kind: ExitKind;
  };
  /**
   * The user submitted typed input in a terminal pane — a shell command,
   * a prompt to a coding agent, an answer to its question. Fired from
   * xterm's own input path, so only human keystrokes count, never the
   * app's programmatic typing. `enter` is Enter after typing something;
   * `paste` is a multi-line paste that submits by itself. A bare Enter
   * reports nothing. The content is never read: this is "submitted
   * something", not "ran a command".
   */
  terminal_command_sent: {
    target: TerminalTargetKind;
    machine: "local" | "cloud";
    kind: "enter" | "paste";
  };

  // -- reliability --
  // `message`/`stack` are the one place free text is reported rather than
  // bucketed — an enum would make crash events useless. Both call sites
  // (main's process handlers, PostHogProvider's window listeners) MUST pass
  // them through `scrubPaths` below: crash text in this app routinely quotes
  // absolute paths, which carry the username and repo names.
  app_crash: { type: string; message: string; stack?: string };
  renderer_crash: { type: string; message: string; stack?: string };
  auth_attempt_finished: AuthAttemptFinishedProperties;
  cloud_recovery_finished: CloudRecoveryFinishedProperties;
  /**
   * The outcome of replacing a pty session that died — emitted by
   * TerminalItem's recovery path, which is the only place that knows
   * whether the replacement actually came up. Two outcomes, because the
   * respawn either settles or rejects: there is no third, timing-out state
   * for it to be in, and a "timeout" member nothing could ever emit is
   * exactly the dead declaration this taxonomy exists to prevent.
   */
  terminal_recovery: { outcome: "recovered" | "dead"; ms: number };
  machine_provision_failed: { reason_kind: ReadinessErrorKind };
  attach_outcome: {
    machine_id: string;
    txn: string;
    outcome: AttachOutcome["kind"];
    reason?: AttachReason;
    phase?: AttachPhase;
    client_bundle: string;
    client_build: number;
    client_floor: number;
    daemon_bundle?: string | null;
    daemon_build?: number | null;
    daemon_ptyd?: number | null;
    install_target?: string;
    install_attempt?: number;
    install_result?: NonNullable<AttachResult["installResult"]>;
    install_refusal?: string;
    saw_bundle?: string | null;
    saw_build?: number | null;
    wait_ms: number;
    ms: number;
  };
  attach_recovery: {
    machine_id: string;
    txn: string;
    cause: "machine-ahead" | "artifact-404";
    lookup: "ok" | "failed" | "none";
    daemon_build: number | null;
    daemon_bundle: string | null;
    newest_release_build?: number;
    newest_release_bundle?: string;
    conflict?: boolean;
    action: "update" | "pending" | "reload" | "reloaded-still-behind" | "retry";
  };
  machine_update_rolled: {
    machine_id: string;
    txn: string;
    client_version: string;
    backend_version?: string;
    /** Terminal transaction result: `ok | refused:<reason> | timeout | failed`. */
    result: string;
  };
  cloud_request_failed: { kind: ReadinessErrorKind };
  update_available: { version: string };
  update_downloaded: { version: string };
  /**
   * A background check for a new release failed. Split out from
   * `update_download_failed`, which used to carry both and so reported
   * ~1000 "download failures" a fortnight for downloads that never
   * started. Nearly all of these are `network`: a check runs every 60s
   * plus on every power resume, and 3-8% of them lose the race with a wifi
   * roam or a sleep/wake. Those are deliberately invisible in the UI, so
   * this event is the only thing that still sees them — a rise in any
   * OTHER kind is the signal worth alerting on.
   */
  update_check_failed: { error_kind: UpdateErrorKind };
  /** A download the user explicitly asked for failed. Always surfaced. */
  update_download_failed: { error_kind: UpdateErrorKind };
  update_installing: { version: string };

  // -- revenue --
  checkout_started: { plan_id: PlanId; catalog_revision: string };
  billing_portal_opened: Record<string, never>;
  billing_status_changed: { from: BillingStatus | "unknown"; to: BillingStatus; plan_id?: PlanId | null };
}

export type AnalyticsEventName = keyof AnalyticsEventMap;

/** The only way to emit. Every surface supplies its own implementation. */
export type Capture = <K extends AnalyticsEventName>(
  name: K,
  props: AnalyticsEventMap[K],
) => void;

const AUTH_ATTEMPT_CODES = new Set<AuthAttemptDiagnosticCode>([
  "browser_unavailable",
  "provider_denied",
  "invalid_callback",
  "exchange_failed",
  "session_unavailable",
  "pkce_code_verifier_not_found",
  "exchange_timeout",
  "attempt_canceled",
  "session_conflict",
]);

/**
 * Runtime privacy boundary for auth attempt telemetry. Callers may be typed,
 * but this copy-by-allowlist prevents extra values introduced through casts,
 * JavaScript or future plumbing from reaching the analytics client.
 */
export function sanitizeAuthAttemptFinished(input: unknown): AuthAttemptFinishedProperties | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (!Object.hasOwn(value, "surface") || !Object.hasOwn(value, "outcome")
    || !Object.hasOwn(value, "code") || !Object.hasOwn(value, "elapsed_ms")
    || !Object.hasOwn(value, "build")) return null;
  if (value.surface !== "desktop" && value.surface !== "web") return null;
  if (value.outcome !== "signed-in" && value.outcome !== "canceled" && value.outcome !== "failed") return null;
  if (value.code !== null
    && (typeof value.code !== "string" || !AUTH_ATTEMPT_CODES.has(value.code as AuthAttemptDiagnosticCode))) return null;
  if (typeof value.elapsed_ms !== "number" || !Number.isSafeInteger(value.elapsed_ms) || value.elapsed_ms < 0) return null;
  if (typeof value.build !== "string" || value.build.length === 0 || value.build.length > 128
    || !/^[A-Za-z0-9._+-]+$/.test(value.build)) return null;
  return {
    surface: value.surface,
    outcome: value.outcome,
    code: value.code as AuthAttemptDiagnosticCode | null,
    elapsed_ms: value.elapsed_ms,
    build: value.build,
  };
}

/** Captures only after the runtime allowlist accepts every required field. */
export function captureAuthAttemptFinished(capture: Capture, input: unknown): boolean {
  const properties = sanitizeAuthAttemptFinished(input);
  if (!properties) return false;
  capture("auth_attempt_finished", properties);
  return true;
}

export interface AnalyticsEnvInput {
  /** `import.meta.env.DEV` on the surface asking. */
  isDev: boolean;
  /** True only for the staging web deploy. */
  isStagingBuild: boolean;
  /** `CUBE_ANALYTICS=1` — deliberate dev opt-in. */
  override: boolean;
}

/** Null means inert: build no client and emit nothing. */
export function resolveAnalyticsEnv(input: AnalyticsEnvInput): AnalyticsEnv | null {
  if (input.isStagingBuild) return null;
  if (input.isDev) return input.override ? "dev" : null;
  return "production";
}

const KNOWN_TARGETS = new Set<TerminalTargetKind>([
  "auto",
  "shell",
  "powershell",
  "claude",
  "codex",
  "opencode",
  "gh-login",
]);

/**
 * A TerminalTarget reduced to a reportable enum. `wsl:<distro>` carries a
 * user-chosen distro name, so it collapses to `wsl`; anything unrecognised
 * collapses to `other` rather than being echoed — an unknown target string
 * could be an absolute path to a binary.
 */
export function terminalTargetKind(target: string | undefined): TerminalTargetKind {
  if (target === undefined) return "other";
  if (target.startsWith("wsl:")) return "wsl";
  return KNOWN_TARGETS.has(target as TerminalTargetKind)
    ? (target as TerminalTargetKind)
    : "other";
}

/**
 * Readiness/machine error text reduced to an enum. Matched against the
 * exact strings the app itself produces (`GH_AUTH_REASONS` in
 * packages/cloud-account/src/readiness.ts and the legacy stranded-machine
 * message retained below); everything else is `other`. The raw
 * message is never reported — machine errors routinely quote hostnames and
 * repository URLs.
 */
export function readinessErrorKind(error: string | null | undefined): ReadinessErrorKind {
  if (!error) return "none";
  if (error === "gh is not installed on this machine" || error === "not signed in") return "gh";
  if (error.includes("This machine is out of date")) return "stranded";
  if (error.includes("Provisioning failed")) return "provision";
  if (error === BILLING_SUSPENDED) return "billing_suspended";
  return "other";
}

// A path segment stops at whitespace and at the quote/paren an error message
// or stack frame wraps it in. Colons stay in, so a frame's `:line:col` (and a
// Windows drive letter) survives inside a segment.
// The lookbehind keeps the drive-letter form off the `s://` inside a URL
// scheme like `https://`.
const WINDOWS_PATH = /(?:(?<!\w)[A-Za-z]:[\\/]|\\\\)[^\s'")]+/g;
// The lookbehind keeps this off URLs (`//` after a scheme's `:` or another
// `/`), off word-internal slashes like `and/or`, and off the `<path>/x`
// this function itself emits (`>`), which keeps it idempotent.
const POSIX_PATH = /(?<![\w:./>])(?:\/[^/\s'")]+)+/g;

/**
 * Crash text with every absolute path reduced to `<path>/<basename>`.
 *
 * The exception to this file's bucket-to-an-enum rule: crash messages and
 * stacks are only worth reporting as text, so instead of collapsing them we
 * remove the part that identifies a person — the directories, which hold the
 * username and repo names. The basename and a stack frame's line:col are kept
 * because that is what makes the report debuggable (`ENOENT … '<path>/
 * config.json'`, `at f (<path>/index.js:1041:13)`), in the manner of Sentry's
 * scrubbing rather than this file's enums.
 */
export function scrubPaths(text: string): string {
  const redact = (match: string): string => {
    const segments = match.split(/[\\/]+/).filter(Boolean);
    const last = segments[segments.length - 1];
    return last === undefined ? "<path>" : `<path>/${last}`;
  };
  return text.replace(WINDOWS_PATH, redact).replace(POSIX_PATH, redact);
}

/**
 * Electron-updater error message reduced to an enum. The raw message is never
 * reported — updater errors routinely quote cache paths under the user's home
 * directory or update server URLs.
 */
export function updateErrorKind(message: string | null | undefined): UpdateErrorKind {
  if (!message) return "other";
  const m = message.toLowerCase();
  if (m.includes("net::") || m.includes("econn") || m.includes("etimedout") || m.includes("enotfound"))
    return "network";
  if (m.includes("signature") || m.includes("code sign")) return "signature";
  if (m.includes("enospc") || m.includes("no space")) return "disk";
  return "other";
}

/** Server billing outbox contract. Owner UUID is identity; provider/customer IDs stay private. */
export interface BillingPersonProperties {
  billing_status: BillingStatus;
  billing_plan: PlanId | null;
  billing_revision: number;
}
export interface ServerBillingEventMap {
  starter_credit_granted: Record<string, never>;
  credit_topped_up: { kind: "manual" | "auto"; result: "succeeded" };
  prepaid_switch_completed: { trigger: "voluntary" | "deadline" | "lapsed"; cohort: "active" | "trialing" | "grace" | "suspended" };
  billing_status_changed: { from: BillingStatus; to: BillingStatus; plan_id: PlanId | null };
  billing_plan_changed: { from: PlanId | null; to: PlanId | null; status: BillingStatus };
  $set: Record<string, never>;
}
export type ServerBillingEventName = keyof ServerBillingEventMap;


/** Copy by allowlist at the capture boundary, including callers from JS/IPC. */
export function sanitizeCloudRecoveryFinished(input: unknown): CloudRecoveryFinishedProperties | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  for (const key of ["surface", "outcome", "code", "retry_count", "elapsed_ms", "build"]) {
    if (!Object.hasOwn(value, key)) return null;
  }
  if (value.surface !== "desktop" && value.surface !== "web") return null;
  if (value.outcome !== "connected" && value.outcome !== "offline" && value.outcome !== "action-required" && value.outcome !== "failed") return null;
  if (value.code !== null && !isCloudRecoveryCode(value.code)) return null;
  for (const count of [value.retry_count, value.elapsed_ms]) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  }
  if (typeof value.build !== "string" || value.build.length === 0 || value.build.length > 128 || !/^[A-Za-z0-9._+-]+$/.test(value.build)) return null;
  if (value.phase !== undefined && value.phase !== "attach-probe" && value.phase !== "liveness-probe" && value.phase !== "ensure" && value.phase !== "attach") return null;
  return { surface: value.surface, outcome: value.outcome, code: value.code as CloudRecoveryCode | null,
    retry_count: value.retry_count as number, elapsed_ms: value.elapsed_ms as number, build: value.build,
    ...(value.phase !== undefined ? { phase: value.phase } : {}) };
}
export function captureCloudRecoveryFinished(capture: Capture, input: unknown): boolean {
  const properties = sanitizeCloudRecoveryFinished(input);
  if (!properties) return false;
  capture("cloud_recovery_finished", properties);
  return true;
}


/** One initial-probe failure per negotiation, separately from coordinator completion. */
export function createCloudRecoveryProbeReporter(capture: Capture, context: {
  surface: AnalyticsSurface;
  build: string;
  isCurrent(): boolean;
  now?(): number;
}): (outcome: InitialProbeOutcome) => void {
  const now = context.now ?? Date.now;
  const started = now();
  let reported = false;
  return outcome => {
    if (reported || !context.isCurrent()) return;
    reported = true;
    if (outcome.outcome !== 'failure') return;
    try {
      captureCloudRecoveryFinished(capture, { surface: context.surface, build: context.build,
        phase: 'attach-probe', outcome: outcome.failure.certainty === 'rejected' && !outcome.failure.retryable ? 'action-required' : 'failed',
        code: cloudRecoveryCode(new AppPlaneError(outcome.failure)), retry_count: 0, elapsed_ms: Math.max(0, Math.round(now() - started)) });
    } catch { /* Diagnostic sinks cannot interrupt attach. */ }
  };
}
