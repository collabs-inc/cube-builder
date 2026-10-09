// src/main/cubed/tree.test.ts
//
// Run: npx tsx --test src/main/cubed/tree.test.ts
import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TreeNode } from "@port/shared/types";
import { readTree } from "./tree";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cubed-tree-"));
  fs.mkdirSync(path.join(root, "src/deep/deeper"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# hi\n");
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src/deep/mid.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, "src/deep/deeper/low.ts"), "export const c = 3;\n");
  fs.writeFileSync(path.join(root, "node_modules/junk.js"), "junk\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => n.name);
}

function find(nodes: TreeNode[], name: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.name === name) return node;
    const hit = node.children ? find(node.children, name) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

describe("readTree", () => {
  it("returns paths RELATIVE to root, never absolute", async () => {
    const { nodes } = await readTree({ root });
    const readme = find(nodes, "README.md");
    assert.equal(readme?.path, "README.md");
    const low = find(nodes, "low.ts");
    assert.equal(low?.path, path.join("src", "deep", "deeper", "low.ts"));
  });

  it("sorts folders before files, each alphabetically", async () => {
    const { nodes } = await readTree({ root });
    assert.deepEqual(names(nodes), ["node_modules", "src", "README.md"]);
  });

  it("applies caller-supplied ignore patterns", async () => {
    const { nodes } = await readTree({ root, patterns: ["node_modules"] });
    assert.equal(find(nodes, "node_modules"), undefined);
    assert.ok(find(nodes, "index.ts"));
  });

  it("walks a subtree when path is given", async () => {
    const { nodes } = await readTree({ root, path: "src/deep" });
    assert.deepEqual(names(nodes), ["deeper", "mid.ts"]);
    assert.equal(find(nodes, "mid.ts")?.path, path.join("src", "deep", "mid.ts"));
  });

  it("depth bounds the descent and marks the cut folder truncated", async () => {
    const { nodes, truncated } = await readTree({ root, depth: 1 });
    assert.equal(truncated, true);
    const src = find(nodes, "src");
    assert.equal(src?.truncated, undefined);
    assert.ok(src?.children);
    const deep = find(nodes, "deep");
    assert.equal(deep?.truncated, true);
    assert.equal(deep?.children, undefined);
  });

  it("depth 0 returns the root's own entries with every folder truncated", async () => {
    const { nodes } = await readTree({ root, depth: 0 });
    assert.deepEqual(names(nodes), ["node_modules", "src", "README.md"]);
    assert.equal(find(nodes, "src")?.truncated, true);
  });

  it("maxEntries stops the walk and reports truncated", async () => {
    const { nodes, truncated } = await readTree({ root, maxEntries: 2 });
    assert.equal(truncated, true);
    let count = 0;
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        count += 1;
        if (n.children) walk(n.children);
      }
    };
    walk(nodes);
    assert.equal(count, 2);
  });

  it("reports truncated false when the walk ends exactly on maxEntries", async () => {
    // Exactly two nodes, cap of exactly two: the tree is COMPLETE. Inferring
    // truncation from `emitted >= maxEntries` calls this a cut that never
    // happened — a false positive costs the client a pointless round trip.
    const exact = fs.mkdtempSync(path.join(os.tmpdir(), "cubed-tree-exact-"));
    try {
      fs.mkdirSync(path.join(exact, "x"));
      fs.writeFileSync(path.join(exact, "x", "y.txt"), "hi\n");
      const { nodes, truncated } = await readTree({ root: exact, maxEntries: 2 });
      assert.equal(truncated, false);
      const x = find(nodes, "x");
      assert.equal(x?.truncated, undefined);
      assert.deepEqual(names(x?.children ?? []), ["y.txt"]);
      assert.equal(find(nodes, "y.txt")?.truncated, undefined);
    } finally {
      fs.rmSync(exact, { recursive: true, force: true });
    }
  });

  it("depth 2 pushes truncation exactly one level below depth 1", async () => {
    const { nodes, truncated } = await readTree({ root, depth: 2 });
    assert.equal(truncated, true);
    // `deep` is where depth 1 cut; at depth 2 it is whole...
    const deep = find(nodes, "deep");
    assert.equal(deep?.truncated, undefined);
    assert.deepEqual(names(deep?.children ?? []), ["deeper", "mid.ts"]);
    // ...and the cut has moved exactly one level down, no further.
    const deeper = find(nodes, "deeper");
    assert.equal(deeper?.truncated, true);
    assert.equal(deeper?.children, undefined);
  });

  it("an unbounded walk reports truncated false", async () => {
    const { truncated } = await readTree({ root, patterns: ["node_modules"] });
    assert.equal(truncated, false);
  });

  it("labels images binary and keeps them; drops other binaries", async () => {
    fs.writeFileSync(path.join(root, "shot.png"), Buffer.from([0, 1, 0, 2]));
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 0, 2]));
    const { nodes } = await readTree({ root, detectBinary: true });
    assert.equal(find(nodes, "shot.png")?.isBinary, true);
    assert.equal(find(nodes, "blob.bin"), undefined);
    assert.equal(find(nodes, "README.md")?.isBinary, false);
  });

  it("omits isBinary entirely when detectBinary is off", async () => {
    const { nodes } = await readTree({ root });
    const readme = find(nodes, "README.md");
    assert.equal(readme && "isBinary" in readme, false);
  });

  it("counts files per folder when asked", async () => {
    const { nodes } = await readTree({
      root,
      patterns: ["node_modules"],
      countFiles: true,
    });
    // src/index.ts + src/deep/mid.ts + src/deep/deeper/low.ts
    assert.equal(find(nodes, "src")?.fileCount, 3);
  });

  it("omits fileCount when not asked", async () => {
    const { nodes } = await readTree({ root });
    const src = find(nodes, "src");
    assert.equal(src && "fileCount" in src, false);
  });

  it("never emits frontmatter or preview", async () => {
    const { nodes } = await readTree({ root });
    const readme = find(nodes, "README.md")!;
    assert.equal("frontmatter" in readme, false);
    assert.equal("preview" in readme, false);
  });

  it("rejects a path that escapes root", async () => {
    await assert.rejects(
      () => readTree({ root, path: "../.." }),
      /path-escape/,
    );
  });

  it("reports a missing root as not-found", async () => {
    await assert.rejects(
      () => readTree({ root: path.join(root, "nope") }),
      /not-found/,
    );
  });

  it("skips a directory it cannot read instead of failing the walk", async () => {
    const blocked = path.join(root, "blocked");
    fs.mkdirSync(blocked);
    fs.chmodSync(blocked, 0o000);
    try {
      const { nodes } = await readTree({ root });
      assert.ok(find(nodes, "blocked"));
    } finally {
      fs.chmodSync(blocked, 0o755);
    }
  });
});
