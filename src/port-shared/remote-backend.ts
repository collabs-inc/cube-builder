// packages/shared/src/remote-backend.ts
// WebSocket client for cubed: correlates requests/responses, forwards
// server-pushed events and binary term frames, and reconnects with backoff.
// Isomorphic — no Node imports — so the Electron main process (inject a
// `ws`-backed factory; see src/main/node-socket.ts) and any other host can
// share it.
//
// Two options exist only for a browser host, and the desktop passes
// neither: `resolveUrl` re-resolves the dial URL before every connection
// attempt (initial and reconnect alike), because a browser dials with a
// short-lived minted token baked into the URL's `?token=` — unlike the
// desktop's long-lived token, that token expires well inside a normal
// reconnect loop, so redialling the same URL after expiry would just
// 4401. `watchVisibility` redials on `visibilitychange` because
// backgrounded tabs get throttled or have their sockets dropped outright
// by the browser, so coming back to a `closed` status needs a nudge that
// isn't going to arrive from backoff alone.
import { attach, attachBudgetMs, AttachError, type AttachDeps, type AttachResult } from "./cubed-attach";
import type { CubedManifest } from "./cubed-manifest-schema";
import type { DaemonLogger } from "./daemon-log";
import { parseWireMessage } from "./wire";

export type RemoteStatus = "connecting" | "open" | "closed" | "unauthorized" | "blocked";

// The subset of the WHATWG WebSocket surface RemoteBackend needs. Both the
// browser's WebSocket and the `ws` package's client satisfy it structurally.
export interface WireSocket {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(): void;
}

export type SocketFactory = (url: string) => WireSocket;

export interface AttachOptions {
  client: CubedManifest;
  machine: string;
  bytes: AttachDeps["bytes"];
  demoted: Set<string>;
  log: DaemonLogger;
  /** Every settlement, including cancellation. Capture all; publish recovery only when not cancelled. */
  onResult?: (result: AttachResult, context: { cancelled: boolean }) => void;
  budgets?: AttachDeps["budgets"];
}

export interface RemoteBackendOptions {
  attach?: AttachOptions;
  makeSocket?: SocketFactory;
  /** Initial reconnect backoff in ms. Default 500; injectable for tests. */
  backoffStartMs?: number;
  /** Reconnect backoff ceiling in ms. Default 3000; injectable for tests. */
  backoffMaxMs?: number;
  /**
   * Resolves the URL to dial, called fresh before every connection attempt
   * (initial and each reconnect). Absent means "dial the constructor URL",
   * today's behaviour — this is how the desktop stays byte-identical.
   *
   * Must settle. A promise that never settles wedges the backend at
   * `connecting` with no retry and no status change — callers doing
   * network work (e.g. minting a token) must apply their own timeout so a
   * hang surfaces as a rejection, which this class handles (closed +
   * backoff).
   */
  resolveUrl?: () => Promise<string>;
  /**
   * When true (and `document` exists — this is a no-op outside a browser),
   * redials on `visibilitychange` if the tab becomes visible while status
   * is `closed`. Default false.
   */
  watchVisibility?: boolean;
  /** How long the peer may be silent before it is probed. Default 15000. */
  heartbeatMs?: number;
  /** How long a probe may go unanswered before the socket is dropped. Default 10000. */
  heartbeatTimeoutMs?: number;
}

/**
 * The request the heartbeat probes with. cubed's cheapest verb, and one
 * every daemon old enough to be reachable implements — but the reply's
 * content is irrelevant without admission enabled: an error reply is still
 * a live peer. With admission, an explicit refusal also forces a reconnect.
 */
export const HEARTBEAT_CHANNEL = "daemon:ping";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Admission {
  socket: WireSocket | null;
  controller: AbortController;
  redial?: { resolve: (socket: WireSocket) => void; reject: (error: Error) => void };
}

const CONNECTING = 0;
const OPEN = 1;
// cubed's close code for a rejected token (src/main/cubed/server.ts).
// Retrying cannot fix a bad token, so this close is terminal.
const CLOSE_UNAUTHORIZED = 4401;
const BACKOFF_START_MS = 500;
// Sized against how long a machine is actually gone, which the ptyd split
// changed: ptyd is the machine's main process, so its exit restarts the
// machine, and Fly has it started in ~1.4s and passing healthz within ~6s
// (measured on a real roll). An 8s ceiling put the fourth attempt at 7.5s
// and the fifth at 15.5s, so a six-second outage routinely cost fifteen
// seconds of app-visible downtime — the wait was the backoff, not the
// machine. A 3s ceiling lands attempts at 0.5/1.5/3.5/6.5/9.5s, catching
// that same outage on the fourth try.
const BACKOFF_MAX_MS = 3000;
const REQUEST_TIMEOUT_MS = 15_000;
// Sized under cubed's own client heartbeat (20s, terminating at ~60s of
// missed pongs — src/main/cubed/server.ts), so the two ends notice a dead
// link on the same order of time rather than one waiting out the other.
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

// The one auth form every WebSocket client can send: browsers cannot set
// headers on the WS handshake, but cubed accepts ?token= (server.ts).
export function withToken(url: string, token: string): string {
  const u = new URL(url);
  u.searchParams.set("token", token);
  return u.toString();
}

// The URL now carries the repo token — never log it raw.
export function redact(url: string): string {
  return url.replace(/([?&]token=)[^&\s'"]+/g, "$1…");
}

const defaultFactory: SocketFactory = (url) => {
  const WS = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!WS) {
    throw new Error("no global WebSocket — pass makeSocket (Node needs the ws package)");
  }
  return new WS(url) as WireSocket;
};

// Binary WS payloads arrive as a Node Buffer (a Uint8Array subclass, the
// `ws` default binaryType) or an ArrayBuffer (binaryType "arraybuffer",
// which node-socket.ts sets). Anything else isn't a frame we understand.
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

export class RemoteBackend {
  private ws: WireSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private eventCbs = new Set<(channel: string, payload: unknown) => void>();
  private frameCbs = new Set<(bytes: Uint8Array) => void>();
  private statusCbs = new Set<(s: RemoteStatus) => void>();
  private status: RemoteStatus = "closed";
  private readonly backoffStart: number;
  private readonly backoffMax: number;
  private backoff: number;
  private stopped = true;
  private recoveryOwned = false;
  private dialRevision = 0;

  setRecoveryOwner(owned: boolean): void {
    this.recoveryOwned = owned;
    if (owned && this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
  private timer: ReturnType<typeof setTimeout> | null = null;
  private makeSocket: SocketFactory;
  private readonly resolveUrl: (() => Promise<string>) | undefined;
  private readonly onVisibilityChange: (() => void) | null = null;
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Wall-clock stamp of the last inbound message — see `tickHeartbeat`. */
  private lastInboundAt = 0;
  private inboundRevision = 0;
  private probeInFlight = false;
  private readonly attachOptions: AttachOptions | undefined;
  private admitted = false;
  private admittedOnce = false;
  private admitting: Admission | null = null;
  private attachResult: AttachResult | null = null;
  private blocked = false;
  private dialAttempt: object | null = null;

  constructor(
    private url: string,
    opts: RemoteBackendOptions = {},
  ) {
    this.attachOptions = opts.attach;
    this.makeSocket = opts.makeSocket ?? defaultFactory;
    this.backoffStart = opts.backoffStartMs ?? BACKOFF_START_MS;
    this.backoffMax = opts.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.backoff = this.backoffStart;
    this.resolveUrl = opts.resolveUrl;
    if (opts.watchVisibility && typeof document !== "undefined") {
      this.onVisibilityChange = () => {
        if (!this.recoveryOwned && document.visibilityState === "visible" && this.status === "closed") {
          this.open();
        }
      };
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }

  // Starts (or resumes) connecting; safe to call while already connecting/open.
  connect(): void {
    this.stopped = false;
    this.open();
  }

  // Dials a fresh connection attempt. Never throws — a rejecting
  // `resolveUrl` is caught and treated exactly like a socket close, so
  // callers (connect(), the reconnect timer, the visibility listener) can
  // call this unconditionally.
  private open(): void {
    // Admission stays "connecting" across physical reconnects. Track its
    // URL resolution separately so repeated connect() calls cannot race a
    // pending dial; hosts without admission retain their status guard.
    if (this.blocked) return;
    if (this.attachOptions ? this.dialAttempt !== null : this.status === "connecting") return;
    if (this.ws && (this.ws.readyState === CONNECTING || this.ws.readyState === OPEN)) {
      return;
    }
    // A visibility redial (or any other open() call) can land while a
    // backoff timer is still pending from a prior close — left alone, that
    // stale timer would later fire its own open() call, which is at best
    // redundant and at worst emits a spurious status transition after
    // close() has already stopped this client.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setStatus("connecting");
    if (this.attachOptions && !this.admitting && !this.admittedOnce) this.startAdmission(null);
    // openAsync's own try/catch handles a rejecting resolveUrl(); this
    // .catch is for everything else that can still reject the promise a
    // async function always returns — notably a synchronous throw from
    // makeSocket() (e.g. `new WebSocket(malformedUrl)`). Without it, that
    // becomes an unhandled rejection and leaves status stuck at
    // "connecting" forever; with it, it's recovered exactly like a close.
    const revision = ++this.dialRevision;
    const attempt = (this.dialAttempt = {});
    void this.openAsync(attempt, revision).catch((err) => {
      if (revision !== this.dialRevision || this.stopped || (this.attachOptions && this.dialAttempt !== attempt)) return;
      console.error(
        `remote backend ${redact(this.url)}: dial failed (${String(
          (err as Error | undefined)?.message ?? err,
        )})`,
      );
      if (!this.admitting) this.setStatus("closed");
      this.scheduleReconnect();
    }).finally(() => { if (this.dialAttempt === attempt) this.dialAttempt = null; });
  }

  private async openAsync(attempt: object, revision: number): Promise<void> {
    let dialUrl = this.url;
    if (this.resolveUrl) {
      try {
        dialUrl = await this.resolveUrl();
      } catch (err) {
        if (revision !== this.dialRevision || this.stopped) return;
        console.error(
          `remote backend ${redact(this.url)}: resolveUrl failed (${String(
            (err as Error | undefined)?.message ?? err,
          )})`,
        );
        if (!this.admitting) this.setStatus("closed");
        this.scheduleReconnect();
        return;
      }
    }
    if (this.attachOptions && this.dialAttempt !== attempt) return;
    // A close() or a newer open() may have landed while we were awaiting
    // resolveUrl(); don't clobber whatever state that left us in.
    //
    // Except for one state, which IS this dial's to clean up: the "connecting"
    // that open() set two lines before the await. Left standing, it wedges the
    // client — `connect()`'s open() returns early on `status === "connecting"`,
    // so a backend closed mid-resolve could never be reconnected and its
    // status would report a dial that is not happening. A close() that lands
    // during the await ends at "closed", the same place a close() one tick
    // earlier or later ends. `unauthorized` (a 4401 on the outgoing socket,
    // which also sets `stopped`) is terminal and deliberately not overwritten.
    if (revision !== this.dialRevision) return;
    if (this.stopped) {
      if (this.status === "connecting") this.setStatus("closed");
      return;
    }
    if (this.ws && (this.ws.readyState === CONNECTING || this.ws.readyState === OPEN)) {
      return;
    }
    const ws = (this.ws = this.makeSocket(dialUrl));
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoff = this.backoffStart;
      if (this.attachOptions) {
        if (this.admitting) this.admitting.redial?.resolve(ws);
        else this.startAdmission(ws);
      } else {
        this.startHeartbeat();
        this.setStatus("open");
      }
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastInboundAt = Date.now();
      this.inboundRevision++;
      if (typeof ev.data === "string") {
        this.onTextMessage(ev.data);
        return;
      }
      const bytes = toBytes(ev.data);
      if (bytes) this.onFrameMessage(bytes);
    };
    // 'close' always follows an error, but logging here is the only signal —
    // without it connection failures become an undiagnosable reconnect loop.
    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      const detail = String((ev as { message?: string } | undefined)?.message ?? "");
      console.error(
        `remote backend ${redact(this.url)}: socket error${detail ? ` (${redact(detail)})` : ""}`,
      );
    };
    ws.onclose = (ev) => this.handleClose(ws, ev.code);
  }

  private startAdmission(ws: WireSocket | null): void {
    const options = this.attachOptions!;
    const admission: Admission = { socket: ws, controller: new AbortController() };
    this.admitting = admission;
    const askFor = (socket: WireSocket | null): AttachDeps["ask"] => (channel, args, timeoutMs) => {
      if (this.admitting !== admission || this.ws !== socket) {
        return Promise.reject(new Error("connection lost"));
      }
      return this.rawRequest(channel, args, timeoutMs);
    };
    const redial: AttachDeps["redial"] = async (budgetMs) => {
      if (this.admitting !== admission || this.stopped) throw new Error("connection lost");
      // The replacement can open before attach consumes the install reply.
      const current = this.ws;
      const socket = current && current !== admission.socket && current.readyState === OPEN
        ? current
        : await new Promise<WireSocket>((resolve, reject) => {
          const timer = setTimeout(() => {
            delete admission.redial;
            reject(new Error("attach redial timed out"));
          }, budgetMs);
          admission.redial = {
            resolve: socket => { clearTimeout(timer); delete admission.redial; resolve(socket); },
            reject: error => { clearTimeout(timer); delete admission.redial; reject(error); },
          };
        });
      admission.socket = socket;
      return askFor(socket);
    };
    void attach({
      client: options.client,
      machine: options.machine,
      bytes: options.bytes,
      demoted: options.demoted,
      log: options.log,
      ...(options.budgets ? { budgets: options.budgets } : {}),
      signal: admission.controller.signal,
      ...(!ws ? { connect: redial } : {}),
      ask: askFor(ws),
      redial,
    }).catch(error => {
      // Opening exhaustion rejects, but its logged result is terminal just
      // like a resolved version outcome. Preserve it for status and analytics.
      if (error instanceof AttachError) return error.result;
      throw error;
    }).then(result => {
      const cancelled = this.admitting !== admission;
      if (cancelled) { options.onResult?.(result, { cancelled: true }); return; }
      this.admitting = null;
      this.attachResult = result;
      if (result.outcome.kind === "level") {
        // A close can race the final ping's promise continuation. Admission
        // belongs only to that physical socket, never its replacement.
        if (this.ws && this.ws === admission.socket && this.ws.readyState === OPEN) {
          this.admitted = true;
          this.admittedOnce = true;
          this.startHeartbeat();
          this.setStatus("open");
        } else if (this.ws?.readyState === OPEN) {
          this.startAdmission(this.ws);
        }
      } else {
        this.blocked = true;
        this.dialAttempt = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const socket = this.ws;
        if (socket) {
          this.handleClose(socket, 1000);
          socket.close();
        }
        this.setStatus("blocked");
      }
      options.onResult?.(result, { cancelled: false });
    }, () => {
      if (this.admitting !== admission) return;
      this.admitting = null;
      // Unexpected failures without a transaction result retain the normal
      // reconnect path. Cancellation is excluded by the identity guard above.
      const socket = this.ws;
      if (socket) {
        this.handleClose(socket, 1006);
        socket.close();
      } else {
        this.setStatus("closed");
      }
    });
  }

  private cancelAdmission(): void {
    const admission = this.admitting;
    this.admitting = null;
    admission?.controller.abort();
    admission?.redial?.reject(new Error("connection lost"));
    this.admitted = false;
  }

  lastAttach(): AttachResult | null {
    return this.attachResult;
  }

  /** Recovery probes must allow admission to finish installing and respawning. */
  admissionBudgetMs(): number | null {
    return this.attachOptions ? attachBudgetMs(this.attachOptions.budgets) : null;
  }

  retryAttach(): void {
    if (!this.blocked) return;
    this.blocked = false;
    this.admittedOnce = false;
    this.stopped = false;
    this.open();
  }

  // Shared by a real close event and by the heartbeat dropping a silent
  // peer. The identity guard makes it idempotent: whichever gets here first
  // owns the teardown, and the other returns immediately.
  private handleClose(ws: WireSocket, code: number): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.admitted = false;
    this.stopHeartbeat();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("connection lost"));
    }
    this.pending.clear();
    if (code === CLOSE_UNAUTHORIZED) {
      this.stopped = true;
      this.cancelAdmission();
      this.setStatus("unauthorized");
      return;
    }
    if (this.blocked) return;
    if (!this.admitting) this.setStatus("closed");
    this.scheduleReconnect();
  }

  /**
   * Why the client needs its own liveness check at all (issue #11): cubed
   * pings *its* clients and terminates one that misses two pongs, but a
   * `terminate()` aimed at a sleeping laptop is a TCP reset nobody receives.
   * The Mac wakes with a socket still in readyState OPEN whose peer is long
   * gone, and since macOS does not tear down established sockets when an
   * interface drops, no close event is ever coming — writes (pty input) sink
   * silently and the whole reconnect path below never runs, because every
   * bit of it hangs off `closed`. A client that speaks first is the only way
   * to find out.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastInboundAt = Date.now();
    this.heartbeatTimer = setInterval(() => this.tickHeartbeat(), this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.probeInFlight = false;
  }

  // Deliberately wall-clock (Date.now), not a monotonic source: sleep is the
  // case this exists for, and only wall clock advances across it. The first
  // tick after a wake therefore sees the whole sleep as idle time and probes
  // at once, instead of starting the window over.
  private tickHeartbeat(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    if (Date.now() - this.lastInboundAt < this.heartbeatMs) return;
    this.probe(ws);
  }

  /**
   * Forces an immediate probe, skipping the idle window. Wired to the OS
   * resume event (src/main/index.ts) so a wake is diagnosed in about one
   * probe timeout rather than one heartbeat plus one. Safe to call at any
   * time; a no-op unless there is an open socket with no probe outstanding.
   */
  checkLiveness(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    this.probe(ws);
  }

  private probe(ws: WireSocket): void {
    if (this.probeInFlight || (this.attachOptions && !this.admitted)) return;
    this.probeInFlight = true;
    // Anything arriving after this stamp — the probe's own reply, an error
    // reply from a daemon too old to know the verb, or unrelated traffic —
    // proves the peer is there. An explicit admission refusal also means
    // this socket must negotiate again, even though the peer is alive.
    const sentRevision = this.inboundRevision;
    const args = this.attachOptions ? { expect: this.attachOptions.client.bundleId } : {};
    this.request<{ admitted?: boolean } | null>(HEARTBEAT_CHANNEL, args, this.heartbeatTimeoutMs).then(
      reply => {
        if (this.ws !== ws) return;
        this.probeInFlight = false;
        if (this.attachOptions && reply?.admitted === false) {
          this.handleClose(ws, 4409);
          ws.close();
        }
      },
      () => {
        if (this.ws !== ws) return;
        this.probeInFlight = false;
        if (this.ws !== ws || ws.readyState !== OPEN) return;
        if (this.inboundRevision !== sentRevision) return;
        console.error(
          `remote backend ${redact(this.url)}: peer silent through a liveness probe — reconnecting`,
        );
        // Tear down locally first. A dead peer never completes the closing
        // handshake, so `ws`'s close() would sit on its 30s timeout before
        // emitting anything; handleClose here starts the reconnect now and
        // the real (late) close event lands on the identity guard.
        this.handleClose(ws, 1006);
        ws.close();
      },
    );
  }

  // Schedules the next reconnect attempt at the current backoff and
  // advances the backoff, exactly as the old inline `onclose` logic did.
  // A no-op if `close()` has already stopped this client.
  private scheduleReconnect(): void {
    if (this.stopped || this.blocked || (this.recoveryOwned && !this.admitting)) return;
    if (this.attachOptions && this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.backoffMax);
  }

  private onTextMessage(raw: string): void {
    const msg = parseWireMessage(raw);
    if (!msg) return;
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "remote error"));
    } else if (msg.t === "evt") {
      for (const cb of this.eventCbs) cb(msg.channel, msg.payload);
    }
  }

  private onFrameMessage(bytes: Uint8Array): void {
    for (const cb of this.frameCbs) cb(bytes);
  }

  // Sends a request and resolves/rejects with the matching `res` message.
  // Fails fast (no queuing) if the socket isn't open, and rejects on its
  // own timeout if no response arrives in time.
  request<T = unknown>(channel: string, args: unknown, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    if (this.attachOptions && !this.admitted) {
      return Promise.reject(new Error(`not admitted (${channel})`));
    }
    return this.rawRequest(channel, args, timeoutMs, signal);
  }

  private rawRequest<T>(channel: string, args: unknown, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    if (!this.ws || this.ws.readyState !== OPEN) {
      return Promise.reject(new Error(`not connected (${channel})`));
    }
    if (signal?.aborted) return Promise.reject(new Error("request canceled"));
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request timed out (${channel})`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    const abort = () => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error("request canceled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.ws.send(JSON.stringify({ t: "req", id, channel, args }));
    return promise.finally(() => signal?.removeEventListener("abort", abort));
  }

  // Fire-and-forget push to the server; silently no-ops if not connected.
  notify(channel: string, payload: unknown): void {
    if (this.attachOptions && !this.admitted) return;
    if (!this.ws || this.ws.readyState !== OPEN) return;
    this.ws.send(JSON.stringify({ t: "evt", channel, payload }));
  }

  // Fire-and-forget binary passthrough (pty input); silently no-ops if not connected.
  sendFrame(bytes: Uint8Array): void {
    if (this.attachOptions && !this.admitted) return;
    if (!this.ws || this.ws.readyState !== OPEN) return;
    this.ws.send(bytes);
  }

  // Subscribes to server-pushed `evt` messages; returns an unsubscribe function.
  onEvent(cb: (channel: string, payload: unknown) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  // Subscribes to binary term frames; returns an unsubscribe function.
  onFrame(cb: (bytes: Uint8Array) => void): () => void {
    this.frameCbs.add(cb);
    return () => this.frameCbs.delete(cb);
  }

  // Subscribes to connection status changes; returns an unsubscribe function.
  onStatus(cb: (s: RemoteStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  getStatus(): RemoteStatus {
    return this.status;
  }

  /** Bytes queued on the socket. Port forwarding pauses its local reads
   *  above a high-water mark so a slow consumer cannot balloon this. */
  bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  // Stops the client: cancels any pending reconnect and closes the socket.
  close(): void {
    this.stopped = true;
    this.dialRevision++;
    this.stopHeartbeat();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.onVisibilityChange && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.dialAttempt = null;
    this.cancelAdmission();
    const ws = this.ws;
    this.ws = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("connection closed")); }
    this.pending.clear();
    this.setStatus("closed");
    ws?.close();
  }

  private setStatus(s: RemoteStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of this.statusCbs) cb(s);
  }
}
