// Adapted from packages/components/src/Terminal/alt-screen-replay.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import { Terminal } from "@xterm/xterm";

/**
 * The client half of cubed's mode restore (src/main/cubed/terminal-modes.ts).
 * A reattach replays a trailing window prefixed with RIS (TerminalTab's
 * in-band reset), and RIS puts xterm in the normal buffer; a fullscreen TUI
 * entered the alternate screen once, long before the window starts. cubed
 * therefore prefixes a `reset` reply with `CSI ? 1049 h`. This proves that
 * prefix does what it is for — the replayed repaints land in the alternate
 * buffer, so the normal buffer grows no scrollback for a finger drag to
 * fall into — and that without it they do not. No DOM needed: `write()`
 * parses without `open()` (see utf8-frame-boundary.test.ts).
 */
const RIS = "\x1bc";
const ROWS = 24;

/** One fullscreen repaint the way an Ink frame lands: home, every row, each newline-terminated. */
function frame(n: number): string {
	let s = "\x1b[H";
	for (let i = 0; i < ROWS; i++) s += `\x1b[2Krow ${i} frame ${n}\r\n`;
	return s;
}

async function replay(prefix: string): Promise<{ type: string; normalLength: number }> {
	const term = new Terminal({ cols: 80, rows: ROWS, scrollback: 1000 });
	try {
		let stream = "$ claude\r\n\x1b[?1049h";
		for (let n = 0; n < 40; n++) stream += frame(n);
		await new Promise<void>((resolve) => term.write(stream, resolve));
		expect(term.buffer.active.type).toBe("alternate");
		// ptyd keeps only the trailing bytes: the window starts after the switch.
		const tail = stream.slice(stream.length - frame(0).length * 10);
		await new Promise<void>((resolve) => term.write(RIS + prefix + tail, resolve));
		return { type: term.buffer.active.type, normalLength: term.buffer.normal.length };
	} finally {
		term.dispose();
	}
}

describe("replaying a fullscreen TUI's trailing window", () => {
	test("with cubed's mode prefix the repaints land in the alternate buffer", async () => {
		expect(await replay("\x1b[?1049h")).toEqual({ type: "alternate", normalLength: ROWS });
	});

	test("without it they land in the normal buffer and grow scrollback — the bug", async () => {
		const result = await replay("");
		expect(result.type).toBe("normal");
		expect(result.normalLength).toBeGreaterThan(ROWS);
	});
});
