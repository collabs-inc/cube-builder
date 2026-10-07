// Adapted from packages/components/src/Terminal/osc-open-url.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import { decodeOscOpenUrl, OSC_OPEN_URL } from "../../src/components/Terminal/osc-open-url";

describe("decodeOscOpenUrl", () => {
	test("the code matches the shim's (shell-wrappers.ts writes it)", () => {
		expect(OSC_OPEN_URL).toBe(5522);
	});

	test("accepts http and https URLs verbatim", () => {
		expect(decodeOscOpenUrl("https://example.com/auth?code=1&x=2")).toBe(
			"https://example.com/auth?code=1&x=2",
		);
		expect(decodeOscOpenUrl("http://localhost:1455/auth")).toBe("http://localhost:1455/auth");
	});

	test("rejects every non-http(s) scheme", () => {
		expect(decodeOscOpenUrl("file:///etc/passwd")).toBeNull();
		expect(decodeOscOpenUrl("javascript:alert(1)")).toBeNull();
		expect(decodeOscOpenUrl("cubecomputer://x")).toBeNull();
	});

	test("rejects the empty payload and whitespace or control characters", () => {
		expect(decodeOscOpenUrl("")).toBeNull();
		expect(decodeOscOpenUrl("https://a b")).toBeNull();
		expect(decodeOscOpenUrl("https://a\x07b")).toBeNull();
		expect(decodeOscOpenUrl("https://a\nb")).toBeNull();
	});

	test("rejects an absurdly long payload", () => {
		expect(decodeOscOpenUrl(`https://x.com/${"a".repeat(5000)}`)).toBeNull();
	});
});
