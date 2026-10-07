// Adapted from packages/components/src/Terminal/sanitizeAgentTitle.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, test, expect } from "vitest";
import { sanitizeAgentTitle } from "../../src/components/Terminal/sanitizeAgentTitle";

describe("sanitizeAgentTitle", () => {
	test("passes through a clean title unchanged", () => {
		expect(sanitizeAgentTitle("fixing auth bug")).toBe("fixing auth bug");
	});

	test("strips control characters", () => {
		expect(sanitizeAgentTitle("fix\x00\x1fbug\x7f")).toBe("fix bug");
	});

	test("collapses whitespace runs to a single space", () => {
		expect(sanitizeAgentTitle("fix   auth\t\tbug")).toBe("fix auth bug");
	});

	test("trims leading and trailing whitespace", () => {
		expect(sanitizeAgentTitle("  fixing bug  ")).toBe("fixing bug");
	});

	test("caps length at 60 characters", () => {
		const long = "a".repeat(100);
		expect(sanitizeAgentTitle(long)).toBe("a".repeat(60));
	});

	test("returns empty string for a title that's only control characters", () => {
		expect(sanitizeAgentTitle("\x00\x1f\x7f")).toBe("");
	});

	test("strips bidi override characters", () => {
		expect(sanitizeAgentTitle("fix‮bug")).toBe("fix bug");
	});

	test("strips bidi isolate characters", () => {
		expect(sanitizeAgentTitle("fix⁦bug⁩")).toBe("fix bug");
	});

	test("strips zero-width characters", () => {
		expect(sanitizeAgentTitle("fix​bug")).toBe("fix bug");
	});

	test("defuses a Trojan Source-style label spoof", () => {
		// U+202E (RIGHT-TO-LEFT OVERRIDE) would make a terminal render the
		// text after it in reverse, e.g. disguising "exe.txt" as "txt.exe".
		// Stripping the override char (rather than merely escaping it)
		// removes the spoof: the remaining characters render in their
		// literal, logical order.
		expect(sanitizeAgentTitle("safe‮txt.exe")).toBe("safe txt.exe");
	});
});
