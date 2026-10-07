// Adapted from packages/components/src/Terminal/byte-cursor.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * Byte length of a chunk of pty output, counted the way cubed's `seq`
 * cursor counts it — raw UTF-8 bytes, never a JS string's `.length`
 * (UTF-16 code units). A binary frame's `Uint8Array.byteLength` is already
 * exact; a scrollback delta arrives pre-decoded as a JS string, where
 * `.length` undercounts every multi-byte character (box-drawing, CJK,
 * emoji — in practice, constantly, in real agent output) and would
 * desync a tile's cursor against the server's the first time one appears.
 *
 * TerminalTab uses this to advance its running seq cursor as live output
 * arrives. The attach-time half of the cursor (term:open's own response)
 * does NOT go through this — see terminal-item-logic.ts's
 * `attachScrollback`, which trusts the server's own `seq` instead of
 * recomputing one, since only that value is correct across a `reset`.
 */
export function byteLengthOf(chunk: string | Uint8Array): number {
	return typeof chunk === "string" ? new TextEncoder().encode(chunk).length : chunk.byteLength;
}
