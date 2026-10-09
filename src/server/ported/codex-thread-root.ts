// Codex can hold writer locks for its root conversation and its children
// in one process. Only an explicitly verified root is resumable on its own.
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_BYTES = 256 * 1024;

function parentFromHeader(path: string, id: string): string | null | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(HEADER_BYTES);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, count).indexOf(10);
    if (end < 0) return undefined;
    const record = JSON.parse(bytes.subarray(0, end).toString("utf8"));
    const meta = record.payload;
    if (record.type !== "session_meta" || meta?.id !== id) return undefined;
    const parent = meta.parent_thread_id;
    const nested = meta.source?.subagent?.thread_spawn?.parent_thread_id;
    if (parent != null && nested != null && parent !== nested) return undefined;
    const next = parent ?? nested;
    if (next != null) return typeof next === "string" && UUID.test(next) ? next : undefined;
    // A subagent whose ancestry we cannot interpret is not a root.
    return typeof meta.source === "string" && meta.source !== "unknown" ? null : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Bounded, cached first-record reads; never parse conversation messages. */
export function createCodexRootResolver(now: () => number = Date.now): (id: string, home: string) => string | null {
  const homes = new Map<string, { at: number; files: Map<string, string | null>; roots: Map<string, string> }>();
  return (id, home) => {
    if (!UUID.test(id)) return null;
    try {
      let state = homes.get(home);
      if (!state) {
        if (homes.size >= 8) homes.clear();
        state = { at: -Infinity, files: new Map(), roots: new Map() };
        homes.set(home, state);
      }
      if (state.roots.has(id)) return state.roots.get(id)!;
      if (now() - state.at >= 15_000) {
        state.at = now();
        state.files.clear();
        let remaining = 20_000;
        const walk = (dir: string, depth: number): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (--remaining < 0) throw new Error("Codex metadata scan budget exceeded");
            const path = join(dir, entry.name);
            if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) walk(path, depth + 1);
            if (!entry.isFile()) continue;
            const match = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(entry.name);
            if (!match || !UUID.test(match[1]!)) continue;
            const key = match[1]!;
            state!.files.set(key, state!.files.has(key) ? null : path);
          }
        };
        try { walk(join(home, "sessions"), 0); }
        catch { state.files.clear(); }
      }
      const seen = new Set<string>();
      let current = id;
      for (let depth = 0; depth < 16; depth++) {
        if (seen.has(current)) return null;
        seen.add(current);
        const path = state.files.get(current);
        if (!path) return null;
        const parent = parentFromHeader(path, current);
        if (parent === undefined) return null;
        if (parent === null) {
          if (state.roots.size >= 2048) state.roots.clear();
          for (const child of seen) state.roots.set(child, current);
          return current;
        }
        current = parent;
      }
    } catch { /* Unknown layouts and unreadable files leave saved IDs alone. */ }
    return null;
  };
}

export const resolveCodexRootThread = createCodexRootResolver();
