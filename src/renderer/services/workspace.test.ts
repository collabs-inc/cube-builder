import { describe, expect, test } from "vitest";
import { createWorkspaceApi } from "./workspace";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const STATE = {
  version: 5 as const,
  columns: [{ id: "c1", widthPx: 560, panes: [{ itemId: "i1", heightRatio: 1 }] }],
  activeItemId: "i1",
  defaultWidthPx: 560,
  mountedItemIds: ["i1"],
  activeView: "canvas",
  canvasTiles: [{ itemId: "i1", x: 40, y: 40, w: 400, h: 520, z: 1 }],
  canvasViewport: { centerX: 0, centerY: 0, zoom: 1 },
  canvasTileSizes: null,
  machineStatusPanes: { "machine-status:a": { machineId: "cloud-a", name: "Cloud" } },
  treePanes: { "tree:abc": { repoId: "r1", root: "/repo", name: "repo" } },
  screens: [
    { id: "a1", name: "First", checkoutId: "a", columns: [] },
    { id: "a2", name: "Review", checkoutId: "a", columns: [] },
  ],
  selectedScreenIds: { a: "a2" },
  openCheckoutIds: ["a"],
  itemMachineIds: { i1: "cloud" },
};

describe("createWorkspaceApi", () => {
  test("workspaceLoad resolves null when nothing is stored", async () => {
    const api = createWorkspaceApi({ storage: fakeStorage() });
    expect(await api.workspaceLoad()).toBeNull();
  });

  test("workspaceSave / workspaceLoad round-trip under workspace_state", async () => {
    const storage = fakeStorage();
    const api = createWorkspaceApi({ storage });
    await api.workspaceSave(STATE);
    expect(await api.workspaceLoad()).toEqual(STATE);
    expect(JSON.parse(storage.getItem("workspace_state")!)).toEqual(STATE);
  });

  test("a corrupt workspace_state is quarantined to workspace_state.corrupt and load resolves null", async () => {
    const storage = fakeStorage();
    storage.setItem("workspace_state", "{not json");
    const api = createWorkspaceApi({ storage });
    expect(await api.workspaceLoad()).toBeNull();
    expect(storage.getItem("workspace_state.corrupt")).toBe("{not json");
    expect(storage.getItem("workspace_state")).toBeNull();
  });

  test("a save after quarantine never touches the .corrupt key again", async () => {
    const storage = fakeStorage();
    storage.setItem("workspace_state", "{not json");
    const api = createWorkspaceApi({ storage });
    await api.workspaceLoad();
    await api.workspaceSave(STATE);
    expect(storage.getItem("workspace_state.corrupt")).toBe("{not json");
    expect(await api.workspaceLoad()).toEqual(STATE);
  });

  test("a version 3 (pre-canvas) value still loads rather than quarantining", async () => {
    const storage = fakeStorage();
    const v3 = JSON.stringify({
      version: 3,
      columns: STATE.columns,
      activeItemId: "i1",
      defaultWidthPx: 560,
      mountedItemIds: ["i1"],
    });
    storage.setItem("workspace_state", v3);
    const api = createWorkspaceApi({ storage });
    const loaded = (await api.workspaceLoad()) as Record<string, unknown> | null;
    expect(loaded).not.toBeNull();
    expect(loaded!.columns).toEqual(STATE.columns);
    expect(storage.getItem("workspace_state.corrupt")).toBeNull();
  });

  test("a wrong version is quarantined the same as unparseable JSON", async () => {
    const storage = fakeStorage();
    const badVersion = JSON.stringify({ ...STATE, version: 2 });
    storage.setItem("workspace_state", badVersion);
    const api = createWorkspaceApi({ storage });
    expect(await api.workspaceLoad()).toBeNull();
    expect(storage.getItem("workspace_state.corrupt")).toBe(badVersion);
    expect(storage.getItem("workspace_state")).toBeNull();
  });

  test("non-array columns are quarantined the same as unparseable JSON", async () => {
    const storage = fakeStorage();
    const badColumns = JSON.stringify({ ...STATE, columns: "not-an-array" });
    storage.setItem("workspace_state", badColumns);
    const api = createWorkspaceApi({ storage });
    expect(await api.workspaceLoad()).toBeNull();
    expect(storage.getItem("workspace_state.corrupt")).toBe(badColumns);
    expect(storage.getItem("workspace_state")).toBeNull();
  });

  // The renderer's getPersistable() hands over state WITHOUT `version` —
  // main's saveWorkspace stamps `version: 5` internally (WorkspaceSaveInput
  // = Omit<WorkspaceState, "version">) and the shim must mirror that, or
  // its own write fails its own load's shape check.
  test("workspaceSave stamps version: 5 even when the caller omits it", async () => {
    const storage = fakeStorage();
    const api = createWorkspaceApi({ storage });
    const { version: _version, ...withoutVersion } = STATE;
    await api.workspaceSave(withoutVersion as unknown as typeof STATE);

    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      expect(await api.workspaceLoad()).toEqual(STATE);
    } finally {
      console.error = originalError;
    }
    expect(errors).toEqual([]);
    expect(storage.getItem("workspace_state.corrupt")).toBeNull();
  });

  // Safari private browsing (and similar storage-blocked contexts) throws
  // synchronously on setItem — a debounced autosave must not turn that into
  // a rejected promise on every tick.
  test("workspaceSave swallows a blocked setItem instead of rejecting", async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    } as unknown as Storage;
    const api = createWorkspaceApi({ storage });
    await expect(api.workspaceSave(STATE)).resolves.toBeUndefined();
  });

  test("writes version 5 and round-trips screens", async () => {
    const storage = fakeStorage();
    const api = createWorkspaceApi({ storage });
    await api.workspaceSave({
      columns: [],
      activeItemId: null,
      defaultWidthPx: 560,
      mountedItemIds: [],
      activeView: "screen:s1",
      screens: [{ id: "s1", name: "One", columns: [] }],
      canvasTiles: [],
      canvasViewport: null,
      canvasTileSizes: null,
      treePanes: {},
    });
    const loaded = (await api.workspaceLoad()) as {
      version: number;
      screens: unknown[];
      activeView: string;
    };
    expect(loaded.version).toBe(5);
    expect(loaded.screens).toHaveLength(1);
    expect(loaded.activeView).toBe("screen:s1");
  });

  test("a stored version 4 document still loads", async () => {
    const storage = fakeStorage();
    storage.setItem("workspace_state", JSON.stringify({ version: 4, columns: [] }));
    const api = createWorkspaceApi({ storage });
    expect(await api.workspaceLoad()).not.toBeNull();
  });
});
