// Adapted from src/windows/app/src/state/screen-ops.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import {
  MIN_COLUMN_RATIO,
  automaticScreenTarget,
  insertScreenPane,
  moveScreen,
  moveScreenPane,
  nearestScreenPlacing,
  normalizeWidthRatios,
  reconcileScreens,
  removeFromAllScreens,
  removeScreenPane,
  repairScreens,
  resizeScreenDivider,
  screenToPixelColumns,
  type Screen,
} from "../../src/web/state/screen-ops";

const sum = (s: Screen): number => s.columns.reduce((acc, c) => acc + c.widthRatio, 0);

function screen(...ratios: number[]): Screen {
  return {
    id: "scr-1",
    name: "Screen 1",
    columns: ratios.map((r, i) => ({
      id: `c${i + 1}`,
      widthRatio: r,
      panes: [{ itemId: `i${i + 1}`, heightRatio: 1 }],
    })),
  };
}

describe("normalizeWidthRatios", () => {
  test("scales ratios to sum to 1", () => {
    const out = normalizeWidthRatios(screen(2, 2).columns);
    expect(out.map((c) => c.widthRatio)).toEqual([0.5, 0.5]);
  });
  test("garbage ratios fall back to equal shares", () => {
    const out = normalizeWidthRatios(screen(NaN, -1, 0).columns);
    expect(out.map((c) => c.widthRatio)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
  test("empty in, empty out", () => {
    expect(normalizeWidthRatios([])).toEqual([]);
  });
});

describe("insertScreenPane", () => {
  test("a column target gives the new column 1/n and scales the rest", () => {
    const out = insertScreenPane(screen(1), "x", { kind: "column", railIndex: 1 }, "c-new");
    expect(out.columns.map((c) => c.id)).toEqual(["c1", "c-new"]);
    expect(out.columns.map((c) => c.widthRatio)).toEqual([0.5, 0.5]);
    expect(sum(out)).toBeCloseTo(1);
  });
  test("into an empty screen the new column takes everything", () => {
    const out = insertScreenPane(screen(), "x", { kind: "column", railIndex: 0 }, "c-new");
    expect(out.columns).toEqual([
      { id: "c-new", widthRatio: 1, panes: [{ itemId: "x", heightRatio: 1 }] },
    ]);
  });
  test("a seam target stacks into the column and leaves widths alone", () => {
    const out = insertScreenPane(
      screen(0.25, 0.75),
      "x",
      { kind: "seam", columnId: "c2", seamIndex: 0 },
      "unused",
    );
    expect(out.columns.map((c) => c.widthRatio)).toEqual([0.25, 0.75]);
    expect(out.columns[1]!.panes.map((p) => p.itemId)).toEqual(["x", "i2"]);
    expect(out.columns[1]!.panes.reduce((a, p) => a + p.heightRatio, 0)).toBeCloseTo(1);
  });
  test("a seam target naming a missing column is a no-op returning the same reference", () => {
    const s = screen(1);
    expect(insertScreenPane(s, "x", { kind: "seam", columnId: "nope", seamIndex: 0 }, "c")).toBe(s);
  });
});

describe("automatic screen placement", () => {
  test("starts a column for an empty screen or an unmeasured viewport", () => {
    expect(automaticScreenTarget(screen(), { width: 1200, height: 800 })).toEqual({ kind: "column", railIndex: 0 });
    expect(automaticScreenTarget(screen(1), null)).toEqual({ kind: "column", railIndex: 1 });
  });
  test("adds a column when two columns have comfortable shapes", () => {
    expect(automaticScreenTarget(screen(1), { width: 1200, height: 800 })).toEqual({ kind: "column", railIndex: 1 });
  });
  test("preserves full tile height when two or three usable columns fit", () => {
    expect(automaticScreenTarget(screen(1), { width: 800, height: 800 })).toEqual({ kind: "column", railIndex: 1 });
    expect(automaticScreenTarget(screen(.5, .5), { width: 1200, height: 800 })).toEqual({ kind: "column", railIndex: 2 });
  });
  test("still stacks in a narrow viewport or when another column would crowd the screen", () => {
    expect(automaticScreenTarget(screen(1), { width: 600, height: 800 })).toEqual({ kind: "seam", columnId: "c1", seamIndex: 1 });
    expect(automaticScreenTarget(screen(1 / 3, 1 / 3, 1 / 3), { width: 1200, height: 800 })).toEqual({ kind: "seam", columnId: "c3", seamIndex: 1 });
  });
  test("opening in a new column preserves existing stacks and their pane heights", () => {
    const s = screen(.5, .5);
    s.columns[0]!.panes = [{ itemId: "a", heightRatio: .3 }, { itemId: "b", heightRatio: .7 }];
    const out = insertScreenPane(s, "new", automaticScreenTarget(s, { width: 1200, height: 800 }), "c-new");
    expect(out.columns.map(c => c.id)).toEqual(["c1", "c2", "c-new"]);
    expect(out.columns[0]!.panes).toBe(s.columns[0]!.panes);
    expect(out.columns[1]!.panes).toBe(s.columns[1]!.panes);
    expect(out.columns[2]!.panes).toEqual([{ itemId: "new", heightRatio: 1 }]);
  });
  test("uses actual resized widths, not just the number of columns", () => {
    expect(automaticScreenTarget(screen(.9, .1), { width: 1200, height: 800 })).toEqual({ kind: "column", railIndex: 2 });
  });
  test("does not stack if it would squeeze an existing pane below usable height", () => {
    const s = screen(.5, .5);
    s.columns[1]!.panes = [{ itemId: "a", heightRatio: .2 }, { itemId: "b", heightRatio: .8 }];
    expect(automaticScreenTarget(s, { width: 1200, height: 800 })).toEqual({ kind: "column", railIndex: 2 });
    expect(automaticScreenTarget(screen(.5, .5), { width: 1200, height: 350 })).toEqual({ kind: "column", railIndex: 2 });
  });
});

describe("removeScreenPane", () => {
  test("drops the pane, drops the emptied column, renormalizes widths", () => {
    const out = removeScreenPane(screen(0.25, 0.75), "i1");
    expect(out.columns.map((c) => c.id)).toEqual(["c2"]);
    expect(out.columns[0]!.widthRatio).toBe(1);
  });
  test("keeps the column when other panes remain", () => {
    const s: Screen = {
      id: "s",
      name: "S",
      columns: [
        {
          id: "c1",
          widthRatio: 1,
          panes: [
            { itemId: "a", heightRatio: 0.5 },
            { itemId: "b", heightRatio: 0.5 },
          ],
        },
      ],
    };
    const out = removeScreenPane(s, "a");
    expect(out.columns[0]!.panes).toEqual([{ itemId: "b", heightRatio: 1 }]);
  });
  test("an item not on the screen is a no-op returning the same reference", () => {
    const s = screen(1);
    expect(removeScreenPane(s, "zzz")).toBe(s);
  });
});

describe("moveScreenPane", () => {
  test("moving a sole pane to a new column at the end reorders and reshares", () => {
    const out = moveScreenPane(screen(0.5, 0.5), "i1", { kind: "column", railIndex: 2 }, "c-new");
    expect(out.columns.map((c) => c.panes[0]!.itemId)).toEqual(["i2", "i1"]);
    expect(sum(out)).toBeCloseTo(1);
  });
  test("moving a pane onto its own position is a no-op returning the same reference", () => {
    const s = screen(0.5, 0.5);
    expect(moveScreenPane(s, "i1", { kind: "column", railIndex: 0 }, "c-new")).toBe(s);
  });
  test("moving into a seam of another column stacks it there", () => {
    const out = moveScreenPane(
      screen(0.5, 0.5),
      "i1",
      { kind: "seam", columnId: "c2", seamIndex: 1 },
      "c-new",
    );
    expect(out.columns).toHaveLength(1);
    expect(out.columns[0]!.panes.map((p) => p.itemId)).toEqual(["i2", "i1"]);
    expect(out.columns[0]!.widthRatio).toBe(1);
  });
});

describe("resizeScreenDivider", () => {
  test("moves width from the right neighbour to the left, sum constant", () => {
    const out = resizeScreenDivider(screen(0.5, 0.5), "c1", 0.2);
    expect(out.columns.map((c) => c.widthRatio)).toEqual([0.7, 0.3]);
  });
  test("negative delta moves width the other way", () => {
    const out = resizeScreenDivider(screen(0.5, 0.5), "c1", -0.2);
    expect(out.columns.map((c) => c.widthRatio)[0]).toBeCloseTo(0.3);
  });
  test("clamps so neither neighbour drops under MIN_COLUMN_RATIO", () => {
    const grow = resizeScreenDivider(screen(0.5, 0.5), "c1", 0.9);
    expect(grow.columns[1]!.widthRatio).toBeCloseTo(MIN_COLUMN_RATIO);
    const shrink = resizeScreenDivider(screen(0.5, 0.5), "c1", -0.9);
    expect(shrink.columns[0]!.widthRatio).toBeCloseTo(MIN_COLUMN_RATIO);
  });
  test("the last column has no right neighbour: same reference", () => {
    const s = screen(0.5, 0.5);
    expect(resizeScreenDivider(s, "c2", 0.1)).toBe(s);
  });
  test("a zero delta (or one already at the clamp) is the same reference", () => {
    const s = screen(MIN_COLUMN_RATIO, 1 - MIN_COLUMN_RATIO);
    expect(resizeScreenDivider(s, "c1", 0)).toBe(s);
    expect(resizeScreenDivider(s, "c1", -0.5)).toBe(s);
  });
});

describe("screenToPixelColumns", () => {
  test("projects ratios to pixels that tile the viewport exactly", () => {
    const out = screenToPixelColumns(screen(1 / 3, 1 / 3, 1 / 3), 1000);
    expect(out.map((c) => c.widthPx)).toEqual([333, 333, 334]);
    expect(out.reduce((a, c) => a + c.widthPx, 0)).toBe(1000);
    expect(out.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });
  test("panes ride through untouched", () => {
    const s = screen(1);
    expect(screenToPixelColumns(s, 800)[0]!.panes).toBe(s.columns[0]!.panes);
  });
  test("many columns and resized neighbors still fit a small viewport", () => {
    const s = screen(...Array(12).fill(1 / 12));
    const resized = resizeScreenDivider(s, "c1", 0.02, 0.5 / 12);
    for (const width of [600, 1000, 1440]) {
      const out = screenToPixelColumns(resized, width);
      expect(out).toHaveLength(12);
      expect(out.every(c => c.widthPx > 0)).toBe(true);
      expect(out.reduce((sum, c) => sum + c.widthPx, 0)).toBe(width);
      expect(out[0]!.widthPx).toBeGreaterThan(out[1]!.widthPx);
    }
  });
  test("an empty screen projects to no columns", () => {
    expect(screenToPixelColumns(screen(), 800)).toEqual([]);
  });
});

let counter = 0;
const nextId = (): string => `c-gen-${++counter}`;

describe("repairScreens", () => {
  test("garbage in, empty out", () => {
    expect(repairScreens("nope", nextId)).toEqual([]);
    expect(repairScreens([null, 4, "x"], nextId)).toEqual([]);
  });
  test("a screen needs a string id; a missing name stays unnamed", () => {
    const out = repairScreens([{ id: "s1", columns: [] }, { name: "no id", columns: [] }], nextId);
    expect(out).toEqual([{ id: "s1", name: "", columns: [] }]);
  });
  test("bad ratios repair to equal shares, bad column ids are minted, garbage panes drop", () => {
    const out = repairScreens(
      [
        {
          id: "s1",
          name: "One",
          columns: [
            { id: "c1", widthRatio: "wide", panes: [{ itemId: "a", heightRatio: 1 }, "junk"] },
            { widthRatio: 3, panes: [{ itemId: "b", heightRatio: -2 }] },
            { id: "empty", widthRatio: 1, panes: [] },
          ],
        },
      ],
      nextId,
    );
    expect(out).toHaveLength(1);
    const cols = out[0]!.columns;
    expect(cols).toHaveLength(2);
    expect(cols.map((c) => c.widthRatio)).toEqual([0.5, 0.5]);
    expect(cols[0]!.id).toBe("c1");
    expect(cols[1]!.id.startsWith("c-gen-")).toBe(true);
    expect(cols[1]!.panes).toEqual([{ itemId: "b", heightRatio: 1 }]);
  });
  test("a duplicate pane within one screen is dropped; the same item across screens is kept", () => {
    const out = repairScreens(
      [
        { id: "s1", name: "A", columns: [
          { id: "c1", widthRatio: 0.5, panes: [{ itemId: "x", heightRatio: 1 }] },
          { id: "c2", widthRatio: 0.5, panes: [{ itemId: "x", heightRatio: 1 }] },
        ] },
        { id: "s2", name: "B", columns: [{ id: "c3", widthRatio: 1, panes: [{ itemId: "x", heightRatio: 1 }] }] },
      ],
      nextId,
    );
    expect(out[0]!.columns).toHaveLength(1);
    expect(out[1]!.columns[0]!.panes[0]!.itemId).toBe("x");
  });
  test("a duplicate screen id keeps the first", () => {
    const out = repairScreens([{ id: "s1", name: "A", columns: [] }, { id: "s1", name: "B", columns: [] }], nextId);
    expect(out.map((s) => s.name)).toEqual(["A"]);
  });
});

describe("reconcileScreens", () => {
  const two = (): Screen[] => [
    { id: "s1", name: "A", columns: [{ id: "c1", widthRatio: 1, panes: [{ itemId: "gone", heightRatio: 1 }] }] },
    { id: "s2", name: "B", columns: [{ id: "c2", widthRatio: 1, panes: [{ itemId: "kept", heightRatio: 1 }] }] },
  ];
  test("prunes unknown ids across every screen, emptying a screen rather than deleting it", () => {
    const out = reconcileScreens(two(), new Set(["kept"]));
    expect(out[0]!.columns).toEqual([]);
    expect(out[1]!.columns[0]!.panes[0]!.itemId).toBe("kept");
  });
  test("returns the same reference when nothing is unknown", () => {
    const s = two();
    expect(reconcileScreens(s, new Set(["gone", "kept"]))).toBe(s);
  });
});

describe("removeFromAllScreens", () => {
  test("removes the id from every screen it is on, same reference when on none", () => {
    const s: Screen[] = [
      { id: "s1", name: "A", columns: [{ id: "c1", widthRatio: 1, panes: [{ itemId: "x", heightRatio: 1 }] }] },
      { id: "s2", name: "B", columns: [{ id: "c2", widthRatio: 1, panes: [{ itemId: "y", heightRatio: 1 }] }] },
    ];
    const out = removeFromAllScreens(s, "x");
    expect(out[0]!.columns).toEqual([]);
    expect(out[1]).toBe(s[1]!);
    expect(removeFromAllScreens(s, "nope")).toBe(s);
  });
});

describe("nearestScreenPlacing", () => {
  const placing = (id: string, ...itemIds: string[]): Screen => ({
    id,
    name: "",
    columns: itemIds.length ? [{ id: `${id}-col`, widthRatio: 1, panes: itemIds.map((itemId) => ({ itemId, heightRatio: 1 / itemIds.length })) }] : [],
  });

  test("nothing to travel to when the active screen already shows the item", () => {
    const screens = [placing("a", "x"), placing("b", "x")];
    expect(nearestScreenPlacing(screens, "a", "x")).toBeNull();
  });

  test("nothing to travel to when no other screen shows it either", () => {
    expect(nearestScreenPlacing([placing("a", "y"), placing("b")], "a", "x")).toBeNull();
  });

  test("travels to the nearest screen that shows it", () => {
    const screens = [placing("a", "x"), placing("b"), placing("c"), placing("d", "x"), placing("e", "x")];
    expect(nearestScreenPlacing(screens, "c", "x")).toBe("d");
  });

  test("a tie goes to the screen on the left", () => {
    const screens = [placing("a", "x"), placing("b"), placing("c", "x")];
    expect(nearestScreenPlacing(screens, "b", "x")).toBe("a");
  });

  test("an unknown active screen travels nowhere", () => {
    expect(nearestScreenPlacing([placing("a", "x")], "gone", "x")).toBeNull();
  });
});

describe("moveScreen", () => {
  const s = (id: string): Screen => ({ id, name: "", columns: [] });
  const ids = (screens: Screen[]) => screens.map((screen) => screen.id);

  test("moves a screen to a new index", () => {
    expect(ids(moveScreen([s("a"), s("b"), s("c")], "a", 2))).toEqual(["b", "c", "a"]);
    expect(ids(moveScreen([s("a"), s("b"), s("c")], "c", 0))).toEqual(["c", "a", "b"]);
  });

  test("a no-op or out-of-range move returns the same reference", () => {
    const screens = [s("a"), s("b")];
    expect(moveScreen(screens, "a", 0)).toBe(screens);
    expect(moveScreen(screens, "gone", 1)).toBe(screens);
    expect(moveScreen(screens, "a", 5)).toBe(screens);
    expect(moveScreen(screens, "a", -1)).toBe(screens);
  });
});
