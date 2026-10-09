import { AGENT_HARNESS_IDS } from "@port/shared/types";
import { availableAgentTargets } from "./available-agents";
import { catalogAgent } from "@port/shared/agent-catalog";
import { services } from "../../services";

export const DEFAULT_AGENT_PREF = "defaultAgent";

export function personaHarness(defaultAgent: string): "claude" | "codex" | "opencode" {
  return AGENT_HARNESS_IDS.find(id => id === defaultAgent) ?? "claude";
}

function isAgent(value: unknown): value is string {
  return typeof value === "string" && ((AGENT_HARNESS_IDS as readonly string[]).includes(value) || !!catalogAgent(value));
}

/** Settings and Cmd+N share one choice; legacy shell defaults cannot select a terminal. */
export async function getDefaultAgent(): Promise<string> {
  const preferred = await services.prefs.get(DEFAULT_AGENT_PREF);
  if (isAgent(preferred)) return preferred;
  const legacy = await services.prefs.get("terminalTarget");
  if (isAgent(legacy)) return legacy;
  const options = await availableAgentTargets();
  const installed = options.find(option => isAgent(option.id) && option.installed);
  return installed && isAgent(installed.id) ? installed.id : AGENT_HARNESS_IDS[0];
}
