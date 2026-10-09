// packages/router/src/remote-target.ts
//
// Resolves a terminal target for a REMOTE machine (a cloud sprite): which
// command/args to hand cubed's term:open for an agent harness or a shell.
// Deliberately pure — it answers "what does the sprite run", never "what can
// THIS machine run", so it has no process/os/child_process dependency and is
// safe for both the Electron main process and a browser build. The
// local-machine resolver stays in src/main/terminal-target.ts.
import { AGENT_HARNESS_IDS, type AgentHarnessId, type TerminalTarget } from "@port/shared/types";
import { catalogAgent } from "@port/shared/agent-catalog";

interface AgentTarget {
  command: string;
  args: string[];
  displayName: string;
  /**
   * Builds the flags that pin a stable conversation id, when the agent
   * supports one. Without this, Claude Code's daemon may serve a recycled
   * pre-warmed worker whose transcript is filed under that worker's cwd —
   * leaving the session unresumable from the directory it was launched in.
   */
  sessionIdArgs?: (sessionId: string) => string[];
  /**
   * Builds the flags that RESUME an existing conversation. Distinct from
   * `sessionIdArgs`, which CREATES one with a given id: `claude
   * --session-id <existing-uuid>` fails with "Session ID … is already in
   * use". A target without this cannot be resumed, and asking for a
   * resume falls through to a fresh spawn.
   */
  resumeArgs?: (sessionId: string) => string[];
  /**
   * The vendor's own install command, offered in Settings when the local
   * machine can't run the harness (src/main/terminal-target.ts's
   * `agentTargetOptions`). These are the same commands the cubed image
   * installs with (docker/cubed/Dockerfile), kept alongside the launch
   * definition so the two can't drift.
   *
   * Never executed here or by this package: Settings opens a terminal and
   * types it, so the user reads the command and runs it themselves.
   */
  installCommand?: string;
  /**
   * The harness's Agent Client Protocol front door: what cubed spawns on a
   * PIPE session for an `agent` item. Absent means the harness has no ACP
   * mode and always launches as a `term` item. `installCommand` is the
   * ADAPTER's install line where the adapter is a separate package.
   */
  acp?: { command: string; args: string[]; installCommand?: string };
}

/**
 * CLI agents a terminal can launch directly instead of a shell. Keyed by
 * AGENT_HARNESS_IDS (@port/shared/types) — the shared source of truth
 * this launch authority derives its keys from; a missing or extra key here
 * is a compile error.
 */
export const AGENT_TARGETS: Record<AgentHarnessId, AgentTarget> = {
  claude: {
    command: "claude",
    args: ["--dangerously-skip-permissions"],
    displayName: "Claude Code",
    sessionIdArgs: (sessionId) => ["--session-id", sessionId],
    resumeArgs: (sessionId) => ["--resume", sessionId],
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    acp: { command: "claude-agent-acp", args: [], installCommand: "npm install -g @agentclientprotocol/claude-agent-acp" },
  },
  codex: {
    command: "codex",
    args: ["--dangerously-bypass-approvals-and-sandbox"],
    displayName: "Codex",
    // A subcommand, not a flag: `codex … resume <id>`. Codex has no
    // --session-id equivalent, so fresh sessions still learn their id by
    // daemon-side discovery (src/main/cubed/codex-locks.ts).
    resumeArgs: (sessionId) => ["resume", sessionId],
    installCommand: "npm install -g @openai/codex",
    acp: { command: "codex-acp", args: [], installCommand: "npm install -g @agentclientprotocol/codex-acp" },
  },
  opencode: {
    command: "opencode",
    args: [],
    displayName: "opencode",
    installCommand: "npm install -g opencode-ai",
    acp: { command: "opencode", args: ["acp"] },
  },
};

export function isAgentHarnessId(value: string): value is AgentHarnessId {
  return (AGENT_HARNESS_IDS as readonly string[]).includes(value);
}

/** Every sprite is Linux, so a remote plain shell is always a bash login shell. */
export const REMOTE_SHELL: AgentTarget = {
  command: "bash",
  args: ["-l"],
  displayName: "bash",
};

export interface ResolvedTerminalTarget {
  target: TerminalTarget;
  command: string;
  args: string[];
  displayName: string;
  cwd: string;
  cwdHostPath: string;
  cwdGuestPath?: string;
  agentSessionId?: string;
  resumed: boolean;
}

/**
 * Terminal-target resolution for a session on a REMOTE (sprite) repo.
 * Deliberately does not call `resolveTerminalTarget`: that function's
 * non-harness branch answers "what can THIS machine run" — `commandExists`,
 * WSL distro discovery, `process.platform` — none of which describe the
 * sprite the session actually runs on. A harness id still maps straight to
 * `AGENT_TARGETS`, with the same agentSessionId mint/reuse rule; anything
 * else (shell, auto, or an unrecognized target) becomes a bash login shell,
 * because every sprite is Linux. `cwdHostPath` here is the daemon-side
 * absolute cwd the router already joined from the repo's repoRoot — the
 * field is reused as-is rather than renamed, since it means the same thing
 * to the caller (session meta) it always has: where this session's cwd
 * lives on the machine actually running it.
 */
export function resolveRemoteTarget(
  preferredTarget: TerminalTarget,
  cwdHostPath: string,
  agentSessionId?: string,
  resume?: boolean,
): ResolvedTerminalTarget {
  const entry = catalogAgent(preferredTarget);
  if (entry) {
    const [command, ...args] = entry.installation.startCommand.split(/\s+/);
    return { target: preferredTarget, command: command!, args, displayName: entry.name, cwd: cwdHostPath, cwdHostPath, resumed: false };
  }
  // "Automatic" means the first installed harness locally
  // (src/main/terminal-target.ts's `resolveAutoTarget`); remotely the same
  // rule is evaluated statically. Nothing on this side can run `command -v`
  // on the sprite, but the cubed image installs all three harnesses at
  // build time (docker/cubed/Dockerfile), so "first installed in
  // AGENT_HARNESS_IDS order" is knowable here and is AGENT_HARNESS_IDS[0].
  // That keeps Cmd+N doing the same thing on a cloud repo as on a local
  // one. A sprite that somehow lacks it surfaces the spawn error, exactly
  // as an explicitly chosen harness would.
  const preferred = preferredTarget === "auto" ? AGENT_HARNESS_IDS[0] : preferredTarget;
  const harness = isAgentHarnessId(preferred) ? preferred : null;
  const agent = harness ? AGENT_TARGETS[harness] : REMOTE_SHELL;
  const target: TerminalTarget = harness ?? "shell";

  // Provenance decides the flag: an id we minted is created, an id we
  // recovered is resumed. `resumed` is what actually happened, not what
  // was asked for — the caller renders a "resumed" marker off this, so it
  // must never claim a resume that did not occur.
  const idArgs = resume ? agent.resumeArgs : agent.sessionIdArgs;
  if (agentSessionId && idArgs) {
    return {
      target,
      command: agent.command,
      args: [...agent.args, ...idArgs(agentSessionId)],
      displayName: agent.displayName,
      cwd: cwdHostPath,
      cwdHostPath,
      agentSessionId,
      resumed: resume === true,
    };
  }
  return {
    target,
    command: agent.command,
    args: agent.args,
    displayName: agent.displayName,
    cwd: cwdHostPath,
    cwdHostPath,
    resumed: false,
  };
}

export interface AcpLaunch {
  harness: AgentHarnessId;
  command: string;
  args: string[];
  displayName: string;
  cwd: string;
  cwdHostPath: string;
  installCommand?: string;
}

/**
 * The ACP launch for a harness, on ANY machine — pure, like
 * `resolveRemoteTarget`: it never asks what this host can run. `null`
 * means the harness has no ACP front door and the caller must fall back
 * to a `term` item.
 */
export function resolveAcpLaunch(harness: AgentHarnessId, cwdHostPath: string): AcpLaunch | null {
  const agent = AGENT_TARGETS[harness];
  if (!agent.acp) return null;
  const launch: AcpLaunch = {
    harness, command: agent.acp.command, args: [...agent.acp.args], displayName: agent.displayName,
    cwd: cwdHostPath, cwdHostPath,
  };
  const install = agent.acp.installCommand ?? agent.installCommand;
  if (install !== undefined) launch.installCommand = install;
  return launch;
}
