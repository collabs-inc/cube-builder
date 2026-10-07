// Adapted from packages/components/src/Terminal/dictation-sync.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import { planInsert } from "../../src/components/Terminal/dictation-sync";

const DEL = "\x7f";

describe("planInsert", () => {
  test("first update with nothing synced sends the whole value", () => {
    expect(planInsert("", "so", "so")).toEqual({ send: "so", synced: "so" });
  });

  test("a cumulative transcript sends only the unsynced tail", () => {
    let s = "";
    const out: string[] = [];
    for (const v of ["so", "so this", "so this is", "so this is me"]) {
      const p = planInsert(s, v, v);
      out.push(p.send);
      s = p.synced;
    }
    expect(out.join("")).toBe("so this is me");
  });

  test("an identical re-fire sends nothing", () => {
    expect(planInsert("so this", "so this", "so this").send).toBe("");
  });

  test("a revision backspaces past the common prefix and retypes the tail", () => {
    const p = planInsert("testing this speech to", "testing  to", "testing  to");
    expect(p.send).toBe(DEL.repeat("this speech to".length) + " to");
    expect(p.synced).toBe("testing  to");
  });

  test("backspaces count code points, not UTF-16 units", () => {
    expect(planInsert("a😀", "ab", "ab").send).toBe(DEL + "b");
  });

  test("no common prefix (field was emptied behind us) sends data and never a DEL", () => {
    const p = planInsert("so this is", "ls", "ls");
    expect(p.send).toBe("ls");
    expect(p.synced).toBe("ls");
  });

  test("an empty field resets sync and forwards data (xterm's own path)", () => {
    expect(planInsert("stale", "", "😀")).toEqual({ send: "😀", synced: "" });
  });

  test("one-character input accumulating in the field (emoji picker) sends each once", () => {
    const a = planInsert("", "😀", "😀");
    const b = planInsert(a.synced, "😀🎉", "🎉");
    expect(a.send + b.send).toBe("😀🎉");
  });
});
