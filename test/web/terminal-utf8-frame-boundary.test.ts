// Adapted from packages/components/src/Terminal/utf8-frame-boundary.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, test, expect } from "vitest";
import { Terminal } from "@xterm/xterm";

/**
 * TerminalTab feeds every live pty:data frame straight to `term.write()` as
 * a raw `Uint8Array` — never decoded to a string first (see its
 * `handleData`/`flushData`). This test proves the property that design
 * depends on: `@xterm/xterm`'s `Terminal` holds its own persistent decoder
 * across `write()` calls (a `Utf8ToUtf32` instance created once per
 * `Terminal`, confirmed by inspecting the built package), so a multi-byte
 * character split across two separate frames — exactly what a real pty
 * byte stream does constantly — still renders as the original character,
 * not mojibake or a dropped byte. No DOM/React/WebGL needed: `write()`
 * parses into the internal buffer without `.open()`, so this runs as a
 * plain unit test, unlike TerminalTab itself (see its own doc comment for
 * why that one isn't component-tested).
 */
describe("xterm Utf8ToUtf32 decoding across a delta frame boundary", () => {
	test("a UTF-8 character split mid-codepoint across two writes decodes intact", async () => {
		const term = new Terminal({ cols: 80, rows: 24 });
		try {
			const full = new TextEncoder().encode("日本語\r\n");
			// Each CJK character is 3 bytes; split after 4 bytes lands inside
			// the second character's encoding, not on a character boundary.
			const first = full.slice(0, 4);
			const second = full.slice(4);

			await new Promise<void>((resolve) => {
				term.write(first);
				term.write(second, () => resolve());
			});

			expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("日本語");
		} finally {
			term.dispose();
		}
	});

	test("an ASCII-only split would pass even with a broken decoder — the "
		+ "control case the brief warns an ASCII-only suite hides", async () => {
		const term = new Terminal({ cols: 80, rows: 24 });
		try {
			const full = new TextEncoder().encode("hello\r\n");
			const first = full.slice(0, 3);
			const second = full.slice(3);

			await new Promise<void>((resolve) => {
				term.write(first);
				term.write(second, () => resolve());
			});

			expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
		} finally {
			term.dispose();
		}
	});
});
