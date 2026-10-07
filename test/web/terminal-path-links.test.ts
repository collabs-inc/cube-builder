// Adapted from packages/components/src/Terminal/path-links.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Issue #25 — file paths in terminal output. Detection is deliberately
 * conservative: a token must contain a `/` and end in a file-looking
 * segment (a dotted name, or an explicit :line[:col] suffix), because a
 * false link on prose is worse than a missed link on an exotic path. URLs
 * never match — they are the web-links addon's, and double-linking one
 * region makes xterm's hover behavior ambiguous.
 */
import { describe, expect, test } from "vitest";
import { detectPathLinks } from "../../src/components/Terminal/path-links";

const texts = (line: string, allowAbsolute = true): string[] =>
	detectPathLinks(line, { allowAbsolute }).map((l) => l.text);

describe("detectPathLinks", () => {
	test("finds a relative path in prose", () => {
		expect(texts("edited src/main/foo.ts just now")).toEqual(["src/main/foo.ts"]);
	});

	test("keeps a :line[:col] suffix as part of the link text", () => {
		expect(texts("at src/a.ts:12:3 in build")).toEqual(["src/a.ts:12:3"]);
	});

	test("finds dot-relative and parent-relative paths", () => {
		expect(texts("see ./a/b.c and ../lib/util.js")).toEqual(["./a/b.c", "../lib/util.js"]);
	});

	test("unwraps common punctuation around the path", () => {
		expect(texts("(src/a.ts) [src/b.ts], 'src/c.ts'.")).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
	});

	test("reports the range of each match", () => {
		const [link] = detectPathLinks("XX src/a.ts YY", { allowAbsolute: true });
		expect(link).toEqual({ text: "src/a.ts", start: 3, end: 11 });
	});

	test("absolute paths obey allowAbsolute", () => {
		expect(texts("at /abs/x.py, line 3")).toEqual(["/abs/x.py"]);
		expect(texts("at /abs/x.py but rel/y.ts too", false)).toEqual(["rel/y.ts"]);
	});

	test("never matches inside a URL", () => {
		expect(texts("open https://example.com/a/b.html now")).toEqual([]);
	});

	test("ignores bare filenames and directory-looking tokens", () => {
		expect(texts("run package.json alone")).toEqual([]);
		expect(texts("cd src/main and look")).toEqual([]);
	});

	test("a directory-looking token with a line suffix is a path after all", () => {
		expect(texts("at src/Makefile:12")).toEqual(["src/Makefile:12"]);
	});
});
