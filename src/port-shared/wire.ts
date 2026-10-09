export interface WireRequest {
  t: "req";
  id: number;
  channel: string;
  args: unknown;
}

export interface WireResponse {
  t: "res";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface WireEvent {
  t: "evt";
  channel: string;
  payload: unknown;
}

export type WireMessage = WireRequest | WireResponse | WireEvent;

function isWireRequest(value: unknown): value is WireRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.t === "req" && typeof v.id === "number" && typeof v.channel === "string";
}

function isWireResponse(value: unknown): value is WireResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.t === "res" && typeof v.id === "number" && typeof v.ok === "boolean";
}

function isWireEvent(value: unknown): value is WireEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.t === "evt" && typeof v.channel === "string";
}

/**
 * Parses a wire protocol message from JSON text. Never throws — malformed
 * JSON, non-object payloads, and objects that fail shallow shape validation
 * for their `t` discriminant all return null.
 */
export function parseWireMessage(text: string): WireMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (isWireRequest(parsed)) return parsed;
  if (isWireResponse(parsed)) return parsed;
  if (isWireEvent(parsed)) return parsed;
  return null;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{16}$/;
const SESSION_ID_BYTES = 8;

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function hexEncode(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Encodes a binary term frame: the 8 hex-decoded bytes of `sessionId`
 * followed by the raw pty payload bytes. Throws unless `sessionId` is
 * exactly 16 lowercase hex characters.
 */
export function encodeTermFrame(sessionId: string, payload: Uint8Array): Uint8Array {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
  const frame = new Uint8Array(SESSION_ID_BYTES + payload.length);
  frame.set(hexDecode(sessionId), 0);
  frame.set(payload, SESSION_ID_BYTES);
  return frame;
}

/**
 * Decodes a binary term frame back into its session id and payload. Returns
 * null if the frame is shorter than the 8-byte session id prefix.
 */
export function decodeTermFrame(
  frame: Uint8Array,
): { sessionId: string; payload: Uint8Array } | null {
  if (frame.length < SESSION_ID_BYTES) return null;
  const sessionId = hexEncode(frame.subarray(0, SESSION_ID_BYTES));
  const payload = frame.subarray(SESSION_ID_BYTES);
  return { sessionId, payload };
}
