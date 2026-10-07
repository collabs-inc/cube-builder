// Adapted from src/main/cubed/attention/hooks.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * How an agent launched from a tile tells cubed what its turn is doing.
 *
 * Both harnesses accept per-invocation configuration, so nothing here edits
 * a user's own settings file: claude takes `--settings <json>`, whose hooks
 * run alongside the user's; codex takes `-c notify=[...]`, the one
 * turn-completion program it has. Verified against claude 2.1.270 and codex
 * 0.154.0: claude's `UserPromptSubmit` and `Stop` payloads carry
 * `prompt_id`, and codex's notify payload is `agent-turn-complete` with a
 * `turn-id`.
 *
 * Hooks run with no controlling terminal, so they cannot write into the
 * session's own stream. They write one file each into cubed's spool
 * instead (spool.ts), named for the launch they belong to. A hook must
 * print NOTHING and always exit 0: claude reads a `PermissionRequest`
 * hook's stdout as a decision, and a non-zero exit can block the turn.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { HarnessProfile } from "./state";
import { openCodeInterruptEnv } from "./opencode";

export type AttentionHarness = "claude" | "codex" | "opencode";

export const HARNESS_PROFILES: Record<AttentionHarness, HarnessProfile> = {
  claude: { opens: true, ends: true },
  codex: { opens: false, ends: true },
  opencode: { opens: false, ends: false },
};

/** Where hooks drop their reports — see spool.ts. */
export function attentionSpoolDir(dataDir: string): string {
  return join(dataDir, "attention");
}

/** Bytes of one report a hook keeps. Claude's own fields precede `tool_input`. */
export const MAX_REPORT_BYTES = 65_536;

/** `BUILDER_AGENT_ATTENTION=0` launches agents exactly as before. */
export function attentionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BUILDER_AGENT_ATTENTION !== "0";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function template(spoolDir: string, launchId: string): string {
  return shellQuote(join(spoolDir, `${launchId}.XXXXXX`));
}

/**
 * Written under a temporary name and renamed, so the spool never reads a
 * half-written report. `mktemp` creates the file owner-only.
 */
export function stdinReportCommand(spoolDir: string, launchId: string): string {
  return `{ f=$(mktemp ${template(spoolDir, launchId)}) && head -c ${MAX_REPORT_BYTES} > "$f" && mv "$f" "$f.json"; } >/dev/null 2>&1; exit 0`;
}

/** The same, for a program handed its payload as its last argument (codex notify). */
export function argReportScript(spoolDir: string, launchId: string): string {
  return `{ f=$(mktemp ${template(spoolDir, launchId)}) && printf '%s' "$1" | head -c ${MAX_REPORT_BYTES} > "$f" && mv "$f" "$f.json"; } >/dev/null 2>&1; exit 0`;
}

export function claudeSettings(spoolDir: string, launchId: string): string {
  const hooks = [{ type: "command", command: stdinReportCommand(spoolDir, launchId), timeout: 10 }];
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks }],
      Stop: [{ hooks }],
      PermissionRequest: [{ matcher: "*", hooks }],
      PreToolUse: [{ matcher: "AskUserQuestion|ExitPlanMode", hooks }],
      PostToolUse: [{ matcher: "AskUserQuestion|ExitPlanMode", hooks }],
      PostToolUseFailure: [{ matcher: "AskUserQuestion|ExitPlanMode", hooks }],
    },
  });
}

/** A TOML array of basic strings; JSON string escapes are valid TOML ones. */
export function codexNotifyOverride(spoolDir: string, launchId: string, existing: string[] = []): string {
  // Isolate the spool script's exit, then forward the exact payload to the
  // user's notification command. Neither hook can pollute the TUI output.
  const script = existing.length
    ? `(${argReportScript(spoolDir, launchId)}); ${existing.map(shellQuote).join(" ")} "$1" >/dev/null 2>&1; exit 0`
    : argReportScript(spoolDir, launchId);
  return `notify=${JSON.stringify(["sh", "-c", script, "builder-attention"])}`;
}

/**
 * Detect an existing notify setting so the launch override can forward to
 * it as well as filing Cube's report. Never change the user's config file.
 */
export function userHasCodexNotify(env: Record<string, string | undefined>): boolean {
  const home = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
  try {
    // TOML allows the key bare or quoted.
    return /^\s*(?:notify|"notify"|'notify')\s*=/m.test(readFileSync(join(home, "config.toml"), "utf8"));
  } catch {
    return false;
  }
}

export function injectAttentionArgs(
  target: string,
  command: string,
  args: string[],
  spoolDir: string,
  launchId: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): { args: string[]; harness: AttentionHarness; env?: Record<string, string> } | null {
  // The report commands are POSIX shell.
  if (platform === "win32" || !attentionEnabled(env)) return null;
  // The flags are the harness's own, so they go only to the harness binary.
  // A target can be launched through something else — a wrapper script or a
  // plain shell — which would read `--settings` or `-c` as its own.
  if (basename(command) !== target) return null;
  if (target === "claude") {
    if (args.some(arg => arg === "--settings" || arg.startsWith("--settings="))) return null;
    return { args: ["--settings", claudeSettings(spoolDir, launchId), ...args], harness: "claude" };
  }
  if (target === "codex") {
    if (args.some(arg => /^notify\s*=/.test(arg))) return null;
    let existing: string[] = [];
    if (userHasCodexNotify(env)) {
      const home = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
      try {
        const notify = parseToml(readFileSync(join(home, "config.toml"), "utf8")).notify;
        if (!Array.isArray(notify) || !notify.every(value => typeof value === "string")) return null;
        existing = notify as string[];
      } catch { return null; }
    }
    return { args: ["-c", codexNotifyOverride(spoolDir, launchId, existing), ...args], harness: "codex" };
  }
  if (target === "opencode") {
    const overrides = openCodeInterruptEnv(spoolDir, launchId, env);
    return overrides ? { args, harness: "opencode", env: overrides } : null;
  }
  return null;
}
