/** Explicit launch mode shared by every new-session entry point. */



import { AGENT_HARNESS_IDS, LOCAL_MACHINE_ID } from "@port/shared/types";
import { catalogAgent } from "@port/shared/agent-catalog";
import type { AgentView } from "@port/shared/agent-protocol";
import { acpConversationsEnabled } from "../../feature-flags";
import { services } from "../../services";
import type { DesktopPlatform, TerminalTargetOption } from "../../services/types";

export interface LaunchHost {
  machineId: string;
  platform: DesktopPlatform;
}

/**
 * Every harness in `AGENT_HARNESS_IDS` has an ACP front door
 * (`AGENT_TARGETS` in packages/router's remote-target.ts — claude and codex
 * through their `*-acp` shims, opencode through `opencode acp`), so
 * "is this an agent harness" and "can this harness talk ACP" are the same
 * question here. The renderer does not import `@cube/router`, and adding
 * that dependency to check `resolveAcpLaunch` would buy nothing while the
 * two lists agree; if a harness ever ships without an `acp` entry, this is
 * the line that has to learn about it.
 */
function isAcpCapable(target: string): boolean {
  return (AGENT_HARNESS_IDS as readonly string[]).includes(target);
}

/**
 * A conversation is only offered where it can actually run.
 *
 * The Windows carve-out is local-only and it is about spawning, not about
 * ACP: the harnesses install as npm `.cmd` shims there, which ConPTY
 * resolves for a `term` item but `child_process.spawn` — what a pipe
 * session uses — does not. A cloud machine is Linux however Windows the
 * desktop driving it is, so the rule keys on the target machine, not on
 * the platform alone.
 */
export function decideLaunch(view: AgentView, target: string, host: LaunchHost): "agent" | "term" {
  if (view !== "conversation") return "term";
  if (!isAcpCapable(target)) return "term";
  if (host.machineId === LOCAL_MACHINE_ID && host.platform === "win32") return "term";
  return "agent";
}

/**
 * What a new terminal opens into when the caller named no target — the
 * stored `terminalTarget`, with `auto` resolved the way main's
 * `resolveAutoTarget` does (first installed harness, else the option that
 * carries no `installed` flag at all, i.e. the shell).
 *
 * Shared with Settings → Terminal, which shows the user the same answer on
 * its radio list; the two must not drift, which is why this lives here and
 * `TerminalPane` imports it rather than keeping its own copy.
 */
export function resolveDefaultTarget(
  pref: string,
  options: TerminalTargetOption[],
): string | null {
  if (pref !== "auto") return pref;
  const firstInstalled = options.find((o) => o.installed);
  if (firstInstalled) return firstInstalled.id;
  return options.find((o) => o.installed === undefined)?.id ?? null;
}

export interface LaunchPlan {
  type: "agent" | "term";
  target?: string;
}

export async function planLaunch(input: {
  machineId: string;
  target?: string | undefined;
  view?: AgentView | undefined;
}): Promise<LaunchPlan> {
  if (input.target && catalogAgent(input.target)) return { type: "term", target: input.target };
  if (input.view !== "conversation") return { type: "term" };
  // The release gate (feature-flags.ts). This is the one funnel every
  // "new agent" entry point passes through, so gating here is what makes
  // the sparkle, the empty-checkout row, the context menus, the canvas and
  // ⌘N all fall back to the pre-conversation behaviour at once: a terminal
  // running the chosen harness. The target is carried rather than dropped
  // so main resolves the harness command exactly as it does for the
  // "New terminal → Claude Code" path.
  if (!acpConversationsEnabled()) {
    return input.target === undefined ? { type: "term" } : { type: "term", target: input.target };
  }
  if (!input.target || !isAcpCapable(input.target)) {
    throw new Error("Choose an agent for conversation mode.");
  }
  if (decideLaunch("conversation", input.target, {
    machineId: input.machineId, platform: services.desktop.getPlatform(),
  }) !== "agent") {
    throw new Error("Conversations aren't supported on local Windows machines yet. Choose this agent from the Terminal menu, or use a cloud machine.");
  }
  return { type: "agent", target: input.target };
}

