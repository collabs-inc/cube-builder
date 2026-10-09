// packages/shared/src/backend-pool.ts
// One RemoteBackend per repo — except that on the local machine every
// repo's daemon endpoint is the same URL, so the pool dedupes the
// physical socket by endpoint URL while still tracking (and reporting)
// status per repo. Tags every event/status/frame with the repoId so
// a single hook triple can fan out to many repos. The IPC router that
// consumes this pool lands in a later task.
import { AppPlaneError, type AppPlaneFailure } from "./app-plane-outcome";
import { CUBED_INTERFACE_VERSION } from "./cubed-protocol";
import { withToken, type RemoteBackend, type RemoteStatus } from "./remote-backend";

export const UNAUTHORIZED_MESSAGE = "This share link no longer works — ask the owner for a new one";

export type PoolStatus = "connecting" | "open" | "closed" | "error";

export interface BackendEndpoint {
  url: string;
  token: string;
  /**
   * The endpoint's pinned IPv4, when known — a cloud machine's dedicated IP
   * (see CloudMachine.endpointIp). Forwarded to makeBackend so the caller
   * can dial it directly instead of resolving url's hostname, ahead of
   * Fly's lazy fly.dev DNS publication. Absent for local connections and
   * older rows, in which case behavior is unchanged.
   */
  endpointIp?: string;
  /** Account-generation identity; cloud sockets are scheduled by their recovery owner. */
  connectionIdentity?: string;
}

export interface PoolHooks {
  makeBackend: (url: string, endpointIp?: string) => RemoteBackend;
  onEvent: (repoId: string, channel: string, payload: unknown) => void;
  onStatus: (repoId: string, status: PoolStatus, error?: string) => void;
  onTransportStatus?: (repoId: string, status: RemoteStatus) => void;
  onFrame: (repoId: string, bytes: Uint8Array) => void;
}

interface Entry {
  backend: RemoteBackend | null;
  status: PoolStatus;
  // `| undefined` (not just optional) so mapStatus()'s result can be
  // assigned straight through under exactOptionalPropertyTypes.
  error?: string | undefined;
  /** Set only for entries backed by a live (possibly shared) socket. */
  endpointKey?: string;
  /**
   * Removes this entry's three callbacks from its (possibly shared)
   * backend. A shared backend outlives any one repo's entry, so without
   * this every detach+rejoin cycle would leave a dead closure permanently
   * registered on the surviving backend — the identity guard silences it,
   * but never shrinks the backend's callback sets.
   */
  unsubscribe?: () => void;
}

interface SharedSocket {
  backend: RemoteBackend;
  repoIds: Set<string>;
  generation: number;
  revision: number;
  validated: boolean;
  managed: boolean;
  failure: AppPlaneFailure | null;
  probe?: Promise<"authenticated" | "unauthorized" | "unavailable">;
}

interface OpenWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function mapStatus(s: RemoteStatus, backend: RemoteBackend): { status: PoolStatus; error?: string } {
  if (s === "unauthorized") return { status: "error", error: UNAUTHORIZED_MESSAGE };
  if (s === "blocked") {
    const outcome = backend.lastAttach()?.outcome;
    const error = outcome?.kind === "machine-ahead" ? "Update Cube to use this machine"
      : outcome?.kind === "restart-needed" ? `Restart needed: ${outcome.reason}`
      : outcome?.kind === "blocked" ? `Blocked: ${outcome.reason}`
      : "Blocked: daemon-unavailable";
    return { status: "error", error };
  }
  return { status: s };
}

/** Retain the existing full-machine-update affordance while publishing typed recovery evidence. */
export function connectionFailureMessage(failure: AppPlaneFailure): string {
  return failure.code === 'machine_update_required' ? 'This machine needs a full update' : failure.code;
}

export class BackendPool {
  private entries = new Map<string, Entry>();
  private sharedSockets = new Map<string, SharedSocket>();
  private nextGeneration = 0;
  private openWaiters = new Map<string, Set<OpenWaiter>>();

  constructor(private hooks: PoolHooks) {}

  connect(repoId: string, endpoint: BackendEndpoint): void {
    const oldEntry = this.entries.get(repoId);
    if (oldEntry) this.detach(repoId, oldEntry);

    const key = JSON.stringify([endpoint.url, endpoint.token, endpoint.connectionIdentity ?? ""]);
    const existing = this.sharedSockets.get(key);

    if (existing) {
      existing.repoIds.add(repoId);
      // The shared backend is already running (or done connecting) — no new
      // transition will fire to tell hooks about its current state, so seed
      // and report it explicitly.
      const seeded = existing.managed && existing.backend.getStatus() !== "blocked" ? { status: existing.failure ? "error" as const : existing.validated ? "open" as const : "connecting" as const, error: existing.failure ? connectionFailureMessage(existing.failure) : undefined } : mapStatus(existing.backend.getStatus(), existing.backend);
      const entry: Entry = {
        backend: existing.backend,
        status: seeded.status,
        error: seeded.error,
        endpointKey: key,
      };
      entry.unsubscribe = this.subscribe(repoId, entry, existing.backend);
      this.entries.set(repoId, entry);
      this.reportStatus(repoId, entry.status, entry.error);
      return;
    }

    const backend = this.hooks.makeBackend(withToken(endpoint.url, endpoint.token), endpoint.endpointIp);
    const shared: SharedSocket = { backend, repoIds: new Set([repoId]), generation: ++this.nextGeneration, revision: 0, validated: false, managed: endpoint.connectionIdentity !== undefined, failure: null };
    if (shared.managed) backend.setRecoveryOwner?.(true);
    this.sharedSockets.set(key, shared);

    const entry: Entry = { backend, status: "connecting", endpointKey: key };
    // Subscribe before connect() so this repo's guarded listener catches
    // the synchronous 'connecting' transition connect() triggers.
    entry.unsubscribe = this.subscribe(repoId, entry, backend);
    this.entries.set(repoId, entry);
    backend.connect();
  }

  /** Replace a cloud group without closing logical entries or rejecting their waiters. */
  replaceConnection(repoIds: string[], endpoint: BackendEndpoint): void {
    const key = JSON.stringify([endpoint.url, endpoint.token, endpoint.connectionIdentity ?? ""]);
    const backend = this.hooks.makeBackend(withToken(endpoint.url, endpoint.token), endpoint.endpointIp);
    backend.setRecoveryOwner?.(endpoint.connectionIdentity !== undefined);
    // Detach listeners before closing the final reference. No callback can see mixed credentials.
    for (const id of repoIds) { const old = this.entries.get(id); if (old) this.detach(id, old); }
    const shared: SharedSocket = { backend, repoIds: new Set(repoIds), generation: ++this.nextGeneration, revision: 0, validated: false, managed: endpoint.connectionIdentity !== undefined, failure: null };
    this.sharedSockets.set(key, shared);
    for (const id of repoIds) {
      const entry: Entry = { backend, status: 'connecting', endpointKey: key };
      entry.unsubscribe = this.subscribe(id, entry, backend);
      this.entries.set(id, entry);
    }
    backend.connect();
  }

  // Guards every forwarded callback by identity: once this repo's entry
  // is replaced or forgotten, a stale backend's late-firing events must not
  // reach the hooks — relying solely on the RemoteBackend's own unsubscribe
  // isn't enough (see backend-pool.test.ts). Returns a combined unsubscribe
  // for the caller to store on the entry and invoke on detach — required
  // (not just belt-and-suspenders) on a shared backend, which outlives any
  // one repo's entry and would otherwise accumulate dead closures across
  // detach+rejoin cycles.
  private subscribe(repoId: string, entry: Entry, backend: RemoteBackend): () => void {
    const offEvent = backend.onEvent((channel, payload) => {
      if (this.entries.get(repoId) !== entry) return;
      this.hooks.onEvent(repoId, channel, payload);
    });
    const offFrame = backend.onFrame((bytes) => {
      if (this.entries.get(repoId) !== entry) return;
      this.hooks.onFrame(repoId, bytes);
    });
    const offStatus = backend.onStatus((s) => {
      if (this.entries.get(repoId) !== entry) return;
      const shared = entry.endpointKey ? this.sharedSockets.get(entry.endpointKey) : undefined;
      if (shared?.managed) {
        const first = shared.repoIds.values().next().value === repoId;
        if (first && s !== "open") { shared.validated = false; shared.generation = ++this.nextGeneration; }
        const permanent = shared.failure && !shared.failure.retryable;
        const blocked = s === "blocked" ? mapStatus(s, backend) : null;
        entry.status = permanent ? "error" : blocked?.status ?? (s === "closed" ? "closed" : "connecting");
        entry.error = permanent ? connectionFailureMessage(shared.failure!) : blocked?.error;
        this.reportStatus(repoId, entry.status, entry.error);
        if (first) this.hooks.onTransportStatus?.(repoId, s);
        return;
      }
      const mapped = mapStatus(s, backend);
      entry.status = mapped.status;
      entry.error = mapped.error;
      this.reportStatus(repoId, mapped.status, mapped.error);
    });
    return () => {
      offEvent();
      offFrame();
      offStatus();
    };
  }

  private sharedFor(id: string): SharedSocket | undefined {
    const key = this.entries.get(id)?.endpointKey;
    return key === undefined ? undefined : this.sharedSockets.get(key);
  }

  connectionGeneration(id: string): number | null { return this.sharedFor(id)?.generation ?? null; }
  validationRevision(id: string): number { return this.sharedFor(id)?.revision ?? 0; }

  setConnectionError(id: string, generation: number, error: AppPlaneFailure, revision = 0): void {
    const shared = this.sharedFor(id);
    if (!shared || shared.generation !== generation) return;
    if (error.retryable && (shared.revision > revision || shared.failure && !shared.failure.retryable)) return;
    shared.failure = error;
    for (const alias of shared.repoIds) this.setError(alias, connectionFailureMessage(error));
  }

  clearConnectionError(id: string): void {
    const shared = this.sharedFor(id);
    if (shared) shared.failure = null;
  }

  /** Readiness requires a compatible response on this exact authenticated connection. */
  probeConnection(id: string, signal: AbortSignal): Promise<"authenticated" | "unauthorized" | "unavailable"> {
    const shared = this.sharedFor(id);
    if (!shared) return Promise.resolve("unavailable");
    if (shared.probe) return shared.probe;
    const backend = shared.backend;
    if (backend.getStatus() === "unauthorized") return Promise.resolve("unauthorized");
    if (backend.getStatus() === "blocked") return Promise.reject(new AppPlaneError({ category: "incompatible", code: "update_required", retryable: false, certainty: "rejected" }));
    const work = async (): Promise<"authenticated" | "unauthorized" | "unavailable"> => {
      let generation = shared.generation;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(() => controller.abort(), (backend.admissionBudgetMs?.() ?? 0) + 5_000);
      try {
        if (signal.aborted) return "unavailable";
        if (backend.getStatus() !== "open") {
          // A close nudge first lets ensure own lifecycle work. The attempt's final probe redials.
          await new Promise<void>((resolve, reject) => {
            let off = () => {};
            const done = (error?: Error) => { off(); controller.signal.removeEventListener("abort", canceled); error ? reject(error) : resolve(); };
            const canceled = () => done(new Error("probe canceled"));
            off = backend.onStatus(status => { if (status === "open") done(); else if (status === "blocked") done(new AppPlaneError({ category: "incompatible", code: "update_required", retryable: false, certainty: "rejected" })); else if (status === "unauthorized" || status === "closed") done(new Error("probe unavailable")); });
            controller.signal.addEventListener("abort", canceled, { once: true });
            if (backend.getStatus() === "open") done();
            else { backend.connect(); generation = shared.generation; }
          });
        }
        const reply = await backend.request<{ cubedInterface?: unknown }>("daemon:ping", {}, 5_000, controller.signal);
        if (controller.signal.aborted || this.sharedFor(id) !== shared || shared.generation !== generation || backend.getStatus() !== "open") return "unavailable";
        if (backend.lastAttach?.()?.outcome.kind !== "level" && reply?.cubedInterface !== CUBED_INTERFACE_VERSION) throw new AppPlaneError({ category: "incompatible", code: "update_required", retryable: false, certainty: "rejected" });
        shared.validated = true;
        shared.revision++;
        if (!shared.failure || shared.failure.retryable) shared.failure = null;
        for (const alias of shared.repoIds) {
          const entry = this.entries.get(alias)!;
          const previousStatus = entry.status, previousError = entry.error;
          entry.status = shared.failure ? "error" : "open";
          entry.error = shared.failure ? connectionFailureMessage(shared.failure) : undefined;
          if (entry.status !== previousStatus || entry.error !== previousError) this.reportStatus(alias, entry.status, entry.error);
        }
        return this.sharedFor(id) === shared && shared.generation === generation && backend.getStatus() === "open" ? "authenticated" : "unavailable";
      } catch (error) {
        if (error instanceof AppPlaneError) throw error;
        if (controller.signal.aborted && this.sharedFor(id) === shared && shared.generation === generation && (backend.getStatus() === "open" || backend.getStatus() === "connecting")) backend.close();
        return backend.getStatus() === "unauthorized" ? "unauthorized" : "unavailable";
      } finally { clearTimeout(deadline); signal.removeEventListener("abort", abort); }
    };
    shared.probe = Promise.resolve().then(work).finally(() => { delete shared.probe; });
    return shared.probe;
  }

  // Detaches a repo from its (possibly shared) socket. Closes the
  // physical backend only once no repo references it anymore. Removes
  // the stale entry from `entries` before closing so a synchronously
  // firing close callback (as a fake socket in tests might produce) can't
  // slip past the identity guard above.
  private detach(repoId: string, entry: Entry): void {
    entry.unsubscribe?.();
    if (this.entries.get(repoId) === entry) this.entries.delete(repoId);
    const key = entry.endpointKey;
    if (key === undefined) return;
    const shared = this.sharedSockets.get(key);
    if (!shared) return;
    shared.repoIds.delete(repoId);
    if (shared.repoIds.size === 0) {
      this.sharedSockets.delete(key);
      shared.backend.close();
    }
  }

  /**
   * Asks every live socket to prove its peer is still there. Driven by the
   * OS resume event: a laptop that slept through cubed's client timeout
   * wakes holding sockets that look open and are not (issue #11), and the
   * probe is what turns that into a close the wake path can act on.
   * Iterates sharedSockets, not entries, so an endpoint shared by several
   * repos is probed once.
   */
  checkLiveness(): void {
    for (const shared of this.sharedSockets.values()) shared.backend.checkLiveness();
  }

  retryAttach(repoId: string): void {
    this.get(repoId).retryAttach();
  }

  get(repoId: string): RemoteBackend {
    const backend = this.entries.get(repoId)?.backend;
    if (!backend) throw new Error(`repo ${repoId} is not connected`);
    return backend;
  }

  peek(repoId: string): RemoteBackend | null {
    return this.entries.get(repoId)?.backend ?? null;
  }

  statuses(): Record<string, { status: PoolStatus; error?: string }> {
    const out: Record<string, { status: PoolStatus; error?: string }> = {};
    for (const [id, entry] of this.entries) {
      out[id] =
        entry.error === undefined ? { status: entry.status } : { status: entry.status, error: entry.error };
    }
    return out;
  }

  // Wait across backend replacement: lifecycle wake deliberately swaps the
  // old reconnecting socket for a freshly ensured endpoint. Callers waiting
  // on the repo, rather than one RemoteBackend instance, survive that swap.
  waitForOpen(repoId: string, timeoutMs = 45_000): Promise<void> {
    const entry = this.entries.get(repoId);
    if (entry?.status === "open") return Promise.resolve();
    if (entry?.status === "error") {
      return Promise.reject(new Error(entry.error ?? `repo ${repoId} failed to connect`));
    }
    return new Promise((resolve, reject) => {
      const waiter: OpenWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.openWaiters.get(repoId);
          current?.delete(waiter);
          if (current?.size === 0) this.openWaiters.delete(repoId);
          reject(new Error(`repo ${repoId} did not reconnect`));
        }, timeoutMs),
      };
      let waiters = this.openWaiters.get(repoId);
      if (!waiters) {
        waiters = new Set();
        this.openWaiters.set(repoId, waiters);
      }
      waiters.add(waiter);
    });
  }

  setError(repoId: string, message: string): void {
    const entry = this.entries.get(repoId);
    if (entry) {
      entry.status = "error";
      entry.error = message;
    } else {
      this.entries.set(repoId, { backend: null, status: "error", error: message });
    }
    this.reportStatus(repoId, "error", message);
  }

  /**
   * Withdraws a refusal recorded by `setError` or `setConnectionError` once
   * recovery has connected past it, so `waitForOpen` waits again instead of
   * rejecting with the stale message. A live, validated socket reads open.
   */
  clearError(repoId: string): void {
    const shared = this.sharedFor(repoId);
    if (shared) shared.failure = null;
    const entry = this.entries.get(repoId);
    if (entry?.status !== "error") return;
    const live = entry.backend?.getStatus() === "open" && (!shared?.managed || shared.validated);
    entry.status = live ? "open" : "connecting";
    entry.error = undefined;
    this.reportStatus(repoId, entry.status);
  }

  // Reports a repo as waking up (e.g. before a backend exists to
  // connect). A closed backend may remain in place so its socket retry
  // timer stays live while the lifecycle wake runs; open or already-
  // connecting backends are left alone.
  setConnecting(repoId: string): void {
    const entry = this.entries.get(repoId);
    if (entry?.backend) {
      if (entry.status !== "closed" && entry.status !== "error") return;
      entry.status = "connecting";
      entry.error = undefined;
    } else {
      this.entries.set(repoId, { backend: null, status: "connecting" });
    }
    this.reportStatus(repoId, "connecting");
  }

  close(repoId: string): void {
    const entry = this.entries.get(repoId);
    if (entry) this.detach(repoId, entry);
    this.entries.delete(repoId);
    this.rejectOpenWaiters(repoId, new Error(`repo ${repoId} was closed`));
    this.reportStatus(repoId, "closed");
  }

  private reportStatus(repoId: string, status: PoolStatus, error?: string): void {
    if (error === undefined) this.hooks.onStatus(repoId, status);
    else this.hooks.onStatus(repoId, status, error);
    if (status === "open") this.resolveOpenWaiters(repoId);
    else if (status === "error") {
      this.rejectOpenWaiters(repoId, new Error(error ?? `repo ${repoId} failed to connect`));
    }
  }

  private resolveOpenWaiters(repoId: string): void {
    const waiters = this.openWaiters.get(repoId);
    if (!waiters) return;
    this.openWaiters.delete(repoId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectOpenWaiters(repoId: string, error: Error): void {
    const waiters = this.openWaiters.get(repoId);
    if (!waiters) return;
    this.openWaiters.delete(repoId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
