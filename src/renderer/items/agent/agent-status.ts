/**
 * What the sidebar says an agent item is doing right now.
 *
 * Two facts decide it, and the item's own outranks the transcript's: a
 * session that has exited (or was never spawned) is idle no matter what
 * the last records folded into its transcript said — the catalog's
 * `exitedAt` is the authoritative "this is over", the same way it is for a
 * terminal row. Only when the session is alive does the transcript speak:
 * a permission the agent is blocked on is `waiting` (it needs the USER,
 * which a row should say louder than "busy"), an open prompt turn is
 * `running`, anything else is idle.
 *
 * A `undefined` transcript is an item this client has not opened — another
 * client's item, or one never selected. It is not unknown, and it is not
 * silent either: `awaitingPermission` is the daemon's own answer to the
 * one question a row has to be able to ask without being opened. That is
 * the whole point of the phone case — the sidebar lists every item on the
 * machine, and the row that needs the user has to say so before anybody
 * taps it. Everything else about an unopened item is idle, because only a
 * transcript can tell running from finished.
 */

export type AgentStatus = "idle" | "running" | "waiting";

export function agentStatus(
  t: { pending: readonly unknown[]; running: boolean } | undefined,
  item: { ptySessionId?: string; exitedAt?: string; awaitingPermission?: boolean },
): AgentStatus {
  if (!item.ptySessionId || item.exitedAt) return "idle";
  // Either source is enough: the daemon knows about every client's
  // question, and this client's transcript knows about one the daemon has
  // not written yet (the frame arrives before `catalog:changed` does).
  if (item.awaitingPermission === true) return "waiting";
  if (!t) return "idle";
  if (t.pending.length > 0) return "waiting";
  if (t.running) return "running";
  return "idle";
}
