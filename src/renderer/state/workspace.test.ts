import { afterEach, describe, expect, test, beforeEach } from "vitest";
import { setScreenScrollPosition } from "./screen-scroll-position";
import { workspaceStore, hydrate, hideItem, focusItem, showItem, setActiveItem, moveItem, resizeColumn, resizePane, focusDirection, reconcile, rememberCanvasTileSize, openTreePane, navigateTreePaneUp, registerTreePane, closeTreePane, TREE_PANE_ID_PREFIX, createScreen, renameScreen, reorderScreen, hydrateScreens, closeScreen, activeScreen, screenView, resizeScreenDivider, displayedItemIds } from "./workspace";
import { SEED_WIDTH_PX, MIN_COLUMN_WIDTH_PX } from "./layout-ops";
import { acceptSnapshot, resetCatalog } from "./catalog";
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import { takeInstantScreenNavigation } from "./screen-navigation";
import type { Screen } from "./screen-ops";

beforeEach(() => {
  resetCatalog();
  hydrate({ activeItemId: null });
});

describe("hydrate", () => {
  test("replaces state and notifies subscribers", () => {
    let calls = 0;
    const unsubscribe = workspaceStore.subscribe(() => {
      calls++;
    });

    hydrate({
      activeItemId: "seed-1",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "seed-1", heightRatio: 1 }] }],
    });

    expect(workspaceStore.getSnapshot().columns[0]?.panes[0]?.itemId).toBe("seed-1");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("seed-1");
    expect(calls).toBe(1);
    unsubscribe();
  });

  test("a dangling activeItemId falls back to the first column's first pane", () => {
    hydrate({
      activeItemId: "does-not-exist",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "seed-1", heightRatio: 1 }] }],
    });

    expect(workspaceStore.getSnapshot().activeItemId).toBe("seed-1");
  });

  test("a dangling activeItemId falls back to null when there are no columns", () => {
    hydrate({ activeItemId: "does-not-exist" });

    expect(workspaceStore.getSnapshot().activeItemId).toBeNull();
  });

  test("garbage columns repair to empty rather than throwing", () => {
    hydrate({ activeItemId: null, columns: "not an array", defaultWidthPx: "nope" });

    const s = workspaceStore.getSnapshot();
    expect(s.columns).toEqual([]);
    expect(s.defaultWidthPx).toBe(SEED_WIDTH_PX);
  });

  test("carries persisted remembered tile sizes through repair", () => {
    hydrate({
      activeItemId: null,
      canvasTileSizes: { term: { w: 500, h: 400 }, doc: "garbage" },
    });

    expect(workspaceStore.getSnapshot().canvasTileSizes).toEqual({ term: { w: 500, h: 400 } });
  });
});

describe("rememberCanvasTileSize", () => {
  test("a resize teaches its bucket, snapped to the grid, and notifies", () => {
    let calls = 0;
    const unsubscribe = workspaceStore.subscribe(() => {
      calls++;
    });

    rememberCanvasTileSize("term", { w: 513, h: 487 });
    rememberCanvasTileSize("code", { w: 700, h: 900 });

    const s = workspaceStore.getSnapshot();
    expect(s.canvasTileSizes).toEqual({ term: { w: 520, h: 480 }, doc: { w: 700, h: 900 } });
    expect(calls).toBe(2);
    unsubscribe();
  });

  test("types outside both buckets, and no-op resizes, do not notify", () => {
    rememberCanvasTileSize("term", { w: 520, h: 480 });
    let calls = 0;
    const unsubscribe = workspaceStore.subscribe(() => {
      calls++;
    });

    rememberCanvasTileSize("tree", { w: 400, h: 600 });
    rememberCanvasTileSize("image", { w: 400, h: 600 });
    // Snaps to the same {520, 480} already taught above.
    rememberCanvasTileSize("term", { w: 513, h: 487 });

    expect(calls).toBe(0);
    expect(workspaceStore.getSnapshot().canvasTileSizes).toEqual({ term: { w: 520, h: 480 } });
    unsubscribe();
  });
});

describe("hideItem", () => {
  function seed(): void {
    hydrate({
      activeItemId: "i1",
      columns: [
        { id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] },
        { id: "c2", widthPx: 560, panes: [{ itemId: "i2", heightRatio: 1 }] },
      ],
    });
  }

  test("drops the pane and reassigns the active item spatially", () => {
    seed();
    hideItem("i1");
    const s = workspaceStore.getSnapshot();
    expect(s.columns.map((c) => c.panes[0]!.itemId)).toEqual(["i2"]);
    expect(s.activeItemId).toBe("i2"); // right neighbour's top pane
  });

  test("an id not on the rail is a no-op (same reference)", () => {
    seed();
    const before = workspaceStore.getSnapshot();
    hideItem("zz");
    expect(workspaceStore.getSnapshot()).toBe(before);
  });
});

describe("focusItem", () => {
  test("reveals an item not on the rail right of the focused column", () => {
    hydrate({
      activeItemId: "i1",
      columns: [
        { id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] },
        { id: "c2", widthPx: 560, panes: [{ itemId: "i3", heightRatio: 1 }] },
      ],
    });

    focusItem("i2");

    const s = workspaceStore.getSnapshot();
    expect(s.columns.map((c) => c.panes[0]!.itemId)).toEqual(["i1", "i2", "i3"]);
    expect(s.activeItemId).toBe("i2");
  });

  test("an item already on the rail just activates", () => {
    hydrate({
      activeItemId: "i1",
      columns: [
        { id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] },
        { id: "c2", widthPx: 560, panes: [{ itemId: "i2", heightRatio: 1 }] },
      ],
    });

    focusItem("i2");

    const s = workspaceStore.getSnapshot();
    expect(s.activeItemId).toBe("i2");
    expect(s.columns).toHaveLength(2); // no new column
  });
});

describe("setActiveItem", () => {
  test("ignores an id not on the rail", () => {
    hydrate({
      activeItemId: "i1",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] }],
    });

    setActiveItem("nonexistent");

    expect(workspaceStore.getSnapshot().activeItemId).toBe("i1");
  });

  test("activates a displayed id", () => {
    hydrate({
      activeItemId: "i1",
      columns: [
        { id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] },
        { id: "c2", widthPx: 560, panes: [{ itemId: "i2", heightRatio: 1 }] },
      ],
    });

    setActiveItem("i2");

    expect(workspaceStore.getSnapshot().activeItemId).toBe("i2");
  });

  test("does not notify subscribers when the id is already active", () => {
    hydrate({
      activeItemId: "i1",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] }],
    });
    let calls = 0;
    const unsubscribe = workspaceStore.subscribe(() => {
      calls++;
    });

    setActiveItem("i1");

    expect(calls).toBe(0);
    unsubscribe();
  });
});

describe("reconcile", () => {
  function seed(): void {
    hydrate({
      activeItemId: "i1",
      columns: [
        { id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] },
        { id: "c2", widthPx: 560, panes: [{ itemId: "i2", heightRatio: 1 }] },
      ],
    });
  }

  test("prunes panes the catalog no longer knows and clears a stale activeItemId", () => {
    seed();
    let calls = 0;
    const unsubscribe = workspaceStore.subscribe(() => {
      calls++;
    });

    reconcile(new Set(["i2"]));

    const s = workspaceStore.getSnapshot();
    expect(s.columns.map((c) => c.panes[0]!.itemId)).toEqual(["i2"]);
    expect(s.activeItemId).toBeNull();
    expect(calls).toBe(1);
    unsubscribe();
  });

  test("is a no-op (no notify) when every displayed item is still known", () => {
    seed();
    let calls = 0;
    const unsubscribe = workspaceStore.subscribe(() => {
      calls++;
    });

    reconcile(new Set(["i1", "i2"]));

    expect(calls).toBe(0);
    unsubscribe();
  });
});

describe("subscribe / getSnapshot contract", () => {
  test("subscribe fires once per mutation and stops after unsubscribe", () => {
    hydrate({
      activeItemId: "i1",
      columns: [
        { id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] },
        { id: "c2", widthPx: 560, panes: [{ itemId: "i2", heightRatio: 1 }] },
      ],
    });
    let calls = 0;
    const unsubscribe = workspaceStore.subscribe(() => {
      calls++;
    });

    hideItem("i1");
    expect(calls).toBe(1);

    setActiveItem("i1"); // not on the rail anymore — no-op
    expect(calls).toBe(1);

    unsubscribe();
    hideItem("i2");
    expect(calls).toBe(1);
  });

  test("getSnapshot is referentially stable between mutations", () => {
    hydrate({
      activeItemId: "i1",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] }],
    });
    const snapshot1 = workspaceStore.getSnapshot();
    const snapshot2 = workspaceStore.getSnapshot();
    expect(snapshot1).toBe(snapshot2);

    hideItem("i1");
    const snapshot3 = workspaceStore.getSnapshot();
    expect(snapshot3).not.toBe(snapshot1);
  });
});

describe("move / resize / focusDirection", () => {
  const twoColumns = (): void => {
    hydrate({
      activeItemId: "i1",
      columns: [
        { id: "c1", widthPx: 500, panes: [{ itemId: "i1", heightRatio: 1 }] },
        { id: "c2", widthPx: 400, panes: [{ itemId: "i2", heightRatio: 1 }] },
      ],
      defaultWidthPx: 560,
    });
  };

  test("moveItem stacks into a column", () => {
    twoColumns();
    moveItem("i1", { kind: "seam", columnId: "c2", seamIndex: 0 });
    const s = workspaceStore.getSnapshot();
    expect(s.columns).toHaveLength(1);
    expect(s.columns[0]!.panes.map((p) => p.itemId)).toEqual(["i1", "i2"]);
  });

  test("a sole pane expelled to a new rail slot keeps its column width", () => {
    twoColumns();
    moveItem("i1", { kind: "column", railIndex: 2 }); // swap right
    const s = workspaceStore.getSnapshot();
    expect(s.columns.map((c) => c.panes[0]!.itemId)).toEqual(["i2", "i1"]);
    expect(s.columns[1]!.widthPx).toBe(500); // kept, not defaultWidthPx
  });

  test("a stacked pane expelled to a new column takes defaultWidthPx", () => {
    hydrate({
      activeItemId: "i1",
      columns: [{ id: "c1", widthPx: 500, panes: [
        { itemId: "i1", heightRatio: 0.5 }, { itemId: "i2", heightRatio: 0.5 },
      ] }],
      defaultWidthPx: 560,
    });
    moveItem("i2", { kind: "column", railIndex: 1 });
    expect(workspaceStore.getSnapshot().columns[1]!.widthPx).toBe(560);
  });

  test("moveItem no-op (own seam) does not notify", () => {
    twoColumns();
    let notified = 0;
    const unsub = workspaceStore.subscribe(() => {
      notified++;
    });
    moveItem("i1", { kind: "column", railIndex: 0 });
    unsub();
    expect(notified).toBe(0);
  });

  test("resizeColumn clamps and updates defaultWidthPx", () => {
    twoColumns();
    resizeColumn("c2", 100);
    const s = workspaceStore.getSnapshot();
    expect(s.columns[1]!.widthPx).toBe(MIN_COLUMN_WIDTH_PX);
    expect(s.defaultWidthPx).toBe(MIN_COLUMN_WIDTH_PX);
  });

  test("resizePane shifts the seam", () => {
    hydrate({
      activeItemId: "i1",
      columns: [{ id: "c1", widthPx: 500, panes: [
        { itemId: "i1", heightRatio: 0.5 }, { itemId: "i2", heightRatio: 0.5 },
      ] }],
      defaultWidthPx: 560,
    });
    resizePane("c1", 0, 0.2);
    const s = workspaceStore.getSnapshot();
    expect(s.columns[0]!.panes[0]!.heightRatio).toBeCloseTo(0.7);
    expect(s.columns[0]!.panes[1]!.heightRatio).toBeCloseTo(0.3);
  });

  test("focusDirection moves focus across columns", () => {
    twoColumns();
    focusDirection("right");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("i2");
    focusDirection("right"); // at the edge — no-op
    expect(workspaceStore.getSnapshot().activeItemId).toBe("i2");
    focusDirection("left");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("i1");
  });
});

// ── Canvas view (spike: single device-only canvas alongside columns) ──
import { setActiveView, removeFromCanvas, syncCanvasTiles, unmountItem, setCanvasViewport } from "./workspace";
import { ZOOM_MAX } from "./canvas-ops";
import { onCanvasReveal } from "./canvas-reveal";

describe("canvas: hydrate", () => {
  test("defaults to columns view with an empty canvas", () => {
    hydrate({ activeItemId: null });
    const s = workspaceStore.getSnapshot();
    expect(s.activeView).toBe("columns");
    expect(s.canvasTiles).toEqual([]);
    expect(s.canvasViewport.zoom).toBe(1);
  });

  test("restores persisted canvas fields, repairing garbage", () => {
    hydrate({
      activeItemId: null,
      activeView: "canvas",
      canvasTiles: [
        { itemId: "a", x: 40, y: 40, w: 400, h: 520, z: 1 },
        { itemId: "bad", x: Number.NaN, y: 0, w: 400, h: 520, z: 1 },
      ],
      canvasViewport: { centerX: 10, centerY: 20, zoom: 99 },
    });
    const s = workspaceStore.getSnapshot();
    expect(s.activeView).toBe("canvas");
    expect(s.canvasTiles.map((t) => t.itemId)).toEqual(["a"]);
    expect(s.canvasViewport).toEqual({ centerX: 10, centerY: 20, zoom: ZOOM_MAX });
  });

  test("a canvas-tile item counts as mounted", () => {
    hydrate({
      activeItemId: null,
      canvasTiles: [{ itemId: "a", x: 40, y: 40, w: 400, h: 520, z: 1 }],
    });
    expect(workspaceStore.getSnapshot().mountedItemIds).toContain("a");
  });

  test("garbage activeView repairs to columns", () => {
    hydrate({ activeItemId: null, activeView: "sideways" });
    expect(workspaceStore.getSnapshot().activeView).toBe("columns");
  });
});

describe("canvas: setActiveView", () => {
  test("switches views and notifies once", () => {
    hydrate({ activeItemId: null });
    let calls = 0;
    const unsub = workspaceStore.subscribe(() => {
      calls++;
    });
    setActiveView("canvas");
    expect(workspaceStore.getSnapshot().activeView).toBe("canvas");
    expect(calls).toBe(1);
    setActiveView("canvas"); // no-op
    expect(calls).toBe(1);
    unsub();
  });
});

describe("canvas: focusItem places instead of inserting a column", () => {
  test("in canvas view, focusItem creates a tile, mounts and activates", () => {
    hydrate({ activeItemId: null, activeView: "canvas" });
    focusItem("t1", "term");
    const s = workspaceStore.getSnapshot();
    expect(s.columns).toHaveLength(0);
    const tile = s.canvasTiles.find((t) => t.itemId === "t1");
    expect(tile).toBeDefined();
    expect(tile!.w).toBe(600);
    expect(s.mountedItemIds).toContain("t1");
    expect(s.activeItemId).toBe("t1");
  });

  test("an item already on the canvas just activates, no duplicate tile", () => {
    hydrate({
      activeItemId: null,
      activeView: "canvas",
      canvasTiles: [{ itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 1 }],
    });
    focusItem("t1");
    const s = workspaceStore.getSnapshot();
    expect(s.canvasTiles).toHaveLength(1);
    expect(s.activeItemId).toBe("t1");
  });

  test("in columns view, focusItem still inserts a column and no tile", () => {
    hydrate({ activeItemId: null });
    focusItem("t1");
    const s = workspaceStore.getSnapshot();
    expect(s.columns).toHaveLength(1);
    expect(s.canvasTiles).toHaveLength(0);
  });
});

describe("canvas: setActiveItem accepts canvas-only ids", () => {
  test("an id with a canvas tile can be activated", () => {
    hydrate({
      activeItemId: null,
      canvasTiles: [{ itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 1 }],
    });
    setActiveItem("t1");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("t1");
  });
});

describe("canvas: hide / unmount", () => {
  const seed = (): void => {
    hydrate({
      activeItemId: "t1",
      activeView: "canvas",
      canvasTiles: [
        { itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 2 },
        { itemId: "t2", x: 500, y: 40, w: 400, h: 520, z: 1 },
      ],
      mountedItemIds: ["t1", "t2"],
    });
  };

  test("hideItem in canvas view removes the tile but keeps the item mounted", () => {
    seed();
    hideItem("t1");
    const s = workspaceStore.getSnapshot();
    expect(s.canvasTiles.map((t) => t.itemId)).toEqual(["t2"]);
    expect(s.mountedItemIds).toContain("t1");
    expect(s.activeItemId).toBe("t2");
  });

  test("hideItem in columns view leaves canvas tiles alone", () => {
    hydrate({
      activeItemId: "t1",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "t1", heightRatio: 1 }] }],
      canvasTiles: [{ itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 1 }],
    });
    hideItem("t1");
    const s = workspaceStore.getSnapshot();
    expect(s.columns).toHaveLength(0);
    expect(s.canvasTiles).toHaveLength(1);
  });

  test("unmountItem removes the canvas tile in any view", () => {
    hydrate({
      activeItemId: null,
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "t1", heightRatio: 1 }] }],
      canvasTiles: [{ itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 1 }],
    });
    unmountItem("t1");
    const s = workspaceStore.getSnapshot();
    expect(s.canvasTiles).toHaveLength(0);
    expect(s.mountedItemIds).not.toContain("t1");
  });

  test("removeFromCanvas drops the tile without touching mounts", () => {
    seed();
    removeFromCanvas("t2");
    const s = workspaceStore.getSnapshot();
    expect(s.canvasTiles.map((t) => t.itemId)).toEqual(["t1"]);
    expect(s.mountedItemIds).toContain("t2");
  });
});

describe("canvas: reconcile prunes tiles", () => {
  test("a tile whose item vanished from the catalog is dropped", () => {
    hydrate({
      activeItemId: null,
      canvasTiles: [
        { itemId: "keep", x: 40, y: 40, w: 400, h: 520, z: 1 },
        { itemId: "gone", x: 500, y: 40, w: 400, h: 520, z: 2 },
      ],
    });
    reconcile(new Set(["keep"]));
    expect(workspaceStore.getSnapshot().canvasTiles.map((t) => t.itemId)).toEqual(["keep"]);
  });
});

describe("canvas: geometry mutations", () => {
  const seed = (): void => {
    hydrate({
      activeItemId: null,
      canvasTiles: [
        { itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 1 },
        { itemId: "t2", x: 500, y: 40, w: 400, h: 520, z: 2 },
      ],
    });
  };




  test("setCanvasViewport stores the persisted center form", () => {
    seed();
    setCanvasViewport({ centerX: 123, centerY: -45, zoom: 0.5 });
    expect(workspaceStore.getSnapshot().canvasViewport).toEqual({
      centerX: 123,
      centerY: -45,
      zoom: 0.5,
    });
  });

  test("getPersistable carries the canvas fields", () => {
    seed();
    setActiveView("canvas");
    const p = workspaceStore.getPersistable();
    expect(p.activeView).toBe("canvas");
    expect(p.canvasTiles).toHaveLength(2);
    expect(p.canvasViewport).toBeDefined();
  });
});

describe("canvas: syncCanvasTiles (engine writeback)", () => {
  const seed = (): void => {
    hydrate({
      activeItemId: null,
      canvasTiles: [{ itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 1 }],
      mountedItemIds: ["t1"],
    });
  };

  test("replaces the tile list and notifies", () => {
    seed();
    let calls = 0;
    const unsub = workspaceStore.subscribe(() => {
      calls++;
    });
    syncCanvasTiles([
      { itemId: "t1", x: 100, y: 40, w: 400, h: 520, z: 1 },
      { itemId: "t2", x: 500, y: 40, w: 400, h: 520, z: 2 },
    ]);
    const s = workspaceStore.getSnapshot();
    expect(s.canvasTiles.map((t) => t.itemId)).toEqual(["t1", "t2"]);
    expect(s.canvasTiles[0]!.x).toBe(100);
    expect(calls).toBe(1);
    unsub();
  });

  test("a value-identical writeback does not notify", () => {
    seed();
    let calls = 0;
    const unsub = workspaceStore.subscribe(() => {
      calls++;
    });
    syncCanvasTiles([{ itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 1 }]);
    expect(calls).toBe(0);
    unsub();
  });

  test("a tile new to the store becomes mounted", () => {
    seed();
    syncCanvasTiles([
      { itemId: "t1", x: 40, y: 40, w: 400, h: 520, z: 1 },
      { itemId: "fresh", x: 500, y: 40, w: 400, h: 520, z: 2 },
    ]);
    expect(workspaceStore.getSnapshot().mountedItemIds).toContain("fresh");
  });
});

describe("canvas: focusItem emits a reveal signal", () => {
  test("fires for an already-placed item and for a fresh placement", () => {
    hydrate({
      activeItemId: null,
      activeView: "canvas",
      canvasTiles: [{ itemId: "placed", x: 40, y: 40, w: 400, h: 520, z: 1 }],
    });
    const revealed: string[] = [];
    const unsub = onCanvasReveal((id) => revealed.push(id));
    focusItem("placed");
    focusItem("fresh", "term");
    unsub();
    expect(revealed).toEqual(["placed", "fresh"]);
  });
});

describe("tree panes", () => {
  test("Up updates repo ownership and title without changing the pane's identity or persona", () => {
    acceptSnapshot(LOCAL_MACHINE_ID, { version: 1, epoch: "e", rev: 1,
      repos: [{ id: "repo", root: "/work/repo", name: "My project", managed: false, createdAt: "t" }], items: [],
    });
    const id = openTreePane({ root: "/work/repo/src", name: "src", repoId: "repo", personaId: "lead" });
    const before = workspaceStore.getSnapshot();
    navigateTreePaneUp(id);
    expect(workspaceStore.getSnapshot().treePanes[id]).toEqual({ root: "/work/repo", name: "My project", repoId: "repo", personaId: "lead" });
    navigateTreePaneUp(id);
    const after = workspaceStore.getSnapshot();
    expect(after.treePanes[id]).toEqual({ root: "/work", name: "work", repoId: null, personaId: "lead" });
    expect(after.columns).toBe(before.columns);
    expect(after.screens).toBe(before.screens);
    expect(after.canvasTiles).toBe(before.canvasTiles);
    expect(after.mountedItemIds).toBe(before.mountedItemIds);
    expect(after.activeItemId).toBe(id);
  });

  test("Up retains a cloud repo's routing prefix and becomes a no-op at that prefix", () => {
    acceptSnapshot("machine", { version: 1, epoch: "e", rev: 1,
      repos: [{ id: "repo", root: "/work/repo", name: "My project", managed: false, createdAt: "t" }], items: [],
    });
    const id = openTreePane({ root: "/@cloud/repo/src", name: "src", repoId: "repo" });
    navigateTreePaneUp(id);
    const atRoot = workspaceStore.getSnapshot();
    expect(atRoot.treePanes[id]).toEqual({ root: "/@cloud/repo/", name: "My project", repoId: "repo" });
    navigateTreePaneUp(id);
    navigateTreePaneUp("tree:closed");
    expect(workspaceStore.getSnapshot()).toBe(atRoot);
  });

  test("registerTreePane mounts and reuses by root and persona without changing placement", () => {
    hydrate({
      activeItemId: "prior", activeView: "screen:main",
      columns: [{ id: "legacy", widthPx: 450, panes: [{ itemId: "prior", heightRatio: 1 }] }],
      screens: [{ id: "main", name: "Main", columns: [
        { id: "column", widthRatio: 1, panes: [{ itemId: "prior", heightRatio: 1 }] },
      ] }],
    });
    const before = workspaceStore.getSnapshot();
    const record = { repoId: "r", root: "/r/app", name: "app", personaId: "lead" };
    const id = registerTreePane(record);
    expect(id.startsWith(TREE_PANE_ID_PREFIX)).toBe(true);
    expect(registerTreePane({ ...record, repoId: "alias" })).toBe(id);
    const other = registerTreePane({ ...record, personaId: "other" });
    const sidebar = registerTreePane({ repoId: "r", root: "/r/app", name: "app" });
    const nested = registerTreePane({ ...record, root: "/r/app/src" });
    expect(new Set([id, other, sidebar, nested]).size).toBe(4);
    const after = workspaceStore.getSnapshot();
    expect(after.treePanes[id]).toEqual(record);
    expect(Object.keys(after.treePanes)).toHaveLength(4);
    expect(after.mountedItemIds).toEqual([...before.mountedItemIds, id, other, sidebar, nested]);
    expect(after.screens).toEqual(before.screens);
    expect(after.columns).toEqual(before.columns);
    expect(after.canvasTiles).toEqual(before.canvasTiles);
    expect(after.activeItemId).toBe(before.activeItemId);
    expect(after.activeView).toBe(before.activeView);
  });

  test("tree roots are reused only within the same persona ownership", () => {
    hydrate({ activeItemId: null, columns: [] });
    const record = { repoId: "r", root: "/r/app", name: "app" };
    const sidebar = openTreePane(record);
    const persona = openTreePane({ ...record, personaId: "lead" });
    const other = openTreePane({ ...record, personaId: "other" });
    expect(new Set([sidebar, persona, other]).size).toBe(3);
    expect(openTreePane({ ...record, personaId: "lead" })).toBe(persona);
    hydrate({ activeItemId: null, columns: [], treePanes: workspaceStore.getSnapshot().treePanes });
    expect(workspaceStore.getSnapshot().treePanes[persona]?.personaId).toBe("lead");
  });
  test("openTreePane creates a tree: id, panes it, mounts it, and activates it", () => {
    hydrate({ activeItemId: null });
    const id = openTreePane({ repoId: "r1", root: "/repo", name: "repo" });
    const s = workspaceStore.getSnapshot();
    expect(id.startsWith(TREE_PANE_ID_PREFIX)).toBe(true);
    expect(s.treePanes[id]).toEqual({ repoId: "r1", root: "/repo", name: "repo" });
    expect(s.columns.some((c) => c.panes.some((p) => p.itemId === id))).toBe(true);
    expect(s.mountedItemIds).toContain(id);
    expect(s.activeItemId).toBe(id);
  });

  test("openTreePane dedups by exact root: focuses the existing pane", () => {
    hydrate({ activeItemId: null });
    const a = openTreePane({ repoId: "r1", root: "/repo", name: "repo" });
    const b = openTreePane({ repoId: "r1", root: "/repo/src", name: "src" });
    const again = openTreePane({ repoId: "r1", root: "/repo", name: "repo" });
    expect(again).toBe(a);
    expect(Object.keys(workspaceStore.getSnapshot().treePanes)).toHaveLength(2);
    expect(workspaceStore.getSnapshot().activeItemId).toBe(a);
    expect(b).not.toBe(a);
  });

  test("hideItem on a tree id closes it outright (record, pane, mount all gone)", () => {
    hydrate({ activeItemId: null });
    const id = openTreePane({ repoId: null, root: "/repo", name: "repo" });
    hideItem(id);
    const s = workspaceStore.getSnapshot();
    expect(s.treePanes[id]).toBeUndefined();
    expect(s.mountedItemIds).not.toContain(id);
    expect(s.columns.every((c) => c.panes.every((p) => p.itemId !== id))).toBe(true);
  });

  test("unmountItem on a tree id also closes it", () => {
    hydrate({ activeItemId: null });
    const id = openTreePane({ repoId: null, root: "/repo", name: "repo" });
    unmountItem(id);
    expect(workspaceStore.getSnapshot().treePanes[id]).toBeUndefined();
  });

  test("reconcile does not prune tree panes (they are not catalog items)", () => {
    hydrate({ activeItemId: null });
    const id = openTreePane({ repoId: null, root: "/repo", name: "repo" });
    reconcile(new Set(["some-catalog-item"]));
    const s = workspaceStore.getSnapshot();
    expect(s.columns.some((c) => c.panes.some((p) => p.itemId === id))).toBe(true);
  });

  test("hydrate repairs treePanes and reconcile prunes orphaned tree ids from columns", () => {
    hydrate({
      activeItemId: null,
      columns: [
        { id: "c1", widthPx: 400, panes: [{ itemId: "tree:orphan", heightRatio: 1 }] },
      ],
      treePanes: {
        "tree:ok": { repoId: "r1", root: "/repo", name: "repo" },
        "tree:bad-root": { repoId: "r1", root: 42, name: "x" },
        "not-a-tree-id": { repoId: null, root: "/x", name: "x" },
      },
    });
    const s = workspaceStore.getSnapshot();
    expect(Object.keys(s.treePanes)).toEqual(["tree:ok"]);
    // The orphan survives hydrate (hydrate has no item list to check) …
    expect(s.columns[0]!.panes[0]!.itemId).toBe("tree:orphan");
    // … and reconcile prunes it, because it is in neither the catalog nor treePanes.
    reconcile(new Set());
    expect(workspaceStore.getSnapshot().columns).toHaveLength(0);
  });

  test("openTreePane in canvas view places a tile instead of a column", () => {
    hydrate({ activeItemId: null, activeView: "canvas" });
    const id = openTreePane({ repoId: null, root: "/repo", name: "repo" });
    const s = workspaceStore.getSnapshot();
    expect(s.canvasTiles.some((t) => t.itemId === id)).toBe(true);
    expect(s.columns).toHaveLength(0);
  });

  test("a v4 hydrate input without treePanes reads as empty", () => {
    hydrate({ activeItemId: null });
    expect(workspaceStore.getSnapshot().treePanes).toEqual({});
  });

  test("closeTreePane in canvas view promotes the top remaining tile instead of nulling out", () => {
    // nextActiveAfterRemoval is columns-only, so a tile-only tree pane in
    // canvas view used to fall through to null instead of promoting "t2".
    const id = `${TREE_PANE_ID_PREFIX}t1`;
    hydrate({
      activeItemId: id,
      activeView: "canvas",
      canvasTiles: [
        { itemId: id, x: 40, y: 40, w: 400, h: 520, z: 2 },
        { itemId: "t2", x: 500, y: 40, w: 400, h: 520, z: 1 },
      ],
      treePanes: { [id]: { repoId: null, root: "/repo", name: "repo" } },
      mountedItemIds: [id, "t2"],
    });
    closeTreePane(id);
    const s = workspaceStore.getSnapshot();
    expect(s.activeItemId).toBe("t2");
  });
});

describe("screens: hydrate", () => {
  test("defaults to no screens", () => {
    hydrate({ activeItemId: null });
    expect(workspaceStore.getSnapshot().screens).toEqual([]);
  });
  test("restores screens through repair and keeps a screen view that exists", () => {
    hydrate({
      activeItemId: "a",
      activeView: "screen:s1",
      screens: [
        {
          id: "s1",
          name: "One",
          columns: [{ id: "c1", widthRatio: 1, panes: [{ itemId: "a", heightRatio: 1 }] }],
        },
      ],
    });
    const s = workspaceStore.getSnapshot();
    expect(s.activeView).toBe("screen:s1");
    expect(s.screens[0]!.name).toBe("One");
    expect(s.activeItemId).toBe("a");
    expect(s.mountedItemIds).toContain("a");
  });
  test("a screen view naming a missing screen falls back to columns", () => {
    hydrate({ activeItemId: null, activeView: "screen:ghost", screens: [] });
    expect(workspaceStore.getSnapshot().activeView).toBe("columns");
  });
  test("an unknown activeView string falls back to columns", () => {
    hydrate({ activeItemId: null, activeView: "sideways" });
    expect(workspaceStore.getSnapshot().activeView).toBe("columns");
  });
});

describe("screens: create / rename / close", () => {
  test("createScreen appends an unnamed screen, activates it, returns its id", () => {
    hydrate({ activeItemId: null });
    const id = createScreen();
    const s = workspaceStore.getSnapshot();
    expect(s.screens).toEqual([{ id, name: "", columns: [] }]);
    expect(s.activeView).toBe(screenView(id));
    expect(activeScreen(s)?.id).toBe(id);
    expect(createScreen()).toBe(id);
    focusItem("a");
    const id2 = createScreen();
    expect(workspaceStore.getSnapshot().screens[1]!.name).toBe("");
    expect(workspaceStore.getSnapshot().activeView).toBe(screenView(id2));
  });
  test("renameScreen trims and allows clearing; unknown id is a no-op", () => {
    hydrate({ activeItemId: null });
    const id = createScreen();
    renameScreen(id, "  Work  ");
    expect(workspaceStore.getSnapshot().screens[0]!.name).toBe("Work");
    renameScreen(id, "   ");
    expect(workspaceStore.getSnapshot().screens[0]!.name).toBe("");
    const before = workspaceStore.getSnapshot();
    renameScreen("nope", "x");
    expect(workspaceStore.getSnapshot()).toBe(before);
  });
  test("naming the trailing screen occupies it and a fresh spare appears to its right", () => {
    hydrate({ activeItemId: null });
    const id = createScreen();
    renameScreen(id, "Research");
    const screens = workspaceStore.getSnapshot().screens;
    expect(screens.map(screen => screen.name)).toEqual(["Research", ""]);
    expect(screens[0]!.id).toBe(id);
    // Clearing the name gives the spare back rather than keeping two.
    renameScreen(id, "");
    expect(workspaceStore.getSnapshot().screens.map(screen => screen.name)).toEqual(["", ""]);
  });
  test("closing the active screen shows its left neighbour, or a fresh screen if it was last", () => {
    hydrate({ activeItemId: null });
    const a = createScreen();
    focusItem("a");
    const b = createScreen();
    closeScreen(b);
    expect(workspaceStore.getSnapshot().activeView).toBe(screenView(a));
    closeScreen(a);
    expect(activeScreen(workspaceStore.getSnapshot())?.columns).toEqual([]);
    expect(workspaceStore.getSnapshot().screens).toHaveLength(1);
  });
  test("closing a non-active screen leaves the view alone", () => {
    hydrate({ activeItemId: null });
    const a = createScreen();
    focusItem("a");
    createScreen();
    setActiveView(screenView(a));
    const [, b] = workspaceStore.getSnapshot().screens;
    closeScreen(b!.id);
    expect(workspaceStore.getSnapshot().activeView).toBe(screenView(a));
  });
  test("closing a screen leaves mountedItemIds untouched", () => {
    hydrate({
      activeItemId: "a",
      activeView: "screen:s1",
      screens: [
        {
          id: "s1",
          name: "One",
          columns: [{ id: "c1", widthRatio: 1, panes: [{ itemId: "a", heightRatio: 1 }] }],
        },
      ],
    });
    closeScreen("s1");
    expect(workspaceStore.getSnapshot().mountedItemIds).toContain("a");
  });
});

describe("screens: setActiveView reassigns the active item", () => {
  const seed = (): void =>
    hydrate({
      activeItemId: "col-item",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "col-item", heightRatio: 1 }] }],
      canvasTiles: [{ itemId: "tile-item", x: 40, y: 40, w: 400, h: 520, z: 1 }],
      screens: [
        {
          id: "s1",
          name: "One",
          columns: [{ id: "sc1", widthRatio: 1, panes: [{ itemId: "scr-item", heightRatio: 1 }] }],
        },
        { id: "s2", name: "Two", columns: [] },
      ],
    });
  test("switching to a screen that doesn't place the active item picks its first pane", () => {
    seed();
    setActiveView("screen:s1");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("scr-item");
  });
  test("switching to an empty screen clears the active item", () => {
    seed();
    setActiveView("screen:s2");
    expect(workspaceStore.getSnapshot().activeItemId).toBeNull();
  });
  test("switching to canvas picks the top tile; back to columns picks the first pane", () => {
    seed();
    setActiveView("canvas");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("tile-item");
    setActiveView("columns");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("col-item");
  });
  test("an item placed on both views stays active across the switch", () => {
    hydrate({
      activeItemId: "both",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "both", heightRatio: 1 }] }],
      screens: [
        {
          id: "s1",
          name: "One",
          columns: [{ id: "sc1", widthRatio: 1, panes: [{ itemId: "both", heightRatio: 1 }] }],
        },
      ],
    });
    setActiveView("screen:s1");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("both");
  });
  test("a screen view naming no screen is ignored", () => {
    seed();
    const before = workspaceStore.getSnapshot();
    setActiveView("screen:ghost");
    expect(workspaceStore.getSnapshot()).toBe(before);
  });
});

describe("screens: an open lands on the screen in view", () => {
  afterEach(() => setScreenScrollPosition(null));
  for (const scrolled of [false, true]) {
    test(`sidebar travels to an existing placement while the rail ${scrolled ? "is mid-swipe" : "still shows the previous screen"}`, () => {
      hydrate({
        activeItemId: null,
        activeView: scrolled ? "screen:two" : "screen:one",
        screens: [
          { id: "one", name: "One", columns: [{ id: "c1", widthRatio: 1, panes: [{ itemId: "a", heightRatio: 1 }] }] },
          { id: "two", name: "Two", columns: [{ id: "c2", widthRatio: 1, panes: [{ itemId: "b", heightRatio: 1 }] }] },
        ],
      });
      setScreenScrollPosition({ fromId: "two", toId: "one", progress: scrolled ? 0.8 : 1 });
      showItem("b");
      const s = workspaceStore.getSnapshot();
      expect(s.activeView).toBe("screen:two");
      expect(s.activeItemId).toBe("b");
      expect(takeInstantScreenNavigation()).toBe("two");
      expect(s.screens.flatMap(screen => screen.columns.flatMap(c => c.panes)).filter(p => p.itemId === "b")).toHaveLength(1);

      // Explicit "Open here" still places it on the physically visible screen.
      focusItem("b");
      expect(workspaceStore.getSnapshot().activeView).toBe("screen:one");
      expect(activeScreen(workspaceStore.getSnapshot())!.columns.flatMap(c => c.panes.map(p => p.itemId))).toEqual(["a", "b"]);
    });
  }
  test("a rail scrolled to another screen takes the open there, and the view follows", () => {
    hydrate({
      activeItemId: null,
      activeView: "screen:one",
      screens: [
        { id: "one", name: "One", columns: [{ id: "c1", widthRatio: 1, panes: [{ itemId: "a", heightRatio: 1 }] }] },
        { id: "two", name: "", columns: [] },
      ],
    });
    setScreenScrollPosition({ fromId: "one", toId: "two", progress: 0.8 });
    focusItem("x");
    const s = workspaceStore.getSnapshot();
    expect(s.activeView).toBe("screen:two");
    expect(s.screens.find(screen => screen.id === "two")!.columns.flatMap(c => c.panes.map(p => p.itemId))).toEqual(["x"]);
    expect(s.screens.find(screen => screen.id === "one")!.columns.flatMap(c => c.panes.map(p => p.itemId))).toEqual(["a"]);
  });
  test("a scroll nearer the screen it left keeps the open on the active screen", () => {
    hydrate({
      activeItemId: null,
      activeView: "screen:one",
      screens: [
        { id: "one", name: "One", columns: [{ id: "c1", widthRatio: 1, panes: [{ itemId: "a", heightRatio: 1 }] }] },
        { id: "two", name: "", columns: [] },
      ],
    });
    setScreenScrollPosition({ fromId: "one", toId: "two", progress: 0.2 });
    focusItem("x");
    expect(workspaceStore.getSnapshot().activeView).toBe("screen:one");
  });
});

describe("screens: mutations on the active screen", () => {
  const seed = (): string => {
    hydrate({ activeItemId: null });
    return createScreen();
  };
  test("focusItem places a new column right of the focused one and mounts it", () => {
    seed();
    focusItem("a");
    focusItem("b");
    const s = workspaceStore.getSnapshot();
    expect(activeScreen(s)!.columns.map((c) => c.panes[0]!.itemId)).toEqual(["a", "b"]);
    expect(activeScreen(s)!.columns.map((c) => c.widthRatio)).toEqual([0.5, 0.5]);
    expect(s.mountedItemIds).toEqual(["a", "b"]);
    expect(s.activeItemId).toBe("b");
    expect(s.columns).toEqual([]); // the Columns rail is another view's business
  });
  test("focusItem on an item already on the screen just activates it", () => {
    seed();
    focusItem("a");
    focusItem("b");
    focusItem("a");
    const s = workspaceStore.getSnapshot();
    expect(activeScreen(s)!.columns).toHaveLength(2);
    expect(s.activeItemId).toBe("a");
  });
  test("hideItem removes its current placement and keeps other placements mounted", () => {
    const id = seed();
    focusItem("a");
    createScreen();
    focusItem("a");
    hideItem("a");
    const s = workspaceStore.getSnapshot();
    expect(activeScreen(s)!.columns).toEqual([]);
    expect(s.screens.find((x) => x.id === id)!.columns.flatMap(c => c.panes.map(p => p.itemId))).toEqual(["a"]);
    expect(s.mountedItemIds).toContain("a");
    expect(s.activeItemId).toBeNull();
  });
  test("hideItem picks the spatial next-active on the screen", () => {
    seed();
    focusItem("a");
    focusItem("b");
    hideItem("b");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("a");
  });
  test("moveItem moves within the screen", () => {
    seed();
    focusItem("a");
    focusItem("b");
    const [c1] = activeScreen(workspaceStore.getSnapshot())!.columns;
    moveItem("b", { kind: "seam", columnId: c1!.id, seamIndex: 1 });
    const cols = activeScreen(workspaceStore.getSnapshot())!.columns;
    expect(cols).toHaveLength(1);
    expect(cols[0]!.panes.map((p) => p.itemId)).toEqual(["a", "b"]);
    expect(cols[0]!.widthRatio).toBe(1);
  });
  test("resizeScreenDivider writes ratios and never touches defaultWidthPx", () => {
    seed();
    focusItem("a");
    focusItem("b");
    const before = workspaceStore.getSnapshot().defaultWidthPx;
    const [c1] = activeScreen(workspaceStore.getSnapshot())!.columns;
    resizeScreenDivider(c1!.id, 0.2);
    const s = workspaceStore.getSnapshot();
    expect(activeScreen(s)!.columns.map((c) => c.widthRatio)).toEqual([0.7, 0.3]);
    expect(s.defaultWidthPx).toBe(before);
  });
  test("resizeScreenDivider is a no-op off a screen", () => {
    hydrate({
      activeItemId: null,
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "a", heightRatio: 1 }] }],
    });
    const before = workspaceStore.getSnapshot();
    resizeScreenDivider("c1", 0.2);
    expect(workspaceStore.getSnapshot()).toBe(before);
  });
  test("unmountItem clears the id from every screen and from mounts", () => {
    const first = seed();
    focusItem("a");
    createScreen();
    focusItem("a");
    unmountItem("a");
    const s = workspaceStore.getSnapshot();
    expect(s.screens.every((x) => x.columns.length === 0)).toBe(true);
    expect(s.screens.map((x) => x.id)).toContain(first);
    expect(s.mountedItemIds).not.toContain("a");
  });
  test("closeTreePane removes the tree pane from every screen", () => {
    seed();
    const id = openTreePane({ repoId: "r", root: "/r", name: "r" });
    createScreen();
    focusItem(id, "tree");
    closeTreePane(id);
    const s = workspaceStore.getSnapshot();
    expect(s.screens.every((x) => x.columns.length === 0)).toBe(true);
    expect(s.treePanes[id]).toBeUndefined();
  });
  test("reconcile prunes unknown items from screens", () => {
    seed();
    focusItem("a");
    focusItem("b");
    reconcile(new Set(["a"]));
    const cols = activeScreen(workspaceStore.getSnapshot())!.columns;
    expect(cols.map((c) => c.panes[0]!.itemId)).toEqual(["a"]);
  });
  test("focusDirection walks the screen's columns", () => {
    seed();
    focusItem("a");
    focusItem("b");
    focusDirection("left");
    expect(workspaceStore.getSnapshot().activeItemId).toBe("a");
  });
});

describe("displayedItemIds", () => {
  test("follows the showing view", () => {
    hydrate({
      activeItemId: null,
      activeView: "screen:s1",
      columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "col", heightRatio: 1 }] }],
      canvasTiles: [{ itemId: "tile", x: 0, y: 0, w: 400, h: 400, z: 1 }],
      screens: [{ id: "s1", name: "One", columns: [{ id: "sc", widthRatio: 1, panes: [{ itemId: "scr", heightRatio: 1 }] }] }],
    });
    expect([...displayedItemIds(workspaceStore.getSnapshot())]).toEqual(["scr"]);
    setActiveView("columns");
    expect([...displayedItemIds(workspaceStore.getSnapshot())]).toEqual(["col"]);
    setActiveView("canvas");
    expect([...displayedItemIds(workspaceStore.getSnapshot())]).toEqual(["tile"]);
  });
});

describe("reorderScreen", () => {
  const withPanes = (id: string, itemId: string): Screen => ({
    id, name: "", columns: [{ id: `${id}-col`, widthRatio: 1, panes: [{ itemId, heightRatio: 1 }] }],
  });

  test("moves a screen before the spare and asks the rail to cut to the active screen", () => {
    hydrate({
      activeItemId: "b1",
      activeView: "screen:b",
      screens: [withPanes("a", "a1"), withPanes("b", "b1"), { id: "spare", name: "", columns: [] }],
    });
    takeInstantScreenNavigation();
    expect(reorderScreen("a", 1)).toBe(true);
    expect(workspaceStore.getSnapshot().screens.map((screen) => screen.id)).toEqual(["b", "a", "spare"]);
    expect(workspaceStore.getSnapshot().activeView).toBe("screen:b");
    expect(takeInstantScreenNavigation()).toBe("b");
  });

  test("refuses to move the spare or to land on or after it", () => {
    hydrate({
      activeItemId: "a1",
      activeView: "screen:a",
      screens: [withPanes("a", "a1"), withPanes("b", "b1"), { id: "spare", name: "", columns: [] }],
    });
    expect(reorderScreen("spare", 0)).toBe(false);
    expect(reorderScreen("a", 2)).toBe(false);
    expect(workspaceStore.getSnapshot().screens.map((screen) => screen.id)).toEqual(["a", "b", "spare"]);
  });

  test("validates against the live store: a screen the timer turned into the spare cannot move", () => {
    hydrate({
      activeItemId: null,
      activeView: "screen:x",
      screens: [withPanes("a", "a1"), { id: "x", name: "", columns: [] }],
    });
    // x is now the trailing empty screen, i.e. the spare, as if the empty-screen
    // timer had closed the old spare while x was being dragged.
    expect(reorderScreen("x", 0)).toBe(false);
  });

  test("an unknown screen does nothing", () => {
    hydrateScreens({ activeItemId: null });
    expect(reorderScreen("nope", 0)).toBe(false);
  });
});
