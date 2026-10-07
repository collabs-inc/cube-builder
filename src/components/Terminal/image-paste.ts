// Adapted from packages/components/src/Terminal/image-paste.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * The client-side half of pasting a clipboard image into a terminal
 * whose pty runs on another machine (issue #13): pick the image out of
 * the clipboard, base64 it for the wire, and let TerminalTab ship it via
 * `ptyStashFile` — which resolves to a machine-native path the tab then
 * types at the pty, the same shape a drag-dropped file takes.
 *
 * Structural clipboard type rather than DataTransfer so the logic tests
 * without a real ClipboardEvent, which happy-dom cannot mint with files.
 */
/**
 * What a paste is called while it is on its way. One constant because
 * the two routes into it — a Cmd+V paste event and macOS's Ctrl+V
 * clipboard read — must not describe the same act differently.
 *
 * Not the file's own name, even when the clipboard carries one (a Finder
 * copy does): the daemon discards a paste's filename by design and
 * generates `paste-<uuid8>.<ext>`, so reporting `Screenshot.png` would
 * promise the pty a name it never receives.
 */
export const PASTED_IMAGE_LABEL = "pasted image";

export interface ClipboardLike {
	items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>;
}

export function imageFileFromClipboard(
	data: ClipboardLike | null | undefined,
): File | null {
	const items = data?.items;
	if (!items) return null;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item || item.kind !== "file" || !item.type.startsWith("image/")) continue;
		const file = item.getAsFile();
		if (file) return file;
	}
	return null;
}

/** One entry of `navigator.clipboard.read()`'s answer — the async
 *  clipboard shape, as opposed to a paste event's `clipboardData`. */
export interface ClipboardReadItem {
	readonly types: readonly string[];
	getType(type: string): Promise<Blob>;
}

/**
 * Finds an image on the ASYNC clipboard. The paste-event path above needs
 * none of this — `clipboardData` carries the bytes outright — but Ctrl+V
 * on macOS fires no paste event, so the only way to see the clipboard is
 * to ask for it, which is asynchronous and a different shape entirely.
 *
 * Rejections are the caller's to handle: reading the clipboard can fail
 * for want of permission or a user gesture, and from here that is
 * indistinguishable from "no image", which the caller treats the same way.
 */
export async function imageFromClipboardItems(
	items: readonly ClipboardReadItem[] | null | undefined,
): Promise<{ blob: Blob; mime: string } | null> {
	for (const item of items ?? []) {
		const mime = item.types.find((type) => type.startsWith("image/"));
		if (mime === undefined) continue;
		return { blob: await item.getType(mime), mime };
	}
	return null;
}

/** Chunked btoa: one String.fromCharCode(...bytes) call over megabytes
 * of screenshot overflows the argument stack. */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
