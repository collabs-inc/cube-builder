// Adapted from src/main/cubed/attention/opencode.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// OpenCode invokes plugin events without awaiting them. Contain all errors
// so status reporting can never interfere with the agent. Raw Escape is
// insufficient: it can dismiss a menu or ask for cancellation confirmation.
const PLUGIN = `import { writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
export default async ({ client }) => {
  const seen = new Set();
  return { event: async ({ event }) => {
    const info = event?.properties?.info;
    if (event?.type !== 'message.updated' || info?.role !== 'assistant' || info.error?.name !== 'MessageAbortedError' || !info.id || seen.has(info.id)) return;
    seen.add(info.id);
    if (seen.size > 256) seen.delete(seen.values().next().value);
    try {
      const sessionID = info.sessionID ?? event.properties.sessionID;
      const session = await client.session.get({ sessionID, path: { id: sessionID } });
      if (!session.data || session.data.parentID) return;
      const file = join(process.env.BUILDER_ATTENTION_SPOOL, process.env.BUILDER_ATTENTION_LAUNCH + '.' + randomBytes(8).toString('hex'));
      await writeFile(file, JSON.stringify({ type: 'opencode-interrupted', 'turn-id': info.id }), { mode: 0o600 });
      await rename(file, file + '.json');
    } catch {}
  } };
};
`;

/** Add a local event plugin to this launch, preserving the user's config. */
export function openCodeInterruptEnv(spoolDir: string, launchId: string, env: Record<string, string | undefined>): Record<string, string> | null {
  try {
    const config = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
    if (!config || typeof config !== "object" || Array.isArray(config) || (config.plugin !== undefined && !Array.isArray(config.plugin))) return null;
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const plugin = join(spoolDir, "opencode-interrupt.mjs");
    let previous: string | undefined;
    try { previous = readFileSync(plugin, "utf8"); } catch { /* first launch */ }
    if (previous !== PLUGIN) {
      const temp = `${plugin}.${randomBytes(8).toString("hex")}`;
      writeFileSync(temp, PLUGIN, { mode: 0o600 });
      renameSync(temp, plugin);
    }
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugin: [...(config.plugin ?? []), pathToFileURL(plugin).href] }),
      BUILDER_ATTENTION_SPOOL: spoolDir,
      BUILDER_ATTENTION_LAUNCH: launchId,
    };
  } catch { return null; }
}
