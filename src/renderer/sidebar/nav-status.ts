// Whether the file tree can be shown yet, or whether the machine behind it is
// still coming up. Only cloud repos can be "not there yet": a local
// repo's files are on this disk whatever the daemon is doing.
//
// A cloud repo with no status, or a closed one, reads as CONNECTING
// rather than broken: routing a request at it is what brings the socket up
// (the router's ensureCloudConnected), and browsing is exactly such a
// request. Only an explicit error status is an error.
export type NavStatus =
  | { kind: "ready" }
  | { kind: "connecting" }
  | { kind: "error"; message: string };

export interface NavStatusInput {
  kind: "local" | "cloud";
  status: string | undefined;
  error: string | undefined;
}

export function resolveNavStatus(input: NavStatusInput | null): NavStatus {
  if (!input || input.kind === "local") return { kind: "ready" };
  if (input.status === "open") return { kind: "ready" };
  if (input.status === "error") {
    return { kind: "error", message: input.error ?? "Could not reach this machine." };
  }
  return { kind: "connecting" };
}
