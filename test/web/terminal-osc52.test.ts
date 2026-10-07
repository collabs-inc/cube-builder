// Adapted from packages/components/src/Terminal/osc52.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import { decodeOsc52Write } from "../../src/components/Terminal/osc52";

describe("decodeOsc52Write", () => {
	test("decodes a clipboard write", () => {
		expect(decodeOsc52Write(`c;${btoa("hello")}`)).toBe("hello");
	});

	test("decodes multi-byte UTF-8", () => {
		const text = "héllo → 世界";
		const b64 = btoa(String.fromCodePoint(...new TextEncoder().encode(text)));
		expect(decodeOsc52Write(`c;${b64}`)).toBe(text);
	});

	test("accepts any selection spec, including empty and multi-char", () => {
		expect(decodeOsc52Write(`;${btoa("x")}`)).toBe("x");
		expect(decodeOsc52Write(`pc0;${btoa("x")}`)).toBe("x");
	});

	test("an empty payload clears the clipboard (empty string)", () => {
		expect(decodeOsc52Write("c;")).toBe("");
	});

	test("rejects a read query — the clipboard is write-only to the remote", () => {
		expect(decodeOsc52Write("c;?")).toBeNull();
	});

	test("rejects invalid base64", () => {
		expect(decodeOsc52Write("c;not base64!!")).toBeNull();
	});

	test("rejects a payload with no selection separator", () => {
		expect(decodeOsc52Write(btoa("hello"))).toBeNull();
	});
});
