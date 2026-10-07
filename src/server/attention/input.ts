// Adapted from src/main/cubed/attention/input.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
/**
 * xterm sends device replies through the same wire as typing. Ignore its
 * CSI/OSC/DCS traffic (including focus and mouse reports) when deciding
 * whether a user has submitted text to an agent. A bare Enter in a startup
 * dialog and an unsubmitted draft are not prompts. State survives packets.
 * Text inside bracketed paste still counts; its CSI delimiters do not.
 */
export class AttentionInputParser {
  private mode: "text" | "esc" | "csi" | "string" | "string-esc" = "text";
  private draftBytes = 0;
  private draftPrefix = "";
  // Picker arrows and confirmations are not history recall. Stay in this
  // mode across nested pickers (model, then effort) until new text arrives.
  private modelPicker = false;
  private csi = "";
  private pasting = false;

  /**
   * Input messages preserve xterm's onData boundaries: Escape is a lone
   * ESC, while terminal replies and Alt/arrow keys carry a whole sequence.
   * Neither bytes inside a paste nor a control sequence can cancel a turn.
   */
  takeInterrupt(bytes: Uint8Array): boolean {
    if (this.mode !== "text" || this.pasting || bytes.length !== 1 || (bytes[0] !== 0x1b && bytes[0] !== 0x03)) return false;
    return true;
  }

  discardDraft(): void {
    this.draftBytes = 0;
    this.draftPrefix = "";
    this.modelPicker = false;
  }

  feed(bytes: Uint8Array): boolean {
    let typed = false;
    for (const byte of bytes) {
      switch (this.mode) {
        case "text":
          if (byte === 0x1b) this.mode = "esc";
          else if (!this.pasting && (byte === 0x0d || byte === 0x0a)) {
            const modelCommand = /^\s*\/models?(?:\s|$)/.test(this.draftPrefix);
            typed ||= this.draftBytes > 0 && !modelCommand;
            if (modelCommand) this.modelPicker = true;
            this.draftBytes = 0;
            this.draftPrefix = "";
          } else if (byte === 0x7f || byte === 0x08) {
            this.draftBytes = Math.max(0, this.draftBytes - 1);
            this.draftPrefix = this.draftPrefix.slice(0, this.draftBytes);
          } else if (byte === 0x03 || byte === 0x15) this.discardDraft();
          else if (byte >= 0x20) {
            this.modelPicker = false;
            if (this.draftBytes < 128) this.draftPrefix += String.fromCharCode(byte);
            this.draftBytes = Math.min(1_000_000, this.draftBytes + 1);
          }
          break;
        case "esc":
          if (byte === 0x5b || byte === 0x4f) { this.mode = "csi"; this.csi = ""; }
          else if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(byte)) this.mode = "string";
          else this.mode = byte === 0x1b ? "esc" : "text";
          break;
        case "csi":
          if (byte === 0x1b) this.mode = "esc";
          else {
            this.csi = (this.csi + String.fromCharCode(byte)).slice(-32);
            if (byte >= 0x40 && byte <= 0x7e) {
              if (this.csi === "200~") this.pasting = true;
              if (this.csi === "201~") this.pasting = false;
              // Up/Down may load a history entry without sending its text.
              // Navigation alone is never a submission; a later Enter is.
              if (!this.modelPicker && (this.csi === "A" || this.csi === "B")) this.draftBytes = Math.max(1, this.draftBytes);
              this.mode = "text";
            }
          }
          break;
        case "string":
          if (byte === 0x07) this.mode = "text";
          else if (byte === 0x1b) this.mode = "string-esc";
          break;
        case "string-esc":
          this.mode = byte === 0x5c || byte === 0x07 ? "text" : byte === 0x1b ? "string-esc" : "string";
          break;
      }
    }
    return typed;
  }
}
