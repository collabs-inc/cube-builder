export type { AgentCatalogEntry, AgentInstallation, AgentUninstall } from "./agent-catalog-schema";
export { parseAgentCatalog } from "./agent-catalog-schema";
import type { AgentCatalogEntry } from "./agent-catalog-schema";
import { agentCatalog } from "./agent-catalog.generated";

/** The twenty agents from agents/catalog.json, validated at load. */
export const AGENT_CATALOG: readonly AgentCatalogEntry[] = agentCatalog;

export function catalogAgent(target: string): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find(agent => `catalog:${agent.id}` === target && !agent.integratedHarness);
}
export function agentTargetId(agent: AgentCatalogEntry): string {
  return agent.integratedHarness ?? `catalog:${agent.id}`;
}
