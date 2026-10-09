import { describe, test, expect } from "vitest";
import {
  validateUrl,
  validateWorkspaceBoundary,
  sanitizeFilename,
  fixMalformedLinkedImages,
  buildFrontmatter,
} from "./import-service";

describe("validateUrl", () => {
  test("accepts http URLs", () => {
    expect(() => validateUrl("http://example.com")).not.toThrow();
  });

  test("accepts https URLs", () => {
    expect(() => validateUrl("https://example.com/path")).not.toThrow();
  });

  test("rejects ftp URLs", () => {
    expect(() => validateUrl("ftp://example.com")).toThrow(
      /Only http and https/,
    );
  });

  test("rejects javascript: URLs", () => {
    expect(() => validateUrl("javascript:alert(1)")).toThrow(
      /Only http and https/,
    );
  });

  test("rejects invalid URLs", () => {
    expect(() => validateUrl("not a url")).toThrow(/Invalid URL/);
  });

  test("rejects empty string", () => {
    expect(() => validateUrl("")).toThrow(/Invalid URL/);
  });
});

describe("validateWorkspaceBoundary", () => {
  test("accepts exact workspace root", () => {
    expect(() =>
      validateWorkspaceBoundary("/workspace", "/workspace"),
    ).not.toThrow();
  });

  test("accepts subdirectory of workspace", () => {
    expect(() =>
      validateWorkspaceBoundary("/workspace/sub/dir", "/workspace"),
    ).not.toThrow();
  });

  test("rejects path outside workspace", () => {
    expect(() =>
      validateWorkspaceBoundary("/other/dir", "/workspace"),
    ).toThrow(/outside workspace/);
  });

  test("rejects partial prefix match", () => {
    expect(() =>
      validateWorkspaceBoundary("/workspace-extra", "/workspace"),
    ).toThrow(/outside workspace/);
  });
});

describe("sanitizeFilename", () => {
  test("removes path separators", () => {
    expect(sanitizeFilename("foo/bar\\baz")).toBe("foobarbaz");
  });

  test("removes special characters", () => {
    expect(sanitizeFilename('a:b*c?"d<e>f|g')).toBe("abcdefg");
  });

  test("collapses whitespace", () => {
    expect(sanitizeFilename("hello   world")).toBe("hello world");
  });

  test("trims whitespace", () => {
    expect(sanitizeFilename("  hello  ")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(sanitizeFilename("")).toBe("");
  });
});

describe("fixMalformedLinkedImages", () => {
  test("fixes multiline linked image", () => {
    const input = `[
  ![alt](image.png)
  ](https://link.com)`;
    expect(fixMalformedLinkedImages(input)).toBe(
      "[![alt](image.png)](https://link.com)",
    );
  });

  test("leaves well-formed markdown alone", () => {
    const input = "[![alt](image.png)](https://link.com)";
    expect(fixMalformedLinkedImages(input)).toBe(input);
  });

  test("leaves plain images alone", () => {
    const input = "![alt](image.png)";
    expect(fixMalformedLinkedImages(input)).toBe(input);
  });
});

describe("buildFrontmatter", () => {
  test("builds YAML frontmatter with JSON-encoded values", () => {
    const result = buildFrontmatter({ type: "article", url: "https://x.com" });
    expect(result).toBe(
      '---\ntype: "article"\nurl: "https://x.com"\n---',
    );
  });

  test("omits undefined values", () => {
    const result = buildFrontmatter({
      type: "article",
      author: undefined,
      url: "https://x.com",
    });
    expect(result).toBe(
      '---\ntype: "article"\nurl: "https://x.com"\n---',
    );
  });

  test("produces empty frontmatter when all values are undefined", () => {
    const result = buildFrontmatter({ a: undefined, b: undefined });
    expect(result).toBe("---\n---");
  });
});
