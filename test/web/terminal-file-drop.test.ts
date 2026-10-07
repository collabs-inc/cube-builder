// Adapted from packages/components/src/Terminal/file-drop.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * The client-side half of dragging a local file into a terminal whose
 * pty runs on another machine: read the drop, refuse what cannot be
 * sent, ship the rest one at a time.
 */
import { describe, expect, test } from "vitest";
import { dropContents, quoteForShell, sendDroppedFiles } from "../../src/components/Terminal/file-drop";

/** A drop item, minted with only the fields `dropContents` reads —
 *  a real DataTransferItem carries far more, none of it consulted. */
function item(name: string, isDirectory: boolean) {
  return {
    kind: "file",
    webkitGetAsEntry: () => ({ isDirectory }),
    getAsFile: () => ({ name, size: 10 }) as unknown as File,
  };
}

describe("dropContents", () => {
  test("separates files from folders", () => {
    const { files, folderNames } = dropContents({
      items: [item("report.csv", false), item("src", true), item("logo.png", false)],
    });
    expect(files.map((f) => f.name)).toEqual(["report.csv", "logo.png"]);
    expect(folderNames).toEqual(["src"]);
  });

  test("skips non-file items such as a dragged text selection", () => {
    const { files, folderNames } = dropContents({
      items: [{ kind: "string", webkitGetAsEntry: () => null, getAsFile: (): File | null => null }],
    });
    expect(files).toEqual([]);
    expect(folderNames).toEqual([]);
  });

  test("falls back to the plain file list when no items are exposed", () => {
    // Without `items` there is no synchronous way to spot a directory,
    // so everything reads as a file — better than dropping the whole
    // gesture on the floor.
    const { files, folderNames } = dropContents({
      files: [{ name: "a.txt", size: 1 } as unknown as File],
    });
    expect(files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(folderNames).toEqual([]);
  });

  test("reports nothing for an empty drop", () => {
    expect(dropContents(null)).toEqual({ files: [], folderNames: [] });
  });
});

describe("sendDroppedFiles", () => {
  const file = (name: string, size: number): { name: string; size: number } => ({ name, size });

  test("stashes each file in order and returns the paths in that order", async () => {
    const sent: string[] = [];
    const result = await sendDroppedFiles([file("a.txt", 1), file("b.txt", 1)], {
      stash: async (f) => {
        sent.push(f.name);
        return `/stash/${f.name}`;
      },
    });
    expect(sent).toEqual(["a.txt", "b.txt"]);
    expect(result.paths).toEqual(["/stash/a.txt", "/stash/b.txt"]);
    expect(result.errors).toEqual([]);
  });

  test("reports progress per file, one-based, with the total", async () => {
    const seen: string[] = [];
    await sendDroppedFiles([file("a.txt", 1), file("b.txt", 1)], {
      stash: async (f) => `/stash/${f.name}`,
      onProgress: (p) => seen.push(`${p.index}/${p.total} ${p.name}`),
    });
    expect(seen).toEqual(["1/2 a.txt", "2/2 b.txt"]);
  });

  test("refuses an oversized file without sending a byte of it", async () => {
    const sent: string[] = [];
    const result = await sendDroppedFiles([file("huge.zip", 20)], {
      maxBytes: 10,
      stash: async (f) => {
        sent.push(f.name);
        return "/stash/huge.zip";
      },
    });
    expect(sent).toEqual([]);
    expect(result.paths).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("huge.zip");
  });

  test("one failure does not strand the files after it", async () => {
    const result = await sendDroppedFiles([file("a.txt", 1), file("b.txt", 1), file("c.txt", 1)], {
      stash: async (f) => {
        if (f.name === "b.txt") throw new Error("daemon said no");
        return `/stash/${f.name}`;
      },
    });
    expect(result.paths).toEqual(["/stash/a.txt", "/stash/c.txt"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("b.txt");
    expect(result.errors[0]).toContain("daemon said no");
  });

  test("does nothing at all for an empty drop", async () => {
    let called = false;
    const result = await sendDroppedFiles([], {
      stash: async () => {
        called = true;
        return "";
      },
    });
    expect(called).toBe(false);
    expect(result).toEqual({ paths: [], errors: [] });
  });
});

describe("quoteForShell", () => {
  test("wraps a path so a shell reads it as one word", () => {
    expect(quoteForShell("/tmp/my file.txt")).toBe("'/tmp/my file.txt'");
  });

  test("survives a single quote in the name", () => {
    // The classic break: a naive wrap would end the quoted run early and
    // hand the rest of the name to the shell as code.
    expect(quoteForShell("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'");
  });
});
