// packages/shared/src/agent-protocol.ts
//
// The client-facing shape of an `agent` item's stream: what cubed's
// `agent:open` replies, what an `agent:frame` carries, and what
// `agent:send` takes. Deliberately JSON-RPC-generic — the renderer's
// reducer and cubed's demux are the two places that know what the
// methods MEAN; this file only knows what a message IS.
import type { PipeDir } from "./pipe-records";

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRequest(m: unknown): m is JsonRpcRequest {
  return isRecordLike(m) && typeof m.method === "string" && ("id" in m) && m.id !== null && m.id !== undefined;
}

export function isNotification(m: unknown): m is JsonRpcNotification {
  return isRecordLike(m) && typeof m.method === "string" && !("id" in m);
}

export function isResponse(m: unknown): m is JsonRpcResponse {
  return isRecordLike(m) && !("method" in m) && ("id" in m) && ("result" in m || "error" in m);
}

/** One line of the pipe as a message, or null for anything that is not JSON-RPC 2.0. */
export function parseJsonRpc(text: string): JsonRpcMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecordLike(parsed) || parsed.jsonrpc !== "2.0") return null;
  if (isRequest(parsed) || isNotification(parsed) || isResponse(parsed)) return parsed;
  return null;
}

/** One pipe record, decoded: which way it went, the ring cursor just past it, and the message. */
export interface AgentRecord {
  dir: PipeDir;
  seq: number;
  message: JsonRpcMessage;
}

export interface AgentOpenParams {
  sessionId: string;
  /** Ring cursor the caller already holds; 0 or absent replays the retained tail. */
  sinceSeq?: number;
  /** Trailing-bytes bound, same contract as term:open's `maxBytes`. */
  maxBytes?: number;
}

export interface AgentOpenResult {
  sessionId: string;
  seq: number;
  /** `records` is a full replay (the cursor fell off the ring, or the reply was truncated), not a delta. */
  reset: boolean;
  records: AgentRecord[];
  /** Active turn at this replay boundary; absent on older daemons, null means idle. */
  activePrompt?: { id: JsonRpcId } | null;
  exited?: boolean;
  exitCode?: number;
  stderrTail?: string;
}

export interface AgentSendParams {
  sessionId: string;
  message: JsonRpcMessage;
}

export interface AgentFramePayload {
  sessionId: string;
  record: AgentRecord;
}

export interface AgentExitPayload {
  sessionId: string;
  exitCode: number;
}

export type AgentView = "terminal" | "conversation";

/**
 * Marks a `catalog:add-item` (or `agent:resume`) rejection caused by a ptyd
 * too old to spawn a pipe session. The rest of the message is written for
 * the user; the renderer strips this marker (`launchFailureMessage`) and
 * shows the sentence in the row message, or logs it where there is no row.
 * Substring-matched like HARNESS_MISSING_PREFIX, for the same IPC-wrapping
 * reason.
 *
 * No action hangs off it. Only an image roll fixes a stale ptyd, and the
 * sidebar's "Update this machine" button renders on a different condition
 * (a machine stranded from this app's daemon), so what the user gets is
 * the sentence — deliberately, rather than a button that would not be
 * there in this case.
 */
export const MACHINE_NEEDS_UPDATE_PREFIX = "machine-needs-update: ";

/** Marks a prompt admission refusal; the following detail identifies its state. */
export const BUSY_MARKER = "agent:busy";

/**
 * The largest single line either side may put on a pipe session's stdin.
 *
 * Not a style rule — a survival one. Every line is one record in ptyd's
 * ring and one frame on ptyd's socket, and a frame crosses that socket as a
 * JSON byte array (3.5-4x expansion) against ptyd-framing's 32 MiB cap. A
 * frame over that cap does not fail one request: it throws in the peer's
 * frame decoder, severs the connection and exits cubed, which comes back,
 * re-reads the same record and does it again. 1 MiB leaves an order of
 * magnitude of headroom, and is far above any real prompt — a phone photo
 * is the only thing that ever approaches it, and the composer downscales
 * those before they get here.
 */
export const MAX_PIPE_LINE_BYTES = 1024 * 1024;

/**
 * Marks the refusal of a message over MAX_PIPE_LINE_BYTES. The rest is
 * written for the user; the renderer strips this prefix and shows it.
 * Substring-matched like HARNESS_MISSING_PREFIX, for the same
 * IPC-wrapping reason.
 */
export const MESSAGE_TOO_LARGE_PREFIX = "message-too-large: ";

/** The one wording for that refusal, so both sides of the pipe say it the same way. */
export function messageTooLargeError(bytes: number): Error {
  return new Error(
    `${MESSAGE_TOO_LARGE_PREFIX}This message is ${Math.round(bytes / 1024)} KB; the limit is `
    + `${MAX_PIPE_LINE_BYTES / 1024} KB. Try a smaller attachment.`,
  );
}

export interface AgentLaunch {
  harness: string;
  command: string;
  args: string[];
  cwd: string;
  cwdHostPath: string;
  cwdGuestPath?: string;
  displayName: string;
}

/** A file copied to the machine hosting a conversation. */
export interface AgentFilePayload {
  contentBase64: string;
  mime: string;
  filename: string;
}
