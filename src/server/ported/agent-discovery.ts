// Which running sessions have a discoverable conversation id, and what to
// do with the answer.
//
// The tier-1 recovery spec's extension surface was one function per
// target, keyed by a pid. Two things widened it:
//
//   - It takes the session's whole PROCESS GROUP, because the
//     npm-installed codex is a node shim whose child holds the lock. The
//     pty's direct child answers nothing.
//   - It is SELECTED BY TARGET rather than raced. A session launched as
//     `codex` gets the codex probe and nothing else. A shell session gets
//     none — a discovered id would be unusable there (a shell target has
//     no resumeArgs) and promoting a shell tile to an agent tile was
//     rejected in the tier-1 spec. Skipping shells is also the entire
//     cost budget: most tiles are shells.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createClaudeSessionReader } from "./claude-registry";
import { createCodexThreadReader } from "./codex-locks";

export type SessionProbe = (pid: number) => string | null;
/** Keyed by the session's `target` — see AGENT_HARNESS_IDS. */
export type AgentProbes = Record<string, SessionProbe>;

export type ExecFn = (command: string, args: string[]) => string;

/**
 * The single switch that disables the whole discovery bridge.
 *
 * Both probes read another product's internal layout. If either format
 * changes in a way that makes discovery actively wrong — rather than just
 * unhelpful — an operator needs to turn it off without shipping a build.
 * Unrecognised values leave it ON: a typo in an env var must not silently
 * disable session recovery.
 */
export function discoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["BUILDER_AGENT_DISCOVERY"];
  return raw !== "0" && raw !== "false";
}

/**
 * opencode is absent on purpose. A running opencode TUI holds no
 * per-session file, no lock and no listening socket, so there is nothing
 * to observe; it is recoverable only by launching it with `--port`, which
 * is a separate design. Absent here means "never probed", which is the
 * correct behaviour, not a gap.
 */
export function defaultAgentProbes(env: NodeJS.ProcessEnv = process.env): AgentProbes {
  if (!discoveryEnabled(env)) return {};
  return {
    claude: createClaudeSessionReader(),
    codex: createCodexThreadReader(),
  };
}

function defaultExec(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
}

/**
 * Every process's group, read ONCE per discovery sweep, as a lookup from a
 * session's pty pid to every pid in its group, leader first.
 *
 * node-pty starts each session with setsid, so the pty pid is the session
 * id. On Linux the group is the SESSION, which is what the old `ps -g`
 * selected there: codex's `codex-code-mode` child takes its own process
 * group but stays in the session. macOS `ps` has no session id column, and
 * its `-g` meant the process group, so macOS keeps grouping by pgid. This used to be a synchronous `ps -g <pid>` per agent
 * session per sweep, and a synchronous spawn forks the whole daemon: on a
 * cloud machine with ~25 agent sessions and a 2 GB cubed (the recursive
 * file watcher's index), each fork cost ~50 ms and every 5-second sweep
 * froze the event loop for ~1.3 s — long enough to fail /healthz and time
 * out clients (production, 2026-09-24). Linux now reads /proc with no
 * subprocess at all; elsewhere one `ps -A` covers every session.
 *
 * A failure degrades to each leader alone rather than to nothing: a
 * single-process agent is still discoverable that way.
 */
export interface ProcessGroupDeps {
  platform?: NodeJS.Platform;
  listProc?: () => string[];
  readStat?: (pid: string) => string;
  exec?: ExecFn;
}

export function snapshotProcessGroups(deps: ProcessGroupDeps = {}): (pid: number) => number[] {
  const members = new Map<number, number[]>();
  const add = (pid: number, pgid: number) => {
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(pgid) || pgid <= 0) return;
    const list = members.get(pgid);
    if (list) list.push(pid);
    else members.set(pgid, [pid]);
  };
  try {
    if ((deps.platform ?? process.platform) === "linux") {
      const listProc = deps.listProc ?? (() => readdirSync("/proc"));
      const readStat = deps.readStat ?? ((pid) => readFileSync(`/proc/${pid}/stat`, "utf8"));
      for (const name of listProc()) {
        if (!/^\d+$/.test(name)) continue;
        let stat: string;
        try { stat = readStat(name); } catch { continue; } // exited mid-scan
        // "pid (comm) state ppid pgrp session ...": comm may hold spaces and parens.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        add(Number(name), Number(fields[3]));
      }
    } else {
      const out = (deps.exec ?? defaultExec)("ps", ["-A", "-o", "pid=,pgid="]);
      for (const line of out.split("\n")) {
        const [pid, pgid] = line.trim().split(/\s+/).map(Number);
        add(pid!, pgid!);
      }
    }
  } catch {
    // Nothing readable: every lookup below answers the leader alone.
  }
  return (pid) => [pid, ...(members.get(pid) ?? []).filter((member) => member !== pid)];
}

/** The first id any pid in the group answers with, or null. */
export function discoverAcrossGroup(pids: number[], probe: SessionProbe): string | null {
  for (const pid of pids) {
    try {
      const found = probe(pid);
      if (found !== null) return found;
    } catch {
      // One unreadable process says nothing about the rest of the group.
    }
  }
  return null;
}

/**
 * The catalog patch a discovery result implies, or null for "leave it
 * alone".
 *
 * Two rules, both load-bearing. `null` from a probe means "don't know",
 * never "no session" — a codex tile has no thread until the user's first
 * turn, and clearing a known id on an unlucky read would lose the
 * conversation. And an unchanged id must not be written: every
 * `updateItem` bumps the catalog `rev` and broadcasts to every attached
 * client, on a 5-second timer, forever.
 */
export function decideDiscoveryPatch(
  current: string | undefined,
  discovered: string | null,
): { agentSessionId: string } | null {
  if (discovered === null) return null;
  if (discovered === current) return null;
  return { agentSessionId: discovered };
}
