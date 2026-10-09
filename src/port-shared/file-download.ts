/** Host-owned download progress. Download URLs and credentials never cross IPC. */
export interface FileDownloadState {
  id: string;
  name: string;
  phase: "preparing" | "downloading" | "completed" | "error";
  bytesReceived: number;
  totalBytes?: number;
  bytesPerSecond: number;
  error?: string;
}
