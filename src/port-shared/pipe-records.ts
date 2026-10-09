// packages/shared/src/pipe-records.ts
//
// The record framing a ptyd PIPE session keeps in its ring and forwards on
// the wire. A PTY ring holds raw output bytes because a terminal echoes its
// input; a pipe has no echo, so the ring holds BOTH directions and each
// record says which one it is. ptyd never looks inside a payload — this is
// framing, not interpretation. Cursor arithmetic (`seq`) counts encoded
// bytes, header included, so a forwarded frame's length is exactly what
// the ring grew by.
export type PipeDir = "in" | "out";

export const PIPE_RECORD_HEADER_BYTES = 5;
const DIR_IN = 0;
const DIR_OUT = 1;

export interface PipeRecord {
  dir: PipeDir;
  payload: Uint8Array;
}

export function encodePipeRecord(dir: PipeDir, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(PIPE_RECORD_HEADER_BYTES + payload.length);
  out[0] = dir === "in" ? DIR_IN : DIR_OUT;
  const len = payload.length;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, PIPE_RECORD_HEADER_BYTES);
  return out;
}

/**
 * Decodes every complete record at the front of `bytes`. `rest` is the
 * trailing partial record, if any — a caller that reads whole records
 * (every ring read and every forwarded frame is record-aligned) always
 * gets an empty `rest`, so a non-empty one means the caller's cursor was
 * not a record boundary.
 */
export function decodePipeRecords(bytes: Uint8Array): { records: PipeRecord[]; rest: Uint8Array } {
  const records: PipeRecord[] = [];
  let at = 0;
  while (bytes.length - at >= PIPE_RECORD_HEADER_BYTES) {
    const dirByte = bytes[at]!;
    const len =
      ((bytes[at + 1]! << 24) >>> 0) + (bytes[at + 2]! << 16) + (bytes[at + 3]! << 8) + bytes[at + 4]!;
    if (bytes.length - at - PIPE_RECORD_HEADER_BYTES < len) break;
    let dir: PipeDir;
    if (dirByte === DIR_IN) dir = "in";
    else if (dirByte === DIR_OUT) dir = "out";
    else throw new Error(`pipe-records: unknown direction byte ${dirByte}`);
    const start = at + PIPE_RECORD_HEADER_BYTES;
    records.push({ dir, payload: bytes.subarray(start, start + len) });
    at = start + len;
  }
  return { records, rest: bytes.subarray(at) };
}
