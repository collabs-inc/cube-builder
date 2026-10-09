// src/main/cubed/tree.ts
//
// The recursive tree walk. This used to live in the Electron main process
// against local disk; it lives here so local and cloud share one
// implementation and a cloud walk does not become N round trips.
//
// Bounded on purpose: a caller crossing a WAN has a 15s request budget, and a
// silently short tree is indistinguishable from a complete one. When a bound
// bites, the folder that got cut is marked `truncated` so the client can
// re-request that subtree on expand.
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { TreeNode } from "@port/shared/types";
import { createEntryFilter } from "./filter";
import { resolveScopedPath } from "./scoped-path";

export interface ReadTreeArgs {
  root: string;
  /** Subtree to walk, relative to root. Default "" — the root itself. */
  path?: string;
  /** Ignore patterns. Omitted means no filtering. */
  patterns?: readonly string[];
  /**
   * Max directory levels to descend below the start: `depth: 0` lists the
   * start's own entries but truncates every folder among them with no
   * children; `depth: 1` also shows those folders' own children, truncating
   * one level further down; and so on. Omitted = unbounded.
   */
  depth?: number;
  /** Max nodes emitted across the whole walk. Omitted = unbounded. */
  maxEntries?: number;
  /** Sniff contents: drop non-viewable binaries, label the rest. */
  detectBinary?: boolean;
  /** Populate fileCount on folders. */
  countFiles?: boolean;
}

export interface ReadTreeResult {
  nodes: TreeNode[];
  truncated: boolean;
}

export async function readTree(args: ReadTreeArgs): Promise<ReadTreeResult> {
  const startAbs = resolveScopedPath(args.root, args.path ?? "");
  try {
    await stat(startAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("not-found");
    }
    throw err;
  }

  const filter = createEntryFilter({
    ...(args.patterns === undefined ? {} : { patterns: args.patterns }),
    ...(args.detectBinary === undefined ? {} : { detectBinary: args.detectBinary }),
  });
  const maxEntries = args.maxEntries ?? Number.POSITIVE_INFINITY;
  const maxDepth = args.depth ?? Number.POSITIVE_INFINITY;
  let emitted = 0;
  let truncated = false;

  /** Root-relative path for the wire — never absolute (D8). */
  const wirePath = (abs: string): string =>
    args.root === "" ? abs : relative(args.root, abs);

  /**
   * `skipped` is a FACT, not an inference: true only when the entry loop broke
   * with entries still unvisited. `emitted >= maxEntries` cannot tell a cap
   * that bit from a cap filled exactly by a complete tree, and a false
   * `truncated` costs the client a round trip and its trust in the flag.
   */
  interface WalkResult {
    nodes: TreeNode[];
    skipped: boolean;
  }

  async function walk(dirAbs: string, depth: number): Promise<WalkResult> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      // A directory that vanished or cannot be read is not a reason to fail
      // the whole walk — the tree is a view of a live filesystem.
      return { nodes: [], skipped: false };
    }

    const folders: TreeNode[] = [];
    const files: TreeNode[] = [];
    let skipped = false;

    for (const entry of entries) {
      if (emitted >= maxEntries) {
        skipped = true;
        break;
      }
      const abs = join(dirAbs, entry.name);
      const isDirectory = entry.isDirectory();
      const verdict = await filter.classify(wirePath(abs), abs, isDirectory);
      if (!verdict.include) continue;

      let stats;
      try {
        stats = await stat(abs);
      } catch {
        continue;
      }

      const base: TreeNode = {
        path: wirePath(abs),
        name: entry.name,
        kind: isDirectory ? "folder" : "file",
        ctime: stats.birthtime.toISOString(),
        mtime: stats.mtime.toISOString(),
      };
      emitted += 1;

      if (!isDirectory) {
        if (verdict.isBinary !== undefined) base.isBinary = verdict.isBinary;
        files.push(base);
        continue;
      }

      if (depth >= maxDepth) {
        base.truncated = true;
        truncated = true;
      } else {
        const sub = await walk(abs, depth + 1);
        base.children = sub.nodes;
        if (sub.skipped) {
          base.truncated = true;
          truncated = true;
        }
      }
      if (args.countFiles) base.fileCount = countFiles(base);
      folders.push(base);
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { nodes: [...folders, ...files], skipped };
  }

  const start = await walk(startAbs, 0);
  // A cut at the start level has no enclosing folder to mark — it shows up in
  // the summary alone.
  return { nodes: start.nodes, truncated: truncated || start.skipped };
}

/** Files in this subtree, as far as the (possibly bounded) walk saw it. */
function countFiles(node: TreeNode): number {
  if (!node.children) return 0;
  let count = 0;
  for (const child of node.children) {
    count += child.kind === "file" ? 1 : countFiles(child);
  }
  return count;
}
