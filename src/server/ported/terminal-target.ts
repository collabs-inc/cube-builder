import { execFileSync } from "node:child_process";
import { AGENT_CATALOG, catalogAgent } from "@port/shared/agent-catalog";
import * as os from "node:os";
import { displayBasename, hostPathToGuestPath, parseWslUncPath } from "@port/shared/path-utils";
import { AGENT_HARNESS_IDS, type AgentHarnessId } from "@port/shared/types";
import { assertHarnessInstalled as assertHarnessInstalledWith } from "./harness";
import {
  AGENT_TARGETS,
  isAgentHarnessId,
  resolveRemoteTarget,
  type ResolvedTerminalTarget,
} from "./remote-target";
import { type TerminalTarget } from "@port/shared/types";

export { resolveRemoteTarget, type ResolvedTerminalTarget };

export interface TerminalTargetOption {
  id: TerminalTarget;
  label: string;
  isDefault?: boolean;
  /**
   * For an agent harness: whether THIS machine can run it right now.
   * Absent for shell targets, which are always available.
   *
   * Reported rather than enforced. The `terminalTarget` pref is global
   * while installation is per-machine, and pty.ts applies the same pref to
   * cloud terminals — where the cubed image has all three harnesses. So
   * a harness missing here may be perfectly usable on a cloud repo, and
   * the picker must not refuse to select it. Picking one that is missing
   * wherever it ends up running still fails loudly via
   * `assertHarnessInstalled`.
   */
  installed?: boolean;
  /**
   * The vendor's install command, present only for an agent harness this
   * machine can't currently run. Settings shows it as an "Install" action
   * that opens a terminal and types the command — it is never run for the
   * user behind their back.
   */
  installCommand?: string;
}

function withGuestPath(
  base: Omit<ResolvedTerminalTarget, "cwdGuestPath">,
  cwdGuestPath: string | null,
): ResolvedTerminalTarget {
  return cwdGuestPath
    ? { ...base, cwdGuestPath }
    : base;
}

interface WslDistro {
  name: string;
  isDefault: boolean;
}

/**
 * Whether `command` resolves on this machine's PATH. Exported because the
 * router package cannot import it (child_process, process.platform) and takes
 * it as `RouterDeps.harnessInstalled` instead — `src/main/index.ts` passes
 * this function, which is exactly what the router used to reach for directly.
 */
export function commandExists(command: string): boolean {
  return commandPath(command) !== null;
}

/** Resolve once in the desktop environment; daemons may have an older PATH. */
export function commandPath(command: string): string | null {
  try {
    const output = execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        windowsHide: true,
      },
    );
    return output.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function listWslDistributions(): WslDistro[] {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync("wsl.exe", ["-l", "-v"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.replace(/\u0000/g, "").trimEnd())
      .filter((line) => line && !/^windows subsystem/i.test(line))
      .filter((line) => !/^name\s+state\s+version$/i.test(line.trim()))
      .map((line) => {
        const isDefault = line.trimStart().startsWith("*");
        const clean = line.replace(/^\*\s*/, "").trim();
        const [name] = clean.split(/\s{2,}/);
        return name ? { name, isDefault } : null;
      })
      .filter((value): value is WslDistro => value !== null);
  } catch {
    return [];
  }
}

export function getDefaultWslDistro(): string | null {
  const distros = listWslDistributions();
  return distros.find((d) => d.isDefault)?.name
    ?? distros[0]?.name
    ?? null;
}

/**
 * The agent harnesses, offered on every platform. `TerminalTarget` and
 * `resolveTerminalTarget` have always understood these; they were simply
 * missing from the picker, so the only way to launch one was the repo
 * row's context menu — never Cmd+N. Labels come from AGENT_TARGETS so the
 * picker and the tile title can't drift apart.
 */
export function agentTargetOptions(
  exists: (command: string) => boolean = commandExists,
): TerminalTargetOption[] {
  const installed = new Set(installedHarnesses(exists));
  return AGENT_HARNESS_IDS.map((id) => {
    const agent = AGENT_TARGETS[id];
    const option: TerminalTargetOption = {
      id,
      label: agent.displayName,
      installed: installed.has(id),
    };
    // Only carried when it's actionable — an installed harness has
    // nothing to offer, and the renderer keys the install strip off this.
    if (!installed.has(id) && agent.installCommand !== undefined) {
      option.installCommand = agent.installCommand;
    }
    return option;
  });
}

/**
 * The picker offers only concrete outcomes — no "Automatic" row. `auto` is
 * still the stored default and still means "first installed harness, else
 * a shell" (`resolveAutoTarget`); it is simply not a thing the user picks,
 * because on any given machine it is indistinguishable from whichever row
 * it resolves to, and offering both made the list read as two options that
 * did the same thing. The renderer selects the row `auto` resolves to, so
 * an untouched setting still shows the user a true answer.
 *
 * One consequence on Windows: `auto`'s cwd-driven WSL-distro detection
 * (`resolveWindowsAutoTarget`) is no longer directly selectable. It still
 * applies for anyone who has never changed the setting, and the concrete
 * PowerShell/WSL rows cover the rest.
 */
export function listTerminalTargets(): TerminalTargetOption[] {
  if (process.platform !== "win32") {
    return [
      { id: "shell", label: "Login shell" },
      ...agentTargetOptions(),
      ...AGENT_CATALOG.filter(agent => !agent.integratedHarness && commandExists(agent.installation.startCommand.split(/\s+/)[0]!)).map(agent => ({ id: `catalog:${agent.id}` as TerminalTarget, label: agent.name, installed: true })),
    ];
  }

  const options: TerminalTargetOption[] = [
    { id: "powershell", label: "PowerShell" },
    ...agentTargetOptions(),
  ];
  for (const distro of listWslDistributions()) {
    options.push({
      id: `wsl:${distro.name}`,
      label: distro.isDefault
        ? `${distro.name} (WSL default)`
        : distro.name,
    });
  }
  return options;
}

/**
 * Which harnesses this machine can actually run, in AGENT_HARNESS_IDS
 * order. Reads Cube's PATH, which is not always the PATH of the user's
 * login shell — that gap is exactly what the harness-missing message
 * below is for, and what the Settings picker surfaces up front so it is
 * discovered there rather than at Cmd+N.
 */
export function installedHarnesses(
  exists: (command: string) => boolean = commandExists,
): AgentHarnessId[] {
  return AGENT_HARNESS_IDS.filter((id) => exists(AGENT_TARGETS[id].command));
}

/**
 * What "Automatic" means: the first installed harness in AGENT_HARNESS_IDS
 * order (claude, then codex, then opencode), or — when this machine has
 * none — `auto` is left alone to keep its existing per-platform shell
 * meaning (the login shell, or WSL/PowerShell on Windows).
 *
 * So a machine with no agent behaves exactly as it does today, a machine
 * with one gets that one without being asked, and a machine with several
 * gets the highest-precedence one until the user says otherwise in
 * Settings. An EXPLICIT choice is passed straight through, so a harness
 * the user actually named still reaches `assertHarnessInstalled` and
 * fails loudly rather than being silently downgraded — a default may
 * degrade quietly, a stated intent must not.
 */
export function resolveAutoTarget(
  preferred: TerminalTarget,
  exists: (command: string) => boolean = commandExists,
): TerminalTarget {
  if (preferred !== "auto") return preferred;
  return installedHarnesses(exists)[0] ?? "auto";
}

function resolveWindowsAutoTarget(
  preferred: TerminalTarget,
  cwdHostPath: string,
): TerminalTarget {
  const unc = parseWslUncPath(cwdHostPath);
  if (unc) {
    return `wsl:${unc.distro}`;
  }
  if (preferred !== "auto") {
    return preferred;
  }
  const defaultDistro = getDefaultWslDistro();
  return defaultDistro ? `wsl:${defaultDistro}` : "powershell";
}

function resolveShellPath(): string {
  if (process.platform === "darwin") {
    return process.env.SHELL || "/bin/zsh";
  }
  return process.env.SHELL || "/bin/bash";
}

function resolvePowerShellCommand(): string {
  return commandExists("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
}

export function resolveTerminalTarget(
  preferredTarget: TerminalTarget,
  cwdHostPath?: string,
  agentSessionId?: string,
  resume?: boolean,
  exists: (command: string) => boolean = commandExists,
): ResolvedTerminalTarget {
  const initialCwd = cwdHostPath || os.homedir();
  if (catalogAgent(preferredTarget)) return resolveRemoteTarget(preferredTarget, initialCwd);

  // "Automatic" resolves before anything else, so an `auto` that means
  // Claude Code takes the agent branch below and an `auto` that doesn't
  // falls through to its existing per-platform shell meaning untouched.
  preferredTarget = resolveAutoTarget(preferredTarget, exists);

  const agent = isAgentHarnessId(preferredTarget)
    ? AGENT_TARGETS[preferredTarget]
    : undefined;
  if (agent) {
    // Provenance decides the flag: an id we minted is created, an id we
    // recovered is resumed. `resumed` is what actually happened, not what
    // was asked for — the caller renders a "resumed" marker off this, so it
    // must never claim a resume that did not occur.
    const idArgs = resume ? agent.resumeArgs : agent.sessionIdArgs;
    if (agentSessionId && idArgs) {
      return {
        target: preferredTarget,
        command: agent.command,
        args: [...agent.args, ...idArgs(agentSessionId)],
        displayName: agent.displayName,
        cwd: initialCwd,
        cwdHostPath: initialCwd,
        agentSessionId,
        resumed: resume === true,
      };
    }
    return {
      target: preferredTarget,
      command: agent.command,
      args: agent.args,
      displayName: agent.displayName,
      cwd: initialCwd,
      cwdHostPath: initialCwd,
      resumed: false,
    };
  }

  if (process.platform === "win32") {
    const target = resolveWindowsAutoTarget(
      preferredTarget,
      initialCwd,
    );

    if (target === "powershell") {
      const command = resolvePowerShellCommand();
      return {
        target,
        command,
        args: [],
        displayName: "PowerShell",
        cwd: initialCwd,
        cwdHostPath: initialCwd,
        resumed: false,
      };
    }

    if (target.startsWith("wsl:")) {
      const distro = target.slice(4);
      const guestPath = hostPathToGuestPath(initialCwd, target);
      const args = ["-d", distro];
      if (guestPath) {
        args.push("--cd", guestPath);
      }
      return withGuestPath({
        target,
        command: "wsl.exe",
        args,
        displayName: distro || "WSL",
        cwd: os.homedir(),
        cwdHostPath: initialCwd,
        resumed: false,
      }, guestPath);
    }

    const command = resolvePowerShellCommand();
    return {
      target: "powershell",
      command,
      args: [],
      displayName: "PowerShell",
      cwd: initialCwd,
      cwdHostPath: initialCwd,
      resumed: false,
    };
  }

  const shellPath = resolveShellPath();
  return {
    target: "shell",
    command: shellPath,
    args: [],
    displayName: displayBasename(shellPath) || "shell",
    cwd: initialCwd,
    cwdHostPath: initialCwd,
    resumed: false,
  };
}

/**
 * Throws when a resolved LOCAL session would exec an agent harness this
 * machine has no binary for.
 *
 * Without this the failure is invisible: node-pty exec'ing a command that
 * is not on PATH exits 1 having written nothing, so the tile closes the
 * instant it opens with no way to tell "codex is not installed" apart from
 * "codex crashed". A shell target needs no equivalent guard — resolveShellPath
 * falls back to /bin/zsh or /bin/bash, which are not optional on their
 * platforms.
 *
 * Caller-applied rather than folded into `resolveTerminalTarget`, because
 * that function is also how pty.ts asks what command a session WOULD run
 * (`shellCommandFor`, for the zsh-integration decision) — including for
 * cloud sessions, whose harness lives on the sprite and is none of this
 * machine's business. Only the local branch of the router's ptyCreate
 * asserts, for the same reason `resolveRemoteTarget` skips every other
 * host-only check.
 *
 * `exists` is injected only so tests need not depend on what the machine
 * running them happens to have installed.
 *
 * The check itself lives in `./harness`, which is host-agnostic
 * (the router package must also build for a browser); this is the Node
 * binding of it — the `commandExists` default the package cannot carry.
 */
export function assertHarnessInstalled(
  resolved: ResolvedTerminalTarget,
  exists: (command: string) => boolean = commandExists,
): void {
  assertHarnessInstalledWith(resolved, exists);
}
