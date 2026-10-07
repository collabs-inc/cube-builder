export type DataListener = (payload: { sessionId: string; data: Uint8Array; replay?: boolean }) => void;
/** Browser operations and this application's terminal service; no embedding-host API. */
export interface TerminalHost {
  getPlatform(): string;
  openExternal(url: string): void;
  ptyWrite(id: string, text: string): void;
  ptyResize(id: string, cols: number, rows: number): void;
  writeClipboardText(text: string): Promise<void>;
  onPtyData(id: string, callback: DataListener): void;
  offPtyData(id: string, callback: DataListener): void;
  ptyStashFile(id: string, bytes: string, mime: string, name?: string): Promise<{ path: string }>;
  isDirectory(path: string): Promise<boolean>;
  onShellBlur(callback: () => void): () => void;
}
