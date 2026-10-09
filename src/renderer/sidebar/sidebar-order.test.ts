import { describe, expect, test } from "vitest";
import type { ClientRect } from "@dnd-kit/core";
import type { CatalogDocument, MergedCatalog } from "@port/shared/catalog";
import { buildSiblingIndex, createDragController, itemRowScope, planDrop, planMove, repoRowScope, scopeId, scopeMembers, scopedCollisionDetection, worktreeViewGroup } from "./sidebar-order";

const origin = (repoId: string) => ({ repoId, createdOnBranch: "main", source: { from: "new" as const } });
const repo = (id: string, machineId: string, worktreeOf?: string) => ({
  id, name: id, root: `/r/${id}`, managed: false, createdAt: "t", machineId, ...(worktreeOf ? { worktreeOf: origin(worktreeOf) } : {}),
});
const item = (id: string, machineId: string, repoId?: string, extra: Record<string, unknown> = {}) => ({
  id, type: "term" as const, createdAt: "t", machineId, ...(repoId ? { repoId } : {}), ...extra,
});

// The merged snapshot the sidebar renders from: the preview artifact is filtered out.
const merged: MergedCatalog = {
  repos: [repo("app", "m1"), repo("wt1", "m1", "app"), repo("wt2", "m1", "app"), repo("lib", "m2")],
  items: [item("t1", "m1", "app"), item("code", "m1", "app", { type: "code" }), item("t2", "m1", "app"), item("loose1", "m1"), item("loose2", "m2")],
};
// The held m1 document: everything the daemon has, including the hidden preview.
const m1Doc: Pick<CatalogDocument, "repos" | "items"> = {
  repos: merged.repos.filter((r) => r.machineId === "m1"),
  items: [
    item("t1", "m1", "app"),
    item("preview", "m1", "app", { type: "artifact", target: "web-preview" }),
    item("code", "m1", "app", { type: "code" }),
    item("t2", "m1", "app"),
    item("loose1", "m1"),
  ],
};

describe("row scopes", () => {
  test("items, worktrees and repos resolve to their machine and true scope", () => {
    expect(itemRowScope(merged, "t1")).toEqual({ machineId: "m1", scope: { kind: "items", repoId: "app" } });
    expect(repoRowScope(merged, "wt1")).toEqual({ machineId: "m1", scope: { kind: "worktrees", parentId: "app" } });
    expect(repoRowScope(merged, "app")).toEqual({ machineId: "m1", scope: { kind: "repos" } });
    expect(itemRowScope(merged, "missing")).toBeNull();
  });
  test("two machines' unscoped items are different sibling sets", () => {
    expect(scopeId(itemRowScope(merged, "loose1")!)).not.toBe(scopeId(itemRowScope(merged, "loose2")!));
    expect(scopeId(itemRowScope(merged, "t1")!)).toBe(scopeId(itemRowScope(merged, "t2")!));
  });
});

describe("scopeMembers", () => {
  test("membership comes from the held document, including rows the snapshot filtered out", () => {
    expect(scopeMembers(m1Doc, itemRowScope(merged, "t1")!)).toEqual(["t1", "preview", "code", "t2"]);
  });
  test("no held document means no membership", () => {
    expect(scopeMembers(undefined, itemRowScope(merged, "t1")!)).toBeNull();
  });
});

describe("buildSiblingIndex", () => {
  test("keeps render order within each scope, however scopes interleave", () => {
    const index = buildSiblingIndex([
      { id: "loose1", scopeId: "m1|items|" },
      { id: "orphan1", scopeId: "m1|items|orphan-wt" },
      { id: "loose2", scopeId: "m1|items|" },
    ]);
    expect(index.get("m1|items|")).toEqual(["loose1", "loose2"]);
    expect(index.get("m1|items|orphan-wt")).toEqual(["orphan1"]);
  });
});

describe("planDrop", () => {
  const row = itemRowScope(merged, "t1")!;
  const members = ["t1", "preview", "code", "t2"];
  const frozen = { row, displayedIds: ["t1", "t2"], members };

  test("a move expands to a full permutation with undisplayed rows pinned", () => {
    expect(planDrop(frozen, "t1", "t2", { displayedIds: ["t1", "t2"], members }))
      .toEqual({ machineId: "m1", scope: row.scope, ids: ["t2", "preview", "code", "t1"] });
  });
  test("dropping on itself sends nothing", () => {
    expect(planDrop(frozen, "t1", "t1", { displayedIds: ["t1", "t2"], members })).toBeNull();
  });
  test("a vanished row or changed membership cancels", () => {
    expect(planDrop(frozen, "t1", "t2", { displayedIds: ["t2"], members: ["preview", "code", "t2"] })).toBeNull();
    expect(planDrop(frozen, "t1", "t2", { displayedIds: ["t1", "t2"], members: [...members, "t3"] })).toBeNull();
    expect(planDrop(frozen, "ghost", "t2", { displayedIds: ["t1", "t2"], members })).toBeNull();
    expect(planDrop(frozen, "t1", "t2", { displayedIds: ["t1", "t2"], members: null })).toBeNull();
  });
  test("another client's reorder of the same membership does not cancel; the move applies to the current order", () => {
    const current = { displayedIds: ["t2", "t1"], members: ["t2", "preview", "code", "t1"] };
    expect(planDrop(frozen, "t1", "t2", current)).toEqual({ machineId: "m1", scope: row.scope, ids: ["t1", "preview", "code", "t2"] });
  });
});

describe("planMove", () => {
  const row = itemRowScope(merged, "t1")!;
  const members = ["t1", "preview", "code", "t2"];
  test("moves one displayed step and stops at the ends", () => {
    expect(planMove(row, "t1", "down", ["t1", "t2"], members)).toEqual({ machineId: "m1", scope: row.scope, ids: ["t2", "preview", "code", "t1"] });
    expect(planMove(row, "t1", "up", ["t1", "t2"], members)).toBeNull();
    expect(planMove(row, "t2", "down", ["t1", "t2"], members)).toBeNull();
  });
});

describe("worktree view groups", () => {
  const row = { machineId: "m1", scope: { kind: "repo-items" as const, repoId: "r1" } };
  test("each checkout is its own sibling set inside the repo-wide scope", () => {
    expect(worktreeViewGroup(row, "r1")).not.toBe(worktreeViewGroup(row, "w1"));
    expect(worktreeViewGroup(row, "w1")).not.toBe(scopeId(row));
  });
  test("a drop inside one checkout's group permutes only that group's slots", async () => {
    const calls: string[][] = [];
    const groups: Record<string, string[]> = { a: ["a", "c"], c: ["a", "c"], b: ["b", "d"], d: ["b", "d"] };
    const controller = createDragController({
      rowScope: () => row,
      displayedIds: (id) => groups[id] ?? [],
      members: () => ["a", "b", "c", "d"],
      reorder: async (_machineId, _scope, ids) => { calls.push(ids); return { ok: true }; },
      warn: () => {},
    });
    controller.start("d");
    expect(await controller.end("d", "b")).toBe("sent");
    expect(calls).toEqual([["a", "d", "c", "b"]]);
  });
});

describe("createDragController", () => {
  const row = itemRowScope(merged, "t1")!;
  const setup = (result: { ok: true } | { ok: false; reason: string } = { ok: true }) => {
    const calls: [string, unknown, string[]][] = [];
    const warnings: string[] = [];
    const live = { displayed: ["t1", "t2"], members: ["t1", "preview", "code", "t2"] as string[] | null };
    const controller = createDragController({
      rowScope: (id) => (id === "t1" || id === "t2" ? row : null),
      displayedIds: () => live.displayed,
      members: () => live.members,
      reorder: async (machineId, scope, ids) => { calls.push([machineId, scope, ids]); return result; },
      warn: (reason) => { warnings.push(reason); },
    });
    return { calls, warnings, live, controller };
  };

  test("a drop on a sibling sends the full permutation", async () => {
    const { calls, controller } = setup();
    controller.start("t1");
    expect(await controller.end("t1", "t2")).toBe("sent");
    expect(calls).toEqual([["m1", row.scope, ["t2", "preview", "code", "t1"]]]);
  });
  test("a refusal is reported and nothing else happens", async () => {
    const { calls, warnings, controller } = setup({ ok: false, reason: "membership-changed" });
    controller.start("t1");
    expect(await controller.end("t1", "t2")).toBe("refused");
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual(["membership-changed"]);
  });
  test("no target, a vanished row, a cancel, or no start sends nothing", async () => {
    const a = setup();
    a.controller.start("t1");
    expect(await a.controller.end("t1", null)).toBe("cancelled");

    const b = setup();
    b.controller.start("t1");
    b.live.displayed = ["t2"];
    b.live.members = ["preview", "code", "t2"];
    expect(await b.controller.end("t1", "t2")).toBe("cancelled");

    const c = setup();
    c.controller.start("t1");
    c.controller.cancel();
    expect(await c.controller.end("t1", "t2")).toBe("cancelled");

    const d = setup();
    expect(await d.controller.end("t1", "t2")).toBe("cancelled");

    expect([...a.calls, ...b.calls, ...c.calls, ...d.calls]).toEqual([]);
  });
});

describe("scopedCollisionDetection", () => {
  const rect = (top: number, height: number, left = 0, width = 200): ClientRect =>
    ({ top, left, width, height, bottom: top + height, right: left + width });
  const run = (activeScope: string, pointerY: number, rows: [string, string, ClientRect][], containerRect?: ClientRect) => {
    const droppableContainers = rows.map(([id, scope]) => ({ id, data: { current: { scopeId: scope } } }));
    const droppableRects = new Map(rows.map(([id, , r]) => [id, r]));
    return scopedCollisionDetection({
      active: {
        id: "active",
        data: { current: { scopeId: activeScope, getContainerRect: containerRect ? () => containerRect : undefined } },
        rect: { current: { initial: null, translated: null } },
      },
      collisionRect: rect(pointerY - 5, 10),
      droppableRects,
      droppableContainers,
      pointerCoordinates: { x: 50, y: pointerY },
    } as unknown as Parameters<typeof scopedCollisionDetection>[0]).map((c) => c.id);
  };
  // repo section (repos) contains worktree node (worktrees) contains item rows (items)
  const nested: [string, string, ClientRect][] = [
    ["repo-app", "m1|repos", rect(0, 300)],
    ["wt1", "m1|worktrees|app", rect(40, 120)],
    ["t1", "m1|items|wt1", rect(60, 20)],
    ["t2", "m1|items|wt1", rect(80, 20)],
    ["repo-other", "m2|repos", rect(400, 100)],
  ];

  test("a valid item drop ranks although other-scope ancestors contain the pointer", () => {
    expect(run("m1|items|wt1", 85, nested)[0]).toBe("t2");
  });
  test("a valid worktree drop ranks inside its repo section", () => {
    const withSibling: [string, string, ClientRect][] = [...nested, ["wt2", "m1|worktrees|app", rect(160, 60)]];
    expect(run("m1|worktrees|app", 180, withSibling)[0]).toBe("wt2");
  });
  test("a pointer over rows of no matching scope cancels", () => {
    expect(run("m1|items|other", 85, nested)).toEqual([]);
  });
  test("a repo dragged over another repo's item rows still reorders repos", () => {
    expect(run("m1|repos", 85, nested)[0]).toBe("repo-app");
  });
  test("a repo over the other machine's list cancels", () => {
    expect(run("m1|repos", 450, nested)).toEqual([]);
  });
  test("a pointer over nothing ranks only inside the scope's container", () => {
    const gap: [string, string, ClientRect][] = [["t1", "m1|items|wt1", rect(60, 20)], ["t2", "m1|items|wt1", rect(90, 20)]];
    expect(run("m1|items|wt1", 85, gap, rect(40, 120)).length).toBeGreaterThan(0);
    expect(run("m1|items|wt1", 1000, gap, rect(40, 120))).toEqual([]);
    expect(run("m1|items|wt1", 85, gap)).toEqual([]);
  });
});

describe("scopeId for repo-items", () => {
  test("is distinct from a checkout's items scope", () => {
    expect(scopeId({ machineId: "m", scope: { kind: "repo-items", repoId: "a" } })).toBe("m|repo-items|a");
    expect(scopeId({ machineId: "m", scope: { kind: "items", repoId: "a" } })).toBe("m|items|a");
  });
});
