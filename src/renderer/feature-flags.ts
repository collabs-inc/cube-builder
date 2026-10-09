/**
 * Release gates for the renderer.
 *
 * `CUBE_ACP` decides whether this client OFFERS ACP conversations — the
 * "New agent" entry points, ⌘N and the Settings copy. It is ONE variable
 * for both processes, the way `CUBE_ANALYTICS` is: main reads
 * `process.env.CUBE_ACP` at runtime for the File menu, and the renderer,
 * which is a bundle and cannot, gets the same value frozen in as
 * `__CUBE_ACP__` by both vite configs. Disabled by default; set `CUBE_ACP=1` to enable.
 *
 * The gate is deliberately creation-side only. Existing `agent` items keep
 * rendering, resuming and closing whatever the flag says — the catalog is
 * the machine's, another client or an earlier build may well have started
 * a conversation, and hiding a live one is worse than showing it. What
 * changes when the flag is off is what a "new agent" click makes: a
 * terminal running the harness, exactly what it made before conversations
 * existed (`planLaunch` in items/agent/create-agent-item.ts).
 *
 * Under a test runner nothing defines `__CUBE_ACP__`, so the flag reads
 * off; suites that exercise the conversation paths turn it on through
 * `setAcpConversationsEnabledForTests`.
 */

let override: boolean | undefined;

export function acpConversationsEnabled(): boolean {
  if (override !== undefined) return override;
  return false;
}

/** Test seam only. `undefined` restores the build-time value. */
export function setAcpConversationsEnabledForTests(value: boolean | undefined): void {
  override = value;
}

/**
 * `CUBE_AUTOMATIONS` decides whether the navigator OFFERS the Automations
 * surface. Same shape as `CUBE_ACP`: one shell variable, frozen in as
 * `__CUBE_AUTOMATIONS__` by both vite configs, off in every build unless
 * set to "1". The surface, its cubed verb and the discovery adapters ship
 * regardless; only the strip entry and a persisted surface pick are gated.
 */
let automationsOverride: boolean | undefined;

export function automationsEnabled(): boolean {
  if (automationsOverride !== undefined) return automationsOverride;
  return false;
}

/** Test seam only. `undefined` restores the build-time value. */
export function setAutomationsEnabledForTests(value: boolean | undefined): void {
  automationsOverride = value;
}

/**
 * The app shell offers Personas by default; `CUBE_PERSONAS=0` opts out.
 * Personas use ACP internally, independently of the gate for ordinary
 * conversation launches. Existing terminals keep their usual launch behavior.
 */
let personasOverride: boolean | undefined;

export function personasEnabled(): boolean {
  if (personasOverride !== undefined) return personasOverride;
  return false;
}

/** Test seam only. `undefined` restores the build-time value. */
export function setPersonasEnabledForTests(value: boolean | undefined): void {
  personasOverride = value;
}
