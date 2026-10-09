/**
 * What an agent row is asking of this client, derived from daemon-written
 * facts on its catalog row plus this client's own watermark. Never stored,
 * never acknowledged back to the machine.
 *
 * `running` precedes `done` deliberately: turn A can end and another client
 * can open turn B right after, leaving a row that is genuinely working while
 * still carrying A's stamp. A newer turn supersedes the unread completion,
 * which resurfaces when that turn ends.
 *
 * The watermark is a `turnEndedAt` this client copied off the row, so the
 * comparison never mixes clocks. `undefined` means this client has not
 * observed the row yet — nothing is unread; `null` means it observed a row
 * that had never finished a turn, so its first completion is new.
 */



import type { CatalogItem } from "@port/shared/catalog";
import type { AgentStatus } from "../items/agent/agent-status";

export type Attention = "blocked" | "running" | "done" | "idle";

export type AttentionRow = Pick<CatalogItem, "ptySessionId" | "exitedAt" | "agentActivity" | "turnEndedAt">;

export function deriveAttention(item: AttentionRow, watermark: string | null | undefined): Attention {
  if (!item.ptySessionId || item.exitedAt) return "idle";
  if (item.agentActivity === "blocked") return "blocked";
  if (item.agentActivity === "running") return "running";
  if (item.turnEndedAt !== undefined && watermark !== undefined
    && (watermark === null || item.turnEndedAt > watermark)) return "done";
  return "idle";
}

/**
 * An opened conversation's transcript can know about a question or a turn
 * before the catalog broadcast lands; either source is enough to say so.
 */
export function withTranscript(attention: Attention, status: AgentStatus | undefined): Attention {
  if (status === "waiting") return "blocked";
  if (status === "running" && attention !== "blocked") return "running";
  return attention;
}

const RANK: Record<Attention, number> = { idle: 0, running: 1, done: 2, blocked: 3 };

/** Worst wins: a request outranks a report, which outranks work in progress. */
export function rollupAttention(states: Iterable<Attention>): Attention {
  let worst: Attention = "idle";
  for (const state of states) if (RANK[state] > RANK[worst]) worst = state;
  return worst;
}

export const ATTENTION_LABELS: Record<Exclude<Attention, "idle">, string> = {
  blocked: "Waiting for you",
  running: "Working",
  done: "Finished",
};

/** A persona reports its live owned ACP agents, or itself when none remain. */
export function personaAttention(
  personaId: string,
  items: readonly Pick<CatalogItem, "id" | "type" | "personaId" | "exitedAt">[],
  attention: ReadonlyMap<string, Attention>,
): Attention {
  // Workers are terminals now and were conversations before; a persona's
  // state rolls up whichever it owns.
  const agents = items.filter(item => (item.type === "agent" || item.type === "term")
    && item.personaId === personaId && item.exitedAt === undefined);
  return agents.length === 0
    ? attention.get(personaId) ?? "idle"
    : rollupAttention(agents.map(item => attention.get(item.id) ?? "idle"));
}
