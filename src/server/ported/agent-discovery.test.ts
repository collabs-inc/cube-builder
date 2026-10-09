import { describe, expect, test } from "vitest";
import {
  decideDiscoveryPatch,
  defaultAgentProbes,
  discoverAcrossGroup,
  discoveryEnabled,
  snapshotProcessGroups,
} from "./agent-discovery";

describe("defaultAgentProbes", () => {
  test("covers exactly the harnesses that can be discovered", () => {
    // opencode is deliberately absent: no artifact of a running opencode
    // process names its session (see the 2026-08-17 spike).
    expect(Object.keys(defaultAgentProbes()).sort()).toEqual(["claude", "codex"]);
  });

  test("a shell target has no probe, so it is never probed", () => {
    const probes = defaultAgentProbes();
    expect(probes["shell"]).toBeUndefined();
    expect(probes["wsl:Ubuntu"]).toBeUndefined();
  });
});

describe("snapshotProcessGroups", () => {
  const stat = (pid: number, comm: string, session: number, pgrp = session) => `${pid} (${comm}) S 1 ${pgrp} ${session} 0 -1 4194560 0 0`;
  const linux = (table: Record<string, string>, extra: Partial<Parameters<typeof snapshotProcessGroups>[0]> = {}) =>
    snapshotProcessGroups({
      platform: "linux",
      listProc: () => ["self", "net", ...Object.keys(table)],
      readStat: (pid) => { const row = table[pid]; if (row === undefined) throw new Error("ENOENT"); return row; },
      ...extra,
    });

  test("linux: a child in its own process group still belongs to the session", () => {
    // codex's code-mode helper, as seen on a production machine.
    const groupOf = linux({ "3307": stat(3307, "node", 3307), "3315": stat(3315, "codex", 3307), "20065": stat(20065, "codex-code-mode", 3307, 20065) });
    expect(groupOf(3307)).toEqual([3307, 3315, 20065]);
  });

  test("linux: groups every pid under its session, leader first", () => {
    const groupOf = linux({ "24579": stat(24579, "node", 24571), "24571": stat(24571, "sh", 24571), "30000": stat(30000, "bash", 30000) });
    expect(groupOf(24571)).toEqual([24571, 24579]);
    expect(groupOf(30000)).toEqual([30000]);
  });

  test("linux: a comm with spaces and parentheses does not shift the fields", () => {
    const groupOf = linux({ "500": stat(500, "tmux: server) (x", 400), "400": stat(400, "a b", 400) });
    expect(groupOf(400)).toEqual([400, 500]);
  });

  test("linux: a process that exits mid-scan is skipped, not fatal", () => {
    const groupOf = snapshotProcessGroups({
      platform: "linux",
      listProc: () => ["10", "11", "12"],
      readStat: (pid) => { if (pid === "11") throw new Error("ENOENT"); return stat(Number(pid), "x", 10); },
    });
    expect(groupOf(10)).toEqual([10, 12]);
  });

  test("linux: an unreadable /proc degrades to the leader alone", () => {
    const groupOf = snapshotProcessGroups({ platform: "linux", listProc: () => { throw new Error("EACCES"); } });
    expect(groupOf(42)).toEqual([42]);
  });

  test("linux: never spawns a subprocess", () => {
    let spawns = 0;
    linux({ "1": stat(1, "init", 1) }, { exec: () => { spawns++; return ""; } });
    expect(spawns).toBe(0);
  });

  test("elsewhere: one ps covers every group", () => {
    let spawns = 0;
    const groupOf = snapshotProcessGroups({
      platform: "darwin",
      exec: () => { spawns++; return "  24571 24571\n  24579 24571\nPID PGID\n 30000 30000\n"; },
    });
    expect(groupOf(24571)).toEqual([24571, 24579]);
    expect(groupOf(30000)).toEqual([30000]);
    expect(groupOf(99)).toEqual([99]);
    expect(spawns).toBe(1);
  });

  test("elsewhere: a failed ps degrades to the leader alone", () => {
    const groupOf = snapshotProcessGroups({ platform: "darwin", exec: () => { throw new Error("no ps"); } });
    expect(groupOf(24571)).toEqual([24571]);
  });

  test("a large process table stays fast", () => {
    const table: Record<string, string> = {};
    for (let pid = 2; pid < 20_002; pid++) table[String(pid)] = stat(pid, "worker", 2 + (pid % 50));
    const started = performance.now();
    const groupOf = linux(table);
    expect(groupOf(2)).toHaveLength(401);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("finds a real process group on this machine", async () => {
    const { spawn } = await import("node:child_process");
    const leader = spawn("sh", ["-c", "sleep 30 & sleep 30"], { detached: true, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const group = snapshotProcessGroups()(leader.pid!);
      expect(group[0]).toBe(leader.pid!);
      expect(group.length).toBeGreaterThanOrEqual(2);
    } finally {
      process.kill(-leader.pid!, "SIGKILL");
    }
  });
});

describe("discoverAcrossGroup", () => {
  test("finds an id held by a child rather than the group leader", () => {
    // The npm-installed codex is a node shim; the real process is its child.
    const probe = (pid: number) => (pid === 24579 ? "thread-1" : null);
    expect(discoverAcrossGroup([24571, 24579], probe)).toBe("thread-1");
  });

  test("returns null when no pid in the group answers", () => {
    expect(discoverAcrossGroup([1, 2], () => null)).toBeNull();
  });

  test("a throwing probe does not sink the scan", () => {
    const probe = (pid: number) => {
      if (pid === 1) throw new Error("boom");
      return "thread-1";
    };
    expect(discoverAcrossGroup([1, 2], probe)).toBe("thread-1");
  });
});

describe("decideDiscoveryPatch", () => {
  test("writes a discovered id onto an item that has none", () => {
    expect(decideDiscoveryPatch(undefined, "thread-1")).toEqual({ agentSessionId: "thread-1" });
  });

  test("overwrites when the process moved to a different conversation", () => {
    // The user ran /resume inside a claude tile, or started a new codex
    // thread. The item must follow the process, not the seed.
    expect(decideDiscoveryPatch("seed", "thread-2")).toEqual({ agentSessionId: "thread-2" });
  });

  test("null means 'don't know' and never clears a known id", () => {
    // A codex tile has no thread until the user's first turn.
    expect(decideDiscoveryPatch("thread-1", null)).toBeNull();
    expect(decideDiscoveryPatch(undefined, null)).toBeNull();
  });

  test("no write when nothing changed", () => {
    expect(decideDiscoveryPatch("thread-1", "thread-1")).toBeNull();
  });
});

describe("discoveryEnabled", () => {
  test("on by default", () => {
    expect(discoveryEnabled({})).toBe(true);
  });

  test("off for the documented off-switch values", () => {
    expect(discoveryEnabled({ BUILDER_AGENT_DISCOVERY: "0" })).toBe(false);
    expect(discoveryEnabled({ BUILDER_AGENT_DISCOVERY: "false" })).toBe(false);
  });

  test("any other value leaves it on — this must fail safe, not fail closed", () => {
    // A typo in an env var must not silently disable session recovery.
    expect(discoveryEnabled({ BUILDER_AGENT_DISCOVERY: "1" })).toBe(true);
    expect(discoveryEnabled({ BUILDER_AGENT_DISCOVERY: "yes" })).toBe(true);
  });

  test("disabled means no probes at all, so no target is ever probed", () => {
    expect(defaultAgentProbes({ BUILDER_AGENT_DISCOVERY: "0" })).toEqual({});
  });
});
