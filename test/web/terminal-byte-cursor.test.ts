// Adapted from packages/components/src/Terminal/byte-cursor.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, test, expect } from "vitest";
import { byteLengthOf } from "../../src/components/Terminal/byte-cursor";

describe("byteLengthOf", () => {
	test("ASCII string: byte length equals character count", () => {
		expect(byteLengthOf("hello")).toBe(5);
	});

	test("multi-byte string: byte length exceeds the JS string's own .length — using "
		+ ".length here would desync the cursor against cubed's byte-counted seq", () => {
		const s = "日本語";
		expect(s.length).toBe(3); // UTF-16 code units — NOT what cubed counts
		expect(byteLengthOf(s)).toBe(9); // 3 bytes per CJK character in UTF-8
	});

	test("binary chunk: Uint8Array.byteLength passes through unchanged", () => {
		const chunk = new TextEncoder().encode("日本語");
		expect(byteLengthOf(chunk)).toBe(chunk.byteLength);
		expect(byteLengthOf(chunk)).toBe(9);
	});

	test("byte lengths are additive across an arbitrary split, including one that "
		+ "falls mid-codepoint — NOTE: this only checks that summing counts is "
		+ "exact, which holds for any split of any bytes; it says nothing about "
		+ "whether the split bytes decode to the right characters when rendered. "
		+ "That decode-safety property belongs to xterm.js's own persistent "
		+ "Utf8ToUtf32 decoder (verified by inspection of @xterm/xterm's source — "
		+ "see TerminalTab.tsx's onSeqAdvance doc comment), which this test does "
		+ "not and cannot exercise: byteLengthOf never decodes anything, it only "
		+ "counts.", () => {
		const full = new TextEncoder().encode("日本語");
		// Split mid-codepoint (each CJK char is 3 bytes).
		const first = full.slice(0, 4);
		const second = full.slice(4);
		expect(byteLengthOf(first) + byteLengthOf(second)).toBe(byteLengthOf(full));
	});
});
