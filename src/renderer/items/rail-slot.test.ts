/**
 * Pure helpers Rail.tsx needs — no DOM, so plain bun:test with no
 * happy-dom registration (contrast Rail.test.tsx, which renders).
 */



import { describe, expect, test } from "vitest";
import type { OwnedItem } from "@port/shared/catalog";
import type { Column } from "../state/layout-ops";
import { canDuplicatePane, fittedRailWidth, panedItemIds, paneTitle, RAIL_GUTTER_PX, slotVisible } from "./rail-slot";

function column(id: string, ...itemIds: string[]): Column {
  return {
    id,
    widthPx: 500,
    panes: itemIds.map((itemId) => ({ itemId, heightRatio: 1 / itemIds.length })),
  };
}

function item(overrides: Partial<OwnedItem> & Pick<OwnedItem, "id" | "type">): OwnedItem {
  return { machineId: "m1", createdAt: "t", ...overrides } as OwnedItem;
}

test("independent viewers duplicate, while sessions and editors stay shared", () => {
  for (const type of ["artifact", "image", "pdf"] as const) {
    expect(canDuplicatePane(item({ id: "a", type }))).toBe(true);
  }
  for (const type of ["term", "agent", "note", "code", "app"] as const) {
    expect(canDuplicatePane(item({ id: "a", type }))).toBe(false);
  }
  expect(canDuplicatePane(item({ id: "a", type: "artifact", port: 5173, siteAddress: "127.0.0.1" }))).toBe(true);
  expect(canDuplicatePane(undefined, true)).toBe(true);
  expect(canDuplicatePane(undefined)).toBe(false);
});

describe("panedItemIds", () => {
  test("walks column by column, pane by pane — rail order", () => {
    expect(panedItemIds([column("c1", "a", "b"), column("c2", "c")])).toEqual(["a", "b", "c"]);
  });

  test("no columns -> no ids", () => {
    expect(panedItemIds([])).toEqual([]);
  });
});

describe("paneTitle", () => {
  test("personas use their name or Persona, never their context-folder path", () => {
    const persona = item({ id: "persona", type: "agent", role: "persona", harness: "codex", cwd: "/Users/test/.cube/personas/uuid" });
    expect(paneTitle(persona)).toBe("Persona");
    expect(paneTitle({ ...persona, agentTitle: "Release planning" })).toBe("Release planning");
    expect(paneTitle({ ...persona, agentTitle: "Release planning", userTitle: "My helper" })).toBe("My helper");
  });
  test("uses the sidebar's own entry title, with no live status attached", () => {
    const title = paneTitle(item({ id: "a", type: "code", filePath: "/tmp/notes.ts" }));
    expect(title).toContain("notes.ts");
  });
});

test("fittedRailWidth takes both gutters off the rail's client width, never below 0", () => {
  expect(fittedRailWidth(1000)).toBe(1000 - 2 * RAIL_GUTTER_PX);
  expect(fittedRailWidth(4)).toBe(0);
});

describe("slotVisible", () => {
  test("an undisplayed (hidden) item is never visible", () => {
    expect(slotVisible(false, false, false)).toBe(false);
    expect(slotVisible(false, true, true)).toBe(false);
  });

  test("unzoomed: every displayed item is visible", () => {
    expect(slotVisible(true, false, false)).toBe(true);
    expect(slotVisible(true, false, true)).toBe(true);
  });

  test("zoomed (which narrow mode holds on): only the active item is visible", () => {
    expect(slotVisible(true, true, true)).toBe(true);
    expect(slotVisible(true, true, false)).toBe(false);
  });
});
