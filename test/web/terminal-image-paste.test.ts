// Adapted from packages/components/src/Terminal/image-paste.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import { bytesToBase64, imageFileFromClipboard, imageFromClipboardItems } from "../../src/components/Terminal/image-paste";

function item(kind: string, type: string, file: unknown = null) {
	return { kind, type, getAsFile: () => file as File | null };
}

describe("imageFileFromClipboard", () => {
	test("returns the first image file item", () => {
		const png = { name: "x.png" };
		const data = { items: [item("string", "text/plain"), item("file", "image/png", png)] };
		expect(imageFileFromClipboard(data)).toBe(png as File);
	});

	test("ignores non-image files and string items", () => {
		const data = { items: [item("file", "application/pdf", { name: "a.pdf" })] };
		expect(imageFileFromClipboard(data)).toBeNull();
		expect(imageFileFromClipboard({ items: [] })).toBeNull();
		expect(imageFileFromClipboard(null)).toBeNull();
		expect(imageFileFromClipboard({})).toBeNull();
	});
});

describe("bytesToBase64", () => {
	test("encodes bytes the way the daemon decodes them", () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		expect(bytesToBase64(bytes)).toBe(btoa("\x89PNG"));
	});

	test("survives payloads far beyond one call-stack of arguments", () => {
		const big = new Uint8Array(300_000).fill(65);
		const encoded = bytesToBase64(big);
		expect(atob(encoded).length).toBe(300_000);
		expect(encoded.startsWith("QUFB")).toBe(true);
	});
});

function readItem(types: string[], blobs: Record<string, Blob> = {}) {
	return {
		types,
		getType: async (type: string) => {
			const blob = blobs[type];
			if (!blob) throw new Error(`no ${type}`);
			return blob;
		},
	};
}

describe("imageFromClipboardItems", () => {
	// The Cmd+V path reads a paste event's clipboardData, which carries
	// the bytes outright. Ctrl+V on macOS fires no paste event at all, so
	// the only way to see the clipboard is to ask for it — a different
	// shape, and asynchronous.
	const png = new Blob(["x"], { type: "image/png" });

	test("returns the first image type on the item, with its mime", async () => {
		const items = [readItem(["text/plain", "image/png"], { "image/png": png })];
		expect(await imageFromClipboardItems(items)).toEqual({ blob: png, mime: "image/png" });
	});

	test("skips an item that offers no image and keeps looking", async () => {
		const items = [readItem(["text/plain"]), readItem(["image/png"], { "image/png": png })];
		expect(await imageFromClipboardItems(items)).toEqual({ blob: png, mime: "image/png" });
	});

	test("answers null when the clipboard holds no image", async () => {
		expect(await imageFromClipboardItems([readItem(["text/plain"])])).toBeNull();
		expect(await imageFromClipboardItems([])).toBeNull();
		expect(await imageFromClipboardItems(null)).toBeNull();
	});
});
