// `terminal_command_sent`: the user submitted typed input in a terminal
// pane. Fed by xterm's onData — the one path every human keystroke takes —
// so programmatic typing (type-into-terminal.ts, which writes through the
// pty service directly) never counts.
//
// The event is "submitted something they typed", not "ran a command": a
// terminal has no way to know whether Enter went to a shell, a coding
// agent's prompt, or a `y/n` question without reading content, which this
// app never does. The typed-since-last-Enter flag is what keeps the count
// honest without content: a bare Enter (an idle prompt, a TUI menu chosen
// with the arrow keys) reports nothing.
import type { AnalyticsEventMap } from "@port/shared/analytics";
import { terminalTargetKind } from "@port/shared/analytics";
import { LOCAL_MACHINE_ID } from "@port/shared/types";

export type CommandKind = AnalyticsEventMap["terminal_command_sent"]["kind"];

// CSI sequences (arrows, function keys, bracketed-paste markers) and the
// lone ESC that xterm sends for the Escape key.
// eslint-disable-next-line no-control-regex -- matching ESC is the point
const CONTROL_SEQUENCES = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])?/g;

function hasPrintable(text: string): boolean {
  for (const ch of text.replace(CONTROL_SEQUENCES, "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) return true;
  }
  return false;
}

/**
 * One detector per terminal pane. Returns the kind of command a chunk of
 * user input completes, or null when it completes none.
 */
export function createCommandDetector(): (chunk: string) => CommandKind | null {
  let typed = false;
  return (chunk) => {
    const submits = chunk.includes("\r") || chunk.includes("\n");
    if (!submits) {
      if (hasPrintable(chunk)) typed = true;
      return null;
    }
    const printableInChunk = hasPrintable(chunk);
    const kind: CommandKind | null =
      printableInChunk && /[\r\n]/.test(chunk.replace(/[\r\n]+$/, ""))
        ? "paste"
        : printableInChunk || typed
          ? "enter"
          : null;
    typed = false;
    return kind;
  };
}

export function terminalCommandProps(
  item: { target?: string; machineId: string },
  kind: CommandKind,
): AnalyticsEventMap["terminal_command_sent"] {
  return {
    target: terminalTargetKind(item.target),
    machine: item.machineId === LOCAL_MACHINE_ID ? "local" : "cloud",
    kind,
  };
}
