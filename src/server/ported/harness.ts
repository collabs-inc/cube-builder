// packages/router/src/harness.ts
//
// The agent-harness guard, host-agnostic: whether `command` exists is the
// one Node-only question, and it is injected. Main wraps this with a real
// PATH lookup (src/main/terminal-target.ts); the browser never reaches it
// (its resolveLocalTarget throws first) and passes `() => true`.
//
// Without this guard the failure is invisible: a pty exec'ing a command
// that is not on PATH exits 1 having written nothing, so the tile closes
// the instant it opens with no way to tell "codex is not installed" apart
// from "codex crashed". A shell target needs no equivalent guard — the
// local resolver falls back to /bin/zsh or /bin/bash, which are not
// optional on their platforms.
import { HARNESS_MISSING_PREFIX } from "@port/shared/types";
import { isAgentHarnessId, type AcpLaunch, type ResolvedTerminalTarget } from "./remote-target";

export function assertHarnessInstalled(
  resolved: ResolvedTerminalTarget,
  exists: (command: string) => boolean,
): void {
  if (!isAgentHarnessId(resolved.target) && !resolved.target.startsWith("catalog:")) return;
  if (exists(resolved.command)) return;
  throw new Error(
    `${HARNESS_MISSING_PREFIX}${resolved.displayName} isn't installed, or isn't on `
    + `Cube's PATH. Check that \`${resolved.command}\` runs in a new terminal, `
    + "then relaunch Cube.",
  );
}

export function assertAcpInstalled(launch: AcpLaunch, exists: (command: string) => boolean): void {
  if (exists(launch.command)) return;
  const install = launch.installCommand ? ` Install it with \`${launch.installCommand}\`.` : "";
  throw new Error(
    `${HARNESS_MISSING_PREFIX}${launch.displayName}'s conversation adapter (\`${launch.command}\`) isn't installed, `
    + `or isn't on Cube's PATH.${install} Then relaunch Cube.`,
  );
}
