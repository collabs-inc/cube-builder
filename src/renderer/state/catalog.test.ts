import { describe, expect, it, beforeEach } from "vitest";
import { LOCAL_MACHINE_ID } from "@port/shared/types";
import type { CatalogDocument } from "@port/shared/catalog";
import { catalogStore, checkoutWasRemoved, acceptSnapshot, evictMachine, inferItemType, loadCache, resetCatalog, setPairedCloudMachine, sweepExitedOnAttach, repoRootsForMachine } from "./catalog";

// bun:test's environment has no `localStorage` (unlike the *.test.tsx files
// that register happy-dom for a full DOM) — this in-memory stub is scoped to
// this file only, standing in for the browser's Storage interface just well
// enough for catalog.ts's own loadCache()/saveCache() (getItem/setItem/key/
// length) to exercise real localStorage semantics rather than a no-op.
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

(globalThis as unknown as { localStorage: Storage }).localStorage = new FakeLocalStorage() as unknown as Storage;

const doc = (epoch: string, rev: number, itemIds: string[]) => ({
  version: 1 as const, epoch, rev,
  repos: [],
  items: itemIds.map((id) => ({ id, type: "note" as const, createdAt: "t" })),
});

describe("catalog snapshot acceptance", () => {
  beforeEach(() => {
    resetCatalog();
    localStorage.clear();
  });

  it("a live snapshot matching the cache confirms checkout absence and notifies the workspace", () => {
    const empty = doc("cache", 3, []);
    acceptSnapshot(LOCAL_MACHINE_ID, empty);
    resetCatalog();
    loadCache();
    expect(checkoutWasRemoved("deleted", LOCAL_MACHINE_ID)).toBe(false);
    let notifications = 0;
    const off = catalogStore.subscribe(() => notifications++);
    try {
      expect(acceptSnapshot(LOCAL_MACHINE_ID, empty)).toBe(false);
      expect(checkoutWasRemoved("deleted", LOCAL_MACHINE_ID)).toBe(true);
      expect(notifications).toBe(1);
      acceptSnapshot(LOCAL_MACHINE_ID, empty);
      expect(notifications).toBe(1);
    } finally { off(); }
  });

  it("filters retired legacy managed-preview rows from live and cached catalogs while keeping HTML and site artifacts", () => {
    const catalog: CatalogDocument = doc("release", 1, []);
    catalog.items = [
      { id: "legacy-preview", type: "artifact", target: "web-preview", createdAt: "now" },
      { id: "html", type: "artifact", filePath: "/repo/index.html", createdAt: "now" },
      { id: "live-site", type: "artifact", port: 5173, siteAddress: "127.0.0.1", createdAt: "now" },
    ];
    acceptSnapshot("m1", catalog);
    expect(catalogStore.getSnapshot().items.map(item => item.id)).toEqual(["html", "live-site"]);
    resetCatalog();
    loadCache();
    expect(catalogStore.getSnapshot().items.map(item => item.id)).toEqual(["html", "live-site"]);
  });

  it("accepts a higher rev in the same epoch", () => {
    expect(acceptSnapshot("m1", doc("e1", 1, ["a"]))).toBe(true);
    expect(acceptSnapshot("m1", doc("e1", 2, ["a", "b"]))).toBe(true);
    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("ignores a stale rev in the same epoch", () => {
    acceptSnapshot("m1", doc("e1", 5, ["a", "b"]));
    expect(acceptSnapshot("m1", doc("e1", 4, ["a"]))).toBe(false);
    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("accepts a different epoch even when its rev is lower", () => {
    acceptSnapshot("m1", doc("e1", 9, ["a", "b"]));
    // A reset catalog restarts at rev 1. Without the epoch it would look
    // stale forever and the sidebar would never recover.
    expect(acceptSnapshot("m1", doc("e2", 1, ["fresh"]))).toBe(true);
    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["fresh"]);
  });

  it("keeps machines independent", () => {
    acceptSnapshot("m1", doc("e1", 3, ["a"]));
    acceptSnapshot("m2", doc("e2", 1, ["b"]));
    expect(catalogStore.getSnapshot().items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("tags every item with its machine", () => {
    acceptSnapshot("m1", doc("e1", 1, ["a"]));
    expect(catalogStore.getSnapshot().items[0]?.machineId).toBe("m1");
  });

  it("carries a repo's worktreeOf through untouched", () => {
    const worktreeOf = {
      repoId: "parent-1",
      createdOnBranch: "feat-x",
      source: { from: "new" as const },
      creation: { state: "pending" as const },
    };
    acceptSnapshot("m1", {
      version: 1 as const,
      epoch: "e1",
      rev: 1,
      repos: [
        { id: "wt-1", name: "feat-x", root: "/w/feat-x", managed: true, createdAt: "t", worktreeOf },
      ],
      items: [],
    });
    expect(catalogStore.getSnapshot().repos[0]?.worktreeOf).toEqual(worktreeOf);
  });
});

describe("catalog cache", () => {
  beforeEach(() => {
    resetCatalog();
    localStorage.clear();
  });

  it("a seeded cache entry is visible in getSnapshot() before any acceptSnapshot call", () => {
    localStorage.setItem("catalog_cache_m1", JSON.stringify(doc("e1", 1, ["cached"])));
    loadCache();
    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["cached"]);
    expect(catalogStore.getSnapshot().items[0]?.machineId).toBe("m1");
  });

  it("an accepted snapshot writes the cache, and a rejected (stale-rev) one does not", () => {
    acceptSnapshot("m1", doc("e1", 5, ["a", "b"]));
    expect(JSON.parse(localStorage.getItem("catalog_cache_m1") ?? "null")).toEqual(doc("e1", 5, ["a", "b"]));

    expect(acceptSnapshot("m1", doc("e1", 4, ["a"]))).toBe(false);
    expect(JSON.parse(localStorage.getItem("catalog_cache_m1") ?? "null")).toEqual(doc("e1", 5, ["a", "b"]));
  });

  it("a corrupt/unparseable cache entry is ignored and leaves the store empty rather than throwing", () => {
    localStorage.setItem("catalog_cache_m1", "not json");
    localStorage.setItem("catalog_cache_m2", JSON.stringify({ not: "a catalog document" }));
    expect(() => loadCache()).not.toThrow();
    expect(catalogStore.getSnapshot()).toEqual({ repos: [], items: [] });
  });
});

describe("evictMachine", () => {
  beforeEach(() => {
    resetCatalog();
    localStorage.clear();
  });

  it("drops the machine's tree, leaving every other machine's rows", () => {
    acceptSnapshot("m1", doc("e1", 1, ["a"]));
    acceptSnapshot("m2", doc("e2", 1, ["b"]));

    evictMachine("m1");

    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["b"]);
  });

  it("drops the cache too, so the next loadCache() cannot resurrect it", () => {
    acceptSnapshot("m1", doc("e1", 1, ["a"]));
    expect(localStorage.getItem("catalog_cache_m1")).not.toBeNull();

    evictMachine("m1");
    loadCache();

    expect(localStorage.getItem("catalog_cache_m1")).toBeNull();
    expect(catalogStore.getSnapshot()).toEqual({ repos: [], items: [] });
  });

  it("notifies subscribers once for a held machine and not at all for an unknown one", () => {
    acceptSnapshot("m1", doc("e1", 1, ["a"]));
    let notifications = 0;
    const unsubscribe = catalogStore.subscribe(() => {
      notifications++;
    });

    evictMachine("never-seen");
    expect(notifications).toBe(0);

    evictMachine("m1");
    expect(notifications).toBe(1);

    unsubscribe();
  });
});

describe("inferItemType", () => {
  it("infers note/pdf/image/code from extension, case-insensitively", () => {
    expect(inferItemType("/a/b.md")).toBe("note");
    expect(inferItemType("/a/c.pdf")).toBe("pdf");
    expect(inferItemType("/a/d.png")).toBe("image");
    expect(inferItemType("/a/e.jpg")).toBe("image");
    expect(inferItemType("/a/f.jpeg")).toBe("image");
    expect(inferItemType("/a/g.gif")).toBe("image");
    expect(inferItemType("/a/h.svg")).toBe("image");
    expect(inferItemType("/a/i.webp")).toBe("image");
    expect(inferItemType("/a/j.ts")).toBe("code");
    expect(inferItemType("/a/README.MD")).toBe("note");
  });

  it("an extensionless path falls through to code", () => {
    expect(inferItemType("/a/Makefile")).toBe("code");
  });
});

describe("sweepExitedOnAttach", () => {
  const exited = (id: string) => ({
    id,
    machineId: "m",
    type: "term" as const,
    createdAt: "t",
    exitedAt: "t2",
    exitCode: 0,
  });

  it("sweeps only exited items this client was displaying", () => {
    const items = [
      exited("mine"),
      exited("theirs"),
      { id: "live", machineId: "m", type: "term" as const, createdAt: "t", ptySessionId: "s" },
    ];
    expect(sweepExitedOnAttach(items, new Set(["mine", "live"]), new Set()).map((i) => i.id))
      .toEqual(["mine"]);
  });

  it("keeps an item a daemon restart orphaned, which reports no exit code", () => {
    const orphaned = { id: "mine", machineId: "m", type: "term" as const, createdAt: "t", exitedAt: "t2" };
    expect(sweepExitedOnAttach([orphaned], new Set(["mine"]), new Set())).toEqual([]);
  });

  it("sweeps persona terminal workers without requiring them to be opened", () => {
    const items = [
      { ...exited("claude"), personaId: "p", target: "claude" },
      { ...exited("codex"), personaId: "p", target: "codex", exitCode: 1 },
      { ...exited("shell"), personaId: "p", target: "shell" },
      { ...exited("unowned"), target: "claude" },
      { ...exited("conversation"), type: "agent" as const, personaId: "p", harness: "claude" },
    ];
    expect(sweepExitedOnAttach(items, new Set(), new Set()).map(item => item.id))
      .toEqual(["claude", "codex"]);
  });

  it("keeps live, recovering, and restart-orphaned persona workers", () => {
    const worker = { machineId: "m", type: "term" as const, createdAt: "t", personaId: "p", target: "claude" };
    const items = [
      { ...worker, id: "live", ptySessionId: "s" },
      { ...worker, id: "orphaned", exitedAt: "t2" },
      { ...worker, id: "recovering", exitedAt: "t2", exitCode: 0 },
    ];
    expect(sweepExitedOnAttach(items, new Set(), new Set(["recovering"]))).toEqual([]);
  });

  it("keeps an item whose tile is already replacing the session that exited", () => {
    expect(sweepExitedOnAttach([exited("mine")], new Set(["mine"]), new Set(["mine"]))).toEqual([]);
  });

  it("never sweeps an agent conversation, however it ended", () => {
    const conversation = { ...exited("mine"), type: "agent" as const };
    expect(sweepExitedOnAttach([conversation], new Set(["mine"]), new Set())).toEqual([]);
  });
});

/**
 * `catalog:evicted` is a broadcast with nothing durable behind it: main
 * fires it from `pairAndBroadcast()`, which runs before any window exists,
 * so a sign-out that happened while the app was closed (an expired refresh
 * token, a session revoked elsewhere) reaches no listener at all. The
 * cached tree would then be re-seeded from localStorage on every launch,
 * forever — `loadCloudMachine()` is null by then, so nothing can re-fire
 * the eviction. Pairing is what decides whether a remote machine's rows
 * belong on the rail.
 */
/** Seeds a tree the way a pre-pairing `loadCache()` would have. */
function seedPrePairingTree(machineId: string, catalog: ReturnType<typeof doc>): void {
  localStorage.setItem(`catalog_cache_${machineId}`, JSON.stringify(catalog));
  acceptSnapshot(machineId, catalog);
}

describe("unpaired machines are pruned from the cache", () => {
  beforeEach(() => {
    resetCatalog();
    localStorage.clear();
  });

  it("a cached tree for a machine this client is no longer paired with is dropped", () => {
    localStorage.setItem("catalog_cache_old-machine", JSON.stringify(doc("e1", 1, ["stale"])));
    loadCache();
    // Before pairing is known nothing is dropped — "not paired yet" and
    // "not paired any more" are different answers.
    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["stale"]);

    setPairedCloudMachine(null);

    expect(catalogStore.getSnapshot()).toEqual({ repos: [], items: [] });
    expect(localStorage.getItem("catalog_cache_old-machine")).toBeNull();
  });

  it("re-pairing under a new id shows only the new machine's tree", () => {
    localStorage.setItem("catalog_cache_old-machine", JSON.stringify(doc("e1", 1, ["stale"])));
    loadCache();

    setPairedCloudMachine("new-machine");
    acceptSnapshot("new-machine", doc("e2", 1, ["fresh"]));

    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["fresh"]);
    expect(localStorage.getItem("catalog_cache_old-machine")).toBeNull();
  });

  it("a cache seeded after pairing is known skips the unpaired machine outright", () => {
    setPairedCloudMachine("new-machine");
    localStorage.setItem("catalog_cache_old-machine", JSON.stringify(doc("e1", 1, ["stale"])));
    localStorage.setItem("catalog_cache_new-machine", JSON.stringify(doc("e2", 1, ["fresh"])));

    loadCache();

    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["fresh"]);
  });

  it("the local machine is never pruned, whatever the pairing says", () => {
    acceptSnapshot(LOCAL_MACHINE_ID, doc("e1", 1, ["local"]));

    setPairedCloudMachine(null);

    expect(catalogStore.getSnapshot().items.map((i) => i.id)).toEqual(["local"]);
  });

  it("evicting the paired machine also sweeps any other stale tree", () => {
    setPairedCloudMachine("m1");
    acceptSnapshot("m1", doc("e1", 1, ["a"]));
    // A tree that arrived before pairing was known — the window loadCache()
    // seeds through.
    seedPrePairingTree("m2", doc("e2", 1, ["b"]));

    evictMachine("m1");

    expect(catalogStore.getSnapshot()).toEqual({ repos: [], items: [] });
    expect(localStorage.getItem("catalog_cache_m2")).toBeNull();
  });
});

describe("repoRootsForMachine", () => {
  it("returns each of the machine's repos with its daemon-side root", () => {
    resetCatalog();
    acceptSnapshot("cloud-m", {
      version: 1,
      epoch: "e1",
      rev: 1,
      repos: [
        { id: "r1", name: "alexandria", root: "/home/node/repos/alexandria", managed: true, createdAt: "t" },
        { id: "w1", name: "feature", root: "/home/node/repos/alexandria/.wt/feature", managed: true, createdAt: "t" },
      ],
      items: [],
    });
    expect(repoRootsForMachine("cloud-m")).toEqual([
      { repoId: "r1", root: "/home/node/repos/alexandria" },
      { repoId: "w1", root: "/home/node/repos/alexandria/.wt/feature" },
    ]);
    expect(repoRootsForMachine("never-seen")).toEqual([]);
  });
});
