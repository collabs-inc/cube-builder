// Adapted from src/main/cubed/attention/adapters.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * One adapter per harness, onto the reducer's small vocabulary.
 *
 * | Reducer event          | Claude hook          | Codex                         |
 * |------------------------|----------------------|-------------------------------|
 * | `turn-opened`          | `UserPromptSubmit`   | (the floor infers it)         |
 * | `permission-requested` | `PermissionRequest`  | —                             |
 * | `turn-ended`           | `Stop`               | notify `agent-turn-complete`  |
 *
 * Codex's completion is reported as an open immediately followed by an end
 * of the same turn. Its turns are otherwise only ever inferred from output,
 * and a short turn may never have crossed the inference threshold; the
 * pair makes the end stamp either way.
 *
 * A report is capped by the hook (MAX_REPORT_BYTES), so a large
 * `tool_input` can truncate the JSON. The fields this needs come first in
 * both payloads, so a truncated report still yields them by pattern.
 */
import type { AttentionEvent } from "./state";

export interface ReportFields {
  hookEventName: string | null;
  promptId: string | null;
  type: string | null;
  turnId: string | null;
  toolName: string | null;
  toolUseId: string | null;
  internalTitle?: boolean;
  /** Claude's own conversation log for this session; the only route to a
   * terminal worker's final message, since a pty carries screen bytes. */
  transcriptPath: string | null;
  /** Codex hands the final message straight to notify. */
  lastAssistantMessage: string | null;
  /** The harness's working directory as it reports it (claude's hook `cwd`, codex notify's `cwd`). */
  cwd: string | null;
}

function pick(text: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return match ? match[1]! : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseReport(text: string): ReportFields {
  // Codex 0.154 also invokes notify for its private title-generation
  // thread, often before the user's turn ends. Its synthetic prompt is
  // identifiable even when a long user prompt truncates the report.
  const internalTitle = /"input-messages"\s*:\s*\[\s*"Generate a concise, single-line task title of at most 36 characters and under five words where possible\./.test(text);
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (json && typeof json === "object") {
      return {
        hookEventName: str(json.hook_event_name),
        promptId: str(json.prompt_id),
        type: str(json.type),
        turnId: str(json["turn-id"]),
        toolName: str(json.tool_name),
        toolUseId: str(json.tool_use_id),
        internalTitle,
        transcriptPath: str(json.transcript_path),
        lastAssistantMessage: str(json["last-assistant-message"]),
        cwd: str(json.cwd),
      };
    }
  } catch {
    // Truncated; fall through to the patterns.
  }
  return {
    hookEventName: pick(text, "hook_event_name"),
    promptId: pick(text, "prompt_id"),
    type: pick(text, "type"),
    turnId: pick(text, "turn-id"),
    toolName: pick(text, "tool_name"),
    toolUseId: pick(text, "tool_use_id"),
    internalTitle,
    // Claude's transcript_path is short and precedes tool_input, so it
    // survives truncation. Codex's last-assistant-message is the payload's
    // bulk and may itself be cut: a half message is worse than none, so a
    // report that failed to parse as JSON does not offer one.
    transcriptPath: pick(text, "transcript_path"),
    lastAssistantMessage: null,
    cwd: pick(text, "cwd"),
  };
}

export function adaptReport(fields: ReportFields, reportId: string, at: number): AttentionEvent[] {
  if (fields.internalTitle && fields.type === "agent-turn-complete") return [];
  if (fields.type === "opencode-interrupted" && fields.turnId !== null) return [{ kind: "interrupted", turn: fields.turnId, at }];
  if (fields.hookEventName !== null) {
    const turn = fields.promptId;
    const interactive = fields.toolName === "AskUserQuestion" || fields.toolName === "ExitPlanMode";
    switch (fields.hookEventName) {
      case "UserPromptSubmit":
        return [{ kind: "turn-opened", turn, at }];
      case "PermissionRequest":
        // These dialogs are tracked by PreToolUse's stable tool_use_id.
        // PermissionRequest omits that id; adding it again would never settle.
        if (interactive) return [];
        return [{ kind: "permission-requested", turn, key: reportId, at }];
      case "PreToolUse":
        return interactive && fields.toolUseId !== null
          ? [{ kind: "permission-requested", turn, key: fields.toolUseId, at }] : [];
      case "PostToolUse":
      case "PostToolUseFailure":
        return interactive && fields.toolUseId !== null
          ? [{ kind: "permission-settled", turn, key: fields.toolUseId, at }] : [];
      case "Stop":
        return [{ kind: "turn-ended", turn, at }];
      default:
        return [];
    }
  }
  if (fields.type === "agent-turn-complete" && fields.turnId !== null) {
    return [
      { kind: "turn-opened", turn: fields.turnId, at },
      { kind: "turn-ended", turn: fields.turnId, at },
    ];
  }
  return [];
}
