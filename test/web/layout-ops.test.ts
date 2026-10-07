// Adapted from src/windows/app/src/state/layout-ops.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import {
  normalizeRatios, columnOf, insertPane, removePane, movePane,
  nextActiveAfterRemoval, focusTarget, keyboardMoveTarget,
  resizeColumnWidth, resizePaneRatio, MIN_PANE_RATIO,
  railGeometry, minimalScrollLeft, resolveDropTarget, repairLayout,
  reconcileColumns,
  EDGE_ZONE_PX, SEED_WIDTH_PX,
  type Column, type WorkspaceState,
} from "../../src/web/state/layout-ops";

const col = (id: string, widthPx: number, ...itemIds: string[]): Column => ({
  id, widthPx,
  panes: itemIds.map((itemId) => ({ itemId, heightRatio: 1 / itemIds.length })),
});
const ratios = (c: Column) => c.panes.map((p) => p.heightRatio);
const ids = (c: Column) => c.panes.map((p) => p.itemId);

describe("normalizeRatios", () => {
  test("empty stays empty", () => {
    expect(normalizeRatios([])).toEqual([]);
  });
  test("divides by the sum", () => {
    const out = normalizeRatios([{ itemId: "a", heightRatio: 1 }, { itemId: "b", heightRatio: 3 }]);
    expect(out.map((p) => p.heightRatio)).toEqual([0.25, 0.75]);
  });
  test("any non-positive or non-finite ratio → equal split", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = normalizeRatios([{ itemId: "a", heightRatio: bad }, { itemId: "b", heightRatio: 1 }]);
      expect(out.map((p) => p.heightRatio)).toEqual([0.5, 0.5]);
    }
  });
});

describe("columnOf", () => {
  const cols = [col("c1", 560, "a"), col("c2", 560, "b", "c")];
  test("finds column and pane index", () => {
    expect(columnOf(cols, "c")).toEqual({ colIdx: 1, paneIdx: 1 });
  });
  test("null for unknown item", () => {
    expect(columnOf(cols, "zz")).toBeNull();
  });
});

describe("insertPane", () => {
  test("column target splices a single-pane column at railIndex", () => {
    const cols = [col("c1", 560, "a"), col("c2", 560, "b")];
    const out = insertPane(cols, "x", { kind: "column", railIndex: 1 }, { id: "c3", widthPx: 400 });
    expect(out.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
    expect(out[1]).toEqual({ id: "c3", widthPx: 400, panes: [{ itemId: "x", heightRatio: 1 }] });
    expect(cols).toHaveLength(2); // input not mutated
  });
  test("column railIndex clamps to [0, length]", () => {
    const cols = [col("c1", 560, "a")];
    expect(insertPane(cols, "x", { kind: "column", railIndex: 99 }, { id: "c2", widthPx: 560 })
      .map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(insertPane(cols, "x", { kind: "column", railIndex: -5 }, { id: "c2", widthPx: 560 })
      .map((c) => c.id)).toEqual(["c2", "c1"]);
  });
  test("seam target: new pane gets 1/n, others scale by (n-1)/n", () => {
    const cols = [col("c1", 560, "a")]; // a at ratio 1
    const out = insertPane(cols, "x", { kind: "seam", columnId: "c1", seamIndex: 1 }, { id: "unused", widthPx: 0 });
    expect(ids(out[0]!)).toEqual(["a", "x"]);
    expect(ratios(out[0]!)).toEqual([0.5, 0.5]);
  });
  test("seam preserves proportion among existing panes", () => {
    const cols: Column[] = [{ id: "c1", widthPx: 560, panes: [
      { itemId: "a", heightRatio: 0.75 }, { itemId: "b", heightRatio: 0.25 },
    ] }];
    const out = insertPane(cols, "x", { kind: "seam", columnId: "c1", seamIndex: 0 }, { id: "u", widthPx: 0 });
    expect(ids(out[0]!)).toEqual(["x", "a", "b"]);
    const [x, a, b] = ratios(out[0]!) as [number, number, number];
    expect(x).toBeCloseTo(1 / 3);
    expect(a).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(1 / 6);
  });
  test("unknown seam columnId returns the same reference", () => {
    const cols = [col("c1", 560, "a")];
    expect(insertPane(cols, "x", { kind: "seam", columnId: "nope", seamIndex: 0 }, { id: "u", widthPx: 0 })).toBe(cols);
  });
});

describe("removePane", () => {
  test("removes and renormalizes survivors", () => {
    const cols: Column[] = [{ id: "c1", widthPx: 560, panes: [
      { itemId: "a", heightRatio: 0.5 }, { itemId: "b", heightRatio: 0.25 }, { itemId: "c", heightRatio: 0.25 },
    ] }];
    const out = removePane(cols, "a");
    expect(ids(out[0]!)).toEqual(["b", "c"]);
    expect(ratios(out[0]!)).toEqual([0.5, 0.5]);
  });
  test("prunes a column emptied by the removal", () => {
    const cols = [col("c1", 560, "a"), col("c2", 560, "b")];
    expect(removePane(cols, "a").map((c) => c.id)).toEqual(["c2"]);
  });
  test("unknown item returns the same reference", () => {
    const cols = [col("c1", 560, "a")];
    expect(removePane(cols, "zz")).toBe(cols);
  });
});

describe("movePane", () => {
  test("stack a sole pane into a neighbour column (its column prunes)", () => {
    const cols = [col("c1", 560, "a"), col("c2", 560, "b")];
    const out = movePane(cols, "a", { kind: "seam", columnId: "c2", seamIndex: 1 }, { id: "u", widthPx: 0 });
    expect(out.map((c) => c.id)).toEqual(["c2"]);
    expect(ids(out[0]!)).toEqual(["b", "a"]);
    expect(ratios(out[0]!)).toEqual([0.5, 0.5]);
  });
  test("expel a stacked pane to its own column", () => {
    const cols = [col("c1", 560, "a", "b")];
    const out = movePane(cols, "b", { kind: "column", railIndex: 1 }, { id: "c2", widthPx: 400 });
    expect(out.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(ratios(out[0]!)).toEqual([1]);
    expect(out[1]!.widthPx).toBe(400);
  });
  test("same-column reorder adjusts the seam for the removal", () => {
    const cols = [col("c1", 560, "a", "b", "c")];
    // drag "a" to the seam below "b" (seamIndex 2 in the pre-move array)
    const out = movePane(cols, "a", { kind: "seam", columnId: "c1", seamIndex: 2 }, { id: "u", widthPx: 0 });
    expect(ids(out[0]!)).toEqual(["b", "a", "c"]);
  });
  test("dropping a pane onto its own seams is a no-op (same reference)", () => {
    const cols = [col("c1", 560, "a", "b")];
    expect(movePane(cols, "a", { kind: "seam", columnId: "c1", seamIndex: 0 }, { id: "u", widthPx: 0 })).toBe(cols);
    expect(movePane(cols, "a", { kind: "seam", columnId: "c1", seamIndex: 1 }, { id: "u", widthPx: 0 })).toBe(cols);
  });
  test("sole pane to its own rail position is a no-op (same reference)", () => {
    const cols = [col("c1", 560, "a"), col("c2", 560, "b")];
    expect(movePane(cols, "a", { kind: "column", railIndex: 0 }, { id: "u", widthPx: 0 })).toBe(cols);
    expect(movePane(cols, "a", { kind: "column", railIndex: 1 }, { id: "u", widthPx: 0 })).toBe(cols);
  });
  test("sole pane swaps right when railIndex is past its own slot", () => {
    const cols = [col("c1", 560, "a"), col("c2", 560, "b")];
    const out = movePane(cols, "a", { kind: "column", railIndex: 2 }, { id: "c3", widthPx: 560 });
    expect(out.map((c) => ids(c)[0])).toEqual(["b", "a"]);
  });
  test("unknown item / unknown seam column return the same reference", () => {
    const cols = [col("c1", 560, "a")];
    expect(movePane(cols, "zz", { kind: "column", railIndex: 0 }, { id: "u", widthPx: 0 })).toBe(cols);
    expect(movePane(cols, "a", { kind: "seam", columnId: "nope", seamIndex: 0 }, { id: "u", widthPx: 0 })).toBe(cols);
  });
});

describe("nextActiveAfterRemoval", () => {
  const cols = [col("c1", 560, "a"), col("c2", 560, "b", "c", "d"), col("c3", 560, "e")];
  test("below in the same column wins", () => {
    expect(nextActiveAfterRemoval(cols, "c")).toBe("d");
  });
  test("above when nothing below", () => {
    expect(nextActiveAfterRemoval(cols, "d")).toBe("c");
  });
  test("right column's top pane when the column empties", () => {
    expect(nextActiveAfterRemoval(cols, "a")).toBe("b");
  });
  test("left column's top pane at the rail's right end", () => {
    expect(nextActiveAfterRemoval(cols, "e")).toBe("b");
  });
  test("null for the only pane on the rail / unknown item", () => {
    expect(nextActiveAfterRemoval([col("c1", 560, "a")], "a")).toBeNull();
    expect(nextActiveAfterRemoval(cols, "zz")).toBeNull();
  });
});

describe("focusTarget", () => {
  const cols = [col("c1", 560, "a"), col("c2", 560, "b", "c")];
  test("up/down within the column, null at edges", () => {
    expect(focusTarget(cols, "c", "up")).toBe("b");
    expect(focusTarget(cols, "b", "down")).toBe("c");
    expect(focusTarget(cols, "b", "up")).toBeNull();
    expect(focusTarget(cols, "c", "down")).toBeNull();
  });
  test("left/right land on the neighbour column's top pane", () => {
    expect(focusTarget(cols, "c", "left")).toBe("a");
    expect(focusTarget(cols, "a", "right")).toBe("b");
    expect(focusTarget(cols, "a", "left")).toBeNull();
  });
  test("null for an item not on the rail", () => {
    expect(focusTarget(cols, "zz", "left")).toBeNull();
  });
});

describe("keyboardMoveTarget", () => {
  test("up/down swap within a column, null at edges", () => {
    const cols = [col("c1", 560, "a", "b")];
    expect(keyboardMoveTarget(cols, "b", "up")).toEqual({
      kind: "seam",
      columnId: "c1",
      seamIndex: 0,
    });
    expect(keyboardMoveTarget(cols, "a", "down")).toEqual({
      kind: "seam",
      columnId: "c1",
      seamIndex: 2,
    });
    expect(keyboardMoveTarget(cols, "a", "up")).toBeNull();
    expect(keyboardMoveTarget(cols, "b", "down")).toBeNull();
  });
  test("sole pane left/right = column swap; edge = null", () => {
    const cols = [col("c1", 560, "a"), col("c2", 560, "b")];
    expect(keyboardMoveTarget(cols, "b", "left")).toEqual({
      kind: "column",
      railIndex: 0,
    });
    expect(keyboardMoveTarget(cols, "a", "right")).toEqual({
      kind: "column",
      railIndex: 2,
    });
    expect(keyboardMoveTarget(cols, "a", "left")).toBeNull();
    expect(keyboardMoveTarget(cols, "b", "right")).toBeNull();
  });
  test("stacked pane left/right = expel to own column", () => {
    const cols = [col("c1", 560, "a", "b")];
    expect(keyboardMoveTarget(cols, "b", "left")).toEqual({
      kind: "column",
      railIndex: 0,
    });
    expect(keyboardMoveTarget(cols, "b", "right")).toEqual({
      kind: "column",
      railIndex: 1,
    });
  });
});

describe("resizeColumnWidth", () => {
  const cols = [col("c1", 560, "a")];
  test("sets and rounds the width", () => {
    expect(resizeColumnWidth(cols, "c1", 300.6)[0]!.widthPx).toBe(301);
  });
  test("clamps to MIN_COLUMN_WIDTH_PX", () => {
    expect(resizeColumnWidth(cols, "c1", 10)[0]!.widthPx).toBe(240);
  });
  test("unknown column / unchanged width → same reference", () => {
    expect(resizeColumnWidth(cols, "nope", 300)).toBe(cols);
    expect(resizeColumnWidth(cols, "c1", 560)).toBe(cols);
  });
});

describe("resizePaneRatio", () => {
  test("transfers ratio between the seam's two neighbours only", () => {
    const cols = [col("c1", 560, "a", "b", "c")]; // thirds
    const out = resizePaneRatio(cols, "c1", 0, 0.1);
    const [a, b, c] = ratios(out[0]!) as [number, number, number];
    expect(a).toBeCloseTo(1 / 3 + 0.1);
    expect(b).toBeCloseTo(1 / 3 - 0.1);
    expect(c).toBeCloseTo(1 / 3);
  });
  test("clamps so neither neighbour drops below MIN_PANE_RATIO", () => {
    const cols = [col("c1", 560, "a", "b")]; // halves
    const out = resizePaneRatio(cols, "c1", 0, 0.9);
    const [a, b] = ratios(out[0]!) as [number, number];
    expect(b).toBeCloseTo(MIN_PANE_RATIO);
    expect(a).toBeCloseTo(1 - MIN_PANE_RATIO);
  });
  test("invalid seam / column / no-op delta → same reference", () => {
    const cols = [col("c1", 560, "a", "b")];
    expect(resizePaneRatio(cols, "c1", 5, 0.1)).toBe(cols);
    expect(resizePaneRatio(cols, "nope", 0, 0.1)).toBe(cols);
    expect(resizePaneRatio(cols, "c1", 0, 0)).toBe(cols);
  });
});

describe("railGeometry", () => {
  test("tiles columns and panes", () => {
    const cols = [col("c1", 500, "a"), col("c2", 300, "b", "c")];
    const { rects, totalWidthPx } = railGeometry(cols);
    expect(totalWidthPx).toBe(800);
    expect(rects).toEqual([
      {
        itemId: "a", columnId: "c1", leftPx: 0, widthPx: 500,
        topFr: 0, heightFr: 1,
      },
      {
        itemId: "b", columnId: "c2", leftPx: 500, widthPx: 300,
        topFr: 0, heightFr: 0.5,
      },
      {
        itemId: "c", columnId: "c2", leftPx: 500, widthPx: 300,
        topFr: 0.5, heightFr: 0.5,
      },
    ]);
  });
});

describe("minimalScrollLeft", () => {
  test("no scroll when fully visible", () => {
    expect(minimalScrollLeft(100, 1000, 200, 500)).toBe(100);
  });
  test("scrolls left just enough", () => {
    expect(minimalScrollLeft(300, 1000, 200, 500)).toBe(200);
  });
  test("scrolls right just enough", () => {
    expect(minimalScrollLeft(0, 1000, 800, 500)).toBe(300);
  });
  test("column wider than viewport aligns left", () => {
    expect(minimalScrollLeft(0, 400, 200, 800)).toBe(200);
  });
});

describe("resolveDropTarget", () => {
  const cols = [
    col("c1", 500, "a"),
    col("c2", 500, "b", "c"),
  ];
  test("empty rail → first column", () => {
    expect(resolveDropTarget([], 123, 0.5)).toEqual({
      target: { kind: "column", railIndex: 0 },
      indicator: { kind: "column", leftPx: 0 },
    });
  });
  test("near a column boundary → column target", () => {
    expect(resolveDropTarget(cols, 500 + EDGE_ZONE_PX - 1, 0.5)!.target)
      .toEqual({ kind: "column", railIndex: 1 });
    expect(resolveDropTarget(cols, 500 - EDGE_ZONE_PX + 1, 0.5)!.target)
      .toEqual({ kind: "column", railIndex: 1 });
  });
  test("past the rail's right end → append column", () => {
    expect(resolveDropTarget(cols, 1200, 0.5)!.target)
      .toEqual({ kind: "column", railIndex: 2 });
  });
  test("column interior: top half → seam above, bottom half → seam below", () => {
    expect(resolveDropTarget(cols, 750, 0.1)!.target)
      .toEqual({ kind: "seam", columnId: "c2", seamIndex: 0 });
    expect(resolveDropTarget(cols, 750, 0.4)!.target)
      .toEqual({ kind: "seam", columnId: "c2", seamIndex: 1 });
    expect(resolveDropTarget(cols, 750, 0.9)!.target)
      .toEqual({ kind: "seam", columnId: "c2", seamIndex: 2 });
  });
  test("seam indicator spans the column at the seam's y", () => {
    const { indicator } = resolveDropTarget(cols, 750, 0.4)!;
    expect(indicator).toEqual({
      kind: "seam", leftPx: 500, widthPx: 500, topFr: 0.5,
    });
  });
});

describe("repairLayout", () => {
  const nextId = (() => { let n = 0; return () => `gen-${++n}`; })();
  const items = [{ id: "a" }, { id: "b" }, { id: "h", hidden: true }];
  test("valid layout passes through, hidden stays out", () => {
    const cols = [col("c1", 500, "a"), col("c2", 500, "b")];
    const out = repairLayout(cols, 480, items, nextId);
    expect(out.columns).toEqual(cols);
    expect(out.defaultWidthPx).toBe(480);
    expect(out.unhide).toEqual([]);
  });
  test("garbage in → every non-hidden item gets a column", () => {
    const out = repairLayout("not an array", "nope", items, nextId);
    expect(out.defaultWidthPx).toBe(SEED_WIDTH_PX);
    expect(out.columns.map((c) => c.panes[0]!.itemId)).toEqual(["a", "b"]);
    expect(out.columns.every((c) => c.widthPx === SEED_WIDTH_PX)).toBe(true);
  });
  test("unknown refs and duplicates drop; orphaned non-hidden items re-column", () => {
    const raw = [col("c1", 500, "a", "zz"), col("c2", 500, "a")];
    const out = repairLayout(raw, 500, items, nextId);
    expect(out.columns[0]!.panes).toEqual([{ itemId: "a", heightRatio: 1 }]);
    expect(out.columns).toHaveLength(2); // c1(a) + generated column for b
    expect(out.columns[1]!.panes[0]!.itemId).toBe("b");
  });
  test("a pane referencing a hidden item wins — reported in unhide", () => {
    const raw = [
      col("c1", 500, "a"),
      col("c2", 500, "b"),
      col("c3", 500, "h"),
    ];
    const out = repairLayout(raw, 500, items, nextId);
    expect(out.unhide).toEqual(["h"]);
    expect(out.columns).toHaveLength(3);
  });
  test("bad ratios equal-split; bad widths take the default", () => {
    const raw = [{
      id: "c1",
      widthPx: -5,
      panes: [
        { itemId: "a", heightRatio: Number.NaN },
        { itemId: "b", heightRatio: 2 },
      ],
    }];
    const out = repairLayout(raw, 400, [
      { id: "a" },
      { id: "b" },
    ], nextId);
    expect(out.columns[0]!.widthPx).toBe(400);
    expect(ratios(out.columns[0]!)).toEqual([0.5, 0.5]);
  });
});

describe("reconcileColumns", () => {
  test("drops slots whose items the catalog no longer has", () => {
    const state: WorkspaceState = {
      columns: [col("c1", 400, "gone", "kept")],
      activeItemId: "kept",
      defaultWidthPx: 400,
      mountedItemIds: ["gone", "kept"],
    };
    const next = reconcileColumns(state, new Set(["kept"]));
    expect(ids(next.columns[0]!)).toEqual(["kept"]);
    expect(next.columns[0]!.panes[0]!.heightRatio).toBe(1);
  });

  test("clears activeItemId when its item is gone", () => {
    const state: WorkspaceState = {
      columns: [col("c1", 400, "gone")],
      activeItemId: "gone",
      defaultWidthPx: 400,
      mountedItemIds: ["gone"],
    };
    expect(reconcileColumns(state, new Set()).activeItemId).toBeNull();
  });

  test("drops a column that loses every pane", () => {
    const state: WorkspaceState = {
      columns: [col("c1", 400, "gone"), col("c2", 400, "kept")],
      activeItemId: "kept",
      defaultWidthPx: 400,
      mountedItemIds: ["gone", "kept"],
    };
    expect(reconcileColumns(state, new Set(["kept"])).columns).toHaveLength(1);
  });

  test("prunes a mounted-but-unpaned id the catalog no longer has", () => {
    const state: WorkspaceState = {
      columns: [col("c1", 400, "kept")],
      activeItemId: "kept",
      defaultWidthPx: 400,
      mountedItemIds: ["kept", "hidden-and-gone"],
    };
    expect(reconcileColumns(state, new Set(["kept"])).mountedItemIds).toEqual(["kept"]);
  });

  test("returns the same object when nothing changed", () => {
    const state: WorkspaceState = {
      columns: [col("c1", 400, "kept")],
      activeItemId: "kept",
      defaultWidthPx: 400,
      mountedItemIds: ["kept"],
    };
    // Identity matters: this runs on every accepted snapshot, and a new
    // object each time would re-render the whole rail on every heartbeat.
    expect(reconcileColumns(state, new Set(["kept"]))).toBe(state);
  });
});
