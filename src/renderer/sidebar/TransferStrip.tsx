// The sidebar's drop status strip: hint text while a file drag hovers a
// drop target, per-file progress during sends, and refusals that wait to
// be dismissed (they name files the user has to act on). Pinned to the
// sidebar's bottom edge — a scrim centered over a 240px column would cover
// the rows the user is aiming at. One component for both sidebar view
// modes; the class names predate the extraction and are shared.
import type { TerminalTransfer } from "@builder/components/Terminal/file-drop";
import "./styles/TransferStrip.css";

interface TransferStripProps {
  /** "Copy here" / "Upload here" while a drag hovers a target, else null. */
  hint: string | null;
  transfer: TerminalTransfer | null;
  onDismiss: () => void;
}

export function TransferStrip({ hint, transfer, onDismiss }: TransferStripProps) {
  if (hint === null && transfer === null) return null;
  return (
    <div className="nav-transfer-strip" role="status">
      {transfer === null || (transfer.kind === "errors" && hint !== null) ? (
        // A new external drag hovering a target wins over a persisted
        // refusal from a previous drop — otherwise the strip would show
        // last drop's stale error instead of the current drag's hint
        // until the next drop's first onProgress overwrites it.
        <span className="nav-transfer-hint">{hint}</span>
      ) : transfer.kind === "sending" ? (
        <span className="nav-transfer-sending" title={transfer.name}>
          Sending <strong className="nav-transfer-file-name">{transfer.name}</strong>
          {transfer.total > 1 ? ` (${transfer.index} of ${transfer.total})` : ""}
        </span>
      ) : (
        <>
          <div className="nav-transfer-errors">
            {transfer.messages.map((m) => (
              <div key={m}>{m}</div>
            ))}
          </div>
          <button type="button" className="nav-transfer-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
