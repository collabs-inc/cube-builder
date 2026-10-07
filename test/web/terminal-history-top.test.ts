// Adapted from packages/components/src/Terminal/history-top.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import { isHistoryTopGesture } from "../../src/components/Terminal/history-top";

const atTop = { viewportY: 0, bufferType: "normal" as const, bufferLength: 500, rows: 24 };

describe("isHistoryTopGesture", () => {
	test("an upward gesture at the top of a normal buffer with scrollback", () => {
		expect(isHistoryTopGesture(atTop, "up")).toBe(true);
	});
	test("not downward, not mid-buffer, not the alternate screen, not a short buffer", () => {
		expect(isHistoryTopGesture(atTop, "down")).toBe(false);
		expect(isHistoryTopGesture({ ...atTop, viewportY: 3 }, "up")).toBe(false);
		expect(isHistoryTopGesture({ ...atTop, bufferType: "alternate" }, "up")).toBe(false);
		expect(isHistoryTopGesture({ ...atTop, bufferLength: 24 }, "up")).toBe(false);
	});
});
