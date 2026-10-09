/**
 * Shared machine-provisioning copy — the exact strings shown wherever the
 * app reports on a cloud machine's provisioning phase or asks the user to
 * connect GitHub on it. Two callers share this module: ReposSidebar's
 * machine-header override (group-entries.ts's machineProvisionOverride)
 * and GateModal's provisioning and reconnect bodies. Extracted so neither
 * copy drifts from the other — these strings are byte-exact acceptance
 * criteria (U+2026 ellipses, not "...").
 */



import type { BillingState, BillingStatus } from "@port/shared/types";

export type MachineProvisionPhase = "creating" | "bootstrapping" | "waking";

export const PROVISION_PHASE_COPY: Record<MachineProvisionPhase, string> = {
  creating: "Creating your machine…",
  bootstrapping: "Installing tools…",
  waking: "Connecting to your machine…",
};

/** The provisioning phases in the order the machine walks them. The gate
 * renders all three in its boot log, so it needs the sequence, not just the
 * current one — everything before the live phase is behind you. */
export const PROVISION_PHASE_ORDER: readonly MachineProvisionPhase[] = [
  "creating",
  "bootstrapping",
  "waking",
];

/** Legacy GitHub repair copy, retained for the Task 11 gate migration. */
/** Re-exported from the Readiness contract (see @port/shared/types): the
 * provisioning detail shown while the machine is running but the first gh
 * check hasn't answered. Listed here so this module stays the one place
 * every gate/sidebar string can be read together. */
export { GH_CONNECTING_DETAIL } from "@port/shared/types";

export const GH_RECONNECT_HEADING = "Reconnect GitHub";
export const GH_RECONNECT_DETAIL =
  "Your machine lost access to GitHub. Reconnect to restore clone and push — it only takes a moment.";
export const GH_RECONNECT_LABEL = "Reconnect GitHub";

/** The welcome splash — the first thing a brand-new user sees, before the
 * three-step rail. Dismissed once by its Enter button and never shown
 * again (GateModal persists the dismissal per profile). */
export const WELCOME_HEADING = "Welcome to Cube";
export const WELCOME_DETAIL = "A cloud computer for running agents.";
export const WELCOME_ENTER_LABEL = "Enter Cube";

/** The sign-in step. */
export const SIGN_IN_HEADING = "First, let’s sign you in";
export const SIGN_IN_DETAIL =
  "Cube syncs your repos through your GitHub account. You only do this once.";
export const SIGN_IN_LABEL = "Continue with GitHub";

/** The provisioning step. The log lines are what the boot terminal prints
 * for each phase: the command as it starts, the results once it is done —
 * a shape for the wait, in the vocabulary of the thing being waited on. */
export const PROVISION_HEADING = "Booting your Cube";
export const PROVISION_DETAIL =
  "First boot takes a couple of minutes. You can leave — we’ll pick up where you left off.";
export const PROVISION_TERMINAL_TITLE = "cube.computer — first boot";

/** The provisioning step when nothing is being built: a returning account
 * whose machine is waking or whose GitHub check hasn't answered, or the
 * beat after sign-in before the machine row (or billing) has loaded. The
 * boot terminal would be a lie here — nothing is being provisioned. */
export const CONNECTING_HEADING = "Connecting to your Cube";
export const CONNECTING_DETAIL =
  "Your machine is already set up. Connecting and checking GitHub takes a moment.";
export const CONNECTING_PENDING_HEADING = "Just a moment";
export const CONNECTING_PENDING_STATUS = "Checking your account…";
export const PROVISION_LOG_COMMAND: Record<MachineProvisionPhase, string> = {
  creating: "cube provision --region auto",
  bootstrapping: "cube install claude codex opencode gh",
  waking: "cube connect",
};
export const PROVISION_LOG_DONE: Record<MachineProvisionPhase, readonly string[]> = {
  creating: ["machine created"],
  bootstrapping: [
    "claude · installed",
    "codex · installed",
    "opencode · installed",
    "gh · seeded from your sign-in",
  ],
  waking: ["your Cube is ready"],
};

/** The stranded-machine dialog (GateModal's MachineUpdateStep): the machine
 * is running but cannot run this app's daemon, so no request to it can
 * succeed — including the gh check — and the only way forward is an image
 * roll. Outranks GitHub reconnect, which would otherwise hide this remedy behind
 * a Reconnect button that can never help. */
export const MACHINE_UPDATE_HEADING = "Update your machine";
export const MACHINE_UPDATE_DETAIL =
  "Your machine's system software is older than this app requires. " +
  "Updating installs the latest agent CLIs and system software, then restarts it — " +
  "files, repos and logins are kept; terminals are cleared and agent sessions stop.";
export const MACHINE_UPDATE_LABEL = "Update and restart";

/** Step labels for the gate's progress rail. Deliberately not derived from
 * ReadinessStep's own names: those are state-machine identifiers, these are
 * read by a person who has never heard the word "readiness". */
export const GATE_STEP_LABELS = ["Sign in", "Configure", "Boot", "Agents", "First repo"] as const;

/** The add-repo step (GateModal's AddRepoStep): the one onboarding step
 * that is not a readiness state. The machine is ready, but a cube with no
 * repo on it is an empty desk, so the walk ends by cloning one — or by an
 * explicit skip, for the user who has none to add yet. */
export const ADD_REPO_HEADING = "Add your first repo";
export const ADD_REPO_DETAIL = "Start a new repo on your Cube, or bring one from GitHub. Add more any time.";
export const ADD_REPO_SEARCH_PLACEHOLDER = "Search your repositories…";
export const ADD_REPO_LABEL = "Add repo";
export const ADD_REPO_PENDING_LABEL = "Cloning…";
export const ADD_REPO_SKIP_LABEL = "Skip for now";

/** The onboarding panel's exit, shown on every signed-in step: a change of
 * mind about the account should not need Settings, which the gate hides.
 * Signing out only ends the session — the account is untouched. */
export const GATE_SIGN_OUT_LABEL = "Log out";

// ── Prepaid onboarding copy ──

export function startHeading(balance: string): string {
  return `You have ${balance} of credit.`;
}

export const START_LABEL = "Start my Cube →";
export const START_ADD_CREDIT_LABEL = "Add credit";
export const START_MINIMUM_NOTE = "Add at least $1.00 of credit to start your machine.";

export const BOOT_ATTENTION_HEADING = "Your Cube needs attention";
export const BOOT_ATTENTION_DETAIL = "It did not start within five minutes. Try again, or add credit if the balance ran out.";
export const BOOT_RETRY_LABEL = "Try again";

export const AGENTS_HEADING = "Bring your agents with you";
export const AGENTS_DETAIL = "Copy your agent sign-ins from this Mac to your Cube, so they’re ready to work.";
export const AGENTS_YES_LABEL = "Copy sign-ins →";
export const AGENTS_SKIP_LABEL = "Skip for now";

/** Shown under a provisioning error. Main's reconciler is already retrying
 * on a backoff — this says so, in place of the Retry button that used to
 * make the user do it. */
export const PROVISION_RETRYING_COPY = "Retrying automatically…";

export function isProvisionPhase(status: string | undefined): status is MachineProvisionPhase {
  return status === "creating" || status === "bootstrapping" || status === "waking";
}

// ── Billing copy ──
//
// Shared across every surface that paints BillingState: GateModal's
// local and billing-suspension gate beats, BillingBanner's grace pill
// (same chrome-slot pattern as UpdatePill), and SettingsModal's Cloud plan
// line. Extracted for the same "must not drift" reason as the provisioning
// copy above.
// Plan names, prices, hardware and trial offers come from the live catalog.
export const BILLING_SUBSCRIBE_LABEL = "Subscribe";
/** The suspension notice, split across the dialog's heading and body so the
 * two don't say "your subscription is paused" one after the other. Joined
 * with " — " they read as the single sentence this used to be. */
export const BILLING_SUSPENDED_HEADING = "Your subscription is paused";
export const BILLING_SUSPENDED_DETAIL = "Your machine and data are safe.";
export const BILLING_MANAGE_LABEL = "Manage billing";
export const BILLING_FIX_PAYMENT_LABEL = "Fix payment";

/** "soon" is the fallback for a null/unparseable date — every caller of
 * this treats it as "we don't have a firm date yet", not an error state.
 * Formats in UTC deliberately, not the viewer's local zone: these
 * timestamps are all midnight-UTC boundaries computed server-side (trial/
 * period/grace end), so converting to a negative-offset local zone would
 * silently roll the displayed date back a day (2026-08-20T00:00:00Z reads
 * as "Aug 19" in America/Los_Angeles) — UTC keeps it matching the date the
 * billing row actually carries. */
export function formatBillingDate(iso: string | null): string {
  if (!iso) return "soon";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** BillingBanner's grace-period copy — the action label ("Fix payment") is
 * a separate button, not part of this string; see BillingBanner.tsx. */
export function billingGraceCopy(graceEndsAt: string | null): string {
  return `Payment issue — service continues until ${formatBillingDate(graceEndsAt)}.`;
}

/** SettingsModal's Cloud pane plan line. Mirrors the brief's exact mapping:
 * trialing -> "Trial ends <date>", active -> "Renews <date>", grace ->
 * "Payment issue", suspended -> "Paused", none/unknown -> "No subscription". */
export function billingPlanLineLabel(billing: BillingState | null): string {
  const status: BillingStatus = billing?.status ?? "none";
  if (status === "trialing") return `Trial ends ${formatBillingDate(billing?.trialEndsAt ?? null)}`;
  if (status === "active") return `Renews ${formatBillingDate(billing?.currentPeriodEnd ?? null)}`;
  if (status === "grace") return "Payment issue";
  if (status === "suspended") return "Paused";
  return "No subscription";
}

/** Billing has not been read yet this session. */
export const CHECKING_PLAN_HEADING = "Checking your plan…";
export const CHECKING_PLAN_STALE = "Cube couldn’t reach billing. Your plan will load when it can.";
/** Suspended: the banner, not a gate. */
export const BILLING_SUSPENDED_BANNER = "Your Cube subscription is suspended. Your cloud machine is paused until billing is fixed; everything on this Mac keeps working.";
export const BILLING_FIX_LABEL = "Fix billing";
/** Footer entries. */
export const GET_A_CUBE_LABEL = "Get a Cube";
export const SETTING_UP_CUBE_LABEL = "Setting up your Cube…";
