// Browser-safe admission transaction shared by desktop and web. Spec §2 and §12.
import { parseManifest, type CubedManifest } from "./cubed-manifest-schema";
import type { DaemonPingReply } from "./cubed-protocol";
import type { DaemonLogger } from "./daemon-log";
import type { AppPlaneFailure } from "./app-plane-outcome";

/** Safe evidence retained by the cloud recovery diagnostics reporter. */
export type InitialProbeOutcome = { outcome: "response" } | { outcome: "failure"; failure: AppPlaneFailure };

/** Shared transaction identity for admission and confirmed machine rolls. */
export function newTxn(): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export type AttachReason = "ptyd-floor" | "ptyd-unknown" | "daemon-unavailable" | "runtime-vanished" | "runtime-replaced"
  | "install-failed:artifact" // Web-only: fetching or verifying the tab's own artifact failed.
  | "failed-before" | "not-a-release" | "hash-mismatch" | `install-failed:${"stage" | "rename" | "exists" | "trial" | "flip" | "read"}` | "demoted-this-run" | "demoted" | "superseded" | "install-expired" | `timeout:${AttachPhase}`;
export type AttachPhase = "identity" | "probation" | "install" | "respawn";
export type AttachOutcome =
  | { kind: "level"; daemon: DaemonPingReply; installed?: { over: string | null; overBuild: number | null } }
  | { kind: "machine-ahead"; daemon: DaemonPingReply }
  | { kind: "restart-needed"; reason: "ptyd-floor" | "ptyd-unknown" | "daemon-unavailable" | "runtime-vanished" | "runtime-replaced"; daemon: DaemonPingReply | null }
  | { kind: "blocked"; reason: AttachReason; phase?: AttachPhase; saw?: DaemonPingReply | null; installRefusal?: string };
export interface AttachDeps {
  /** One request on the socket being admitted. Rejects on transport failure. */
  ask: <T>(channel: string, args?: unknown, timeoutMs?: number) => Promise<T>;
  /** Initial physical connection is part of this transaction. */
  connect?: (budgetMs: number) => Promise<AttachDeps["ask"]>;
  signal?: AbortSignal;
  /** Re-dial after an install; resolves a new ask, or rejects after budgetMs. */
  redial: (budgetMs: number) => Promise<AttachDeps["ask"]>;
  /** Providers can bound/cancel acquisition within budgetMs and log with the transaction's txn. */
  bytes: (context: { log: DaemonLogger; budgetMs: number }) => Promise<{ index: string; manifest: CubedManifest }>;
  client: CubedManifest;
  machine: string;
  /** Per-machine, per-run memory shared across transactions. */
  demoted: Set<string>;
  log: DaemonLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgets?: { transactionMs?: number; probationMs?: number; installMs?: number; respawnMs?: number; pollMs?: number };
}
export interface AttachResult {
  artifactStatus?: number | "hash-mismatch" | "timeout";
  outcome: AttachOutcome;
  txn: string;
  ms: number;
  attempts: number;
  installResult?: "accepted" | "refused" | "failed" | "unobserved";
  installRefusal?: string;
  waitMs: number;
}

/** A byte provider can distinguish web artifact failures from local disk reads. */
export class AttachBytesError extends Error {
  constructor(readonly reason: "install-failed:read" | "install-failed:artifact", readonly artifactStatus?: AttachResult["artifactStatus"]) {
    super(reason);
    this.name = "AttachBytesError";
  }
}

/** Opening transport failure, with the terminal transaction result for callers. */
export class AttachError extends Error {
  constructor(readonly result: AttachResult, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AttachError";
  }
}

/** Pure row selection. Identity wins over build ordering; the floor gates installs. */
export function decide(client: CubedManifest, daemon: DaemonPingReply): "level" | "wait-probation" | "install" | "machine-ahead" | "restart-needed" {
  if (daemon.bundleId === client.bundleId) return daemon.probation ? "wait-probation" : "level";
  if (daemon.build !== null && daemon.build >= client.build) return "machine-ahead";
  if (daemon.ptydInterface === null || daemon.ptydInterface < client.ptydInterface) return "restart-needed";
  return daemon.probation ? "wait-probation" : "install";
}

/** Real timers bound requests; injected sleep advances only polling in tests. */
function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new Error("attach cancelled")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("attach request timed out")); }, Math.max(0, ms));
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function refusal(error: unknown): string | undefined {
  const code = error instanceof Error ? error.message : error;
  if (typeof code !== "string") return undefined;
  return ["busy", "not-newer", "failed-before", "not-a-release", "hash-mismatch"].includes(code) || ["stage", "rename", "exists", "trial", "flip", "read", "artifact"].some(phase => code === `install-failed:${phase}`) ? code : undefined;
}

/** One transaction can spend the phase allowances once, including physical connection time. */
export function attachBudgetMs(budgets: AttachDeps["budgets"] = {}): number {
  return budgets.transactionMs ?? (budgets.probationMs ?? 45_000) + (budgets.installMs ?? 60_000) + (budgets.respawnMs ?? 90_000);
}

/** Runs §2's table. Opening exhaustion throws a terminal result; lost installs are polled, never resent. */
export async function attach(deps: AttachDeps): Promise<AttachResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const budgets = {
    probationMs: deps.budgets?.probationMs ?? 45_000,
    installMs: deps.budgets?.installMs ?? 60_000,
    respawnMs: deps.budgets?.respawnMs ?? 90_000,
    pollMs: deps.budgets?.pollMs ?? 1_000,
  };
  const start = now();
  const deadline = start + attachBudgetMs(deps.budgets);
  const remaining = (cap = Infinity) => Math.max(0, Math.min(cap, deadline - now()));
  const bound = <T>(work: () => Promise<T>, ms: number): Promise<T> => {
    if (deps.signal?.aborted || remaining(ms) <= 0) return Promise.reject(new Error("attach deadline exhausted"));
    return bounded(work(), remaining(ms), deps.signal);
  };
  const txn = newTxn();
  const log = deps.log.child({ machine: deps.machine, txn });
  const { client } = deps;
  let ask = deps.ask;
  let saw: DaemonPingReply | null = null;
  let attempts = 0;
  let reruns = 0;
  let waitMs = 0;
  let installResult: AttachResult["installResult"];
  let installRefusal: string | undefined;
  let artifactStatus: AttachResult["artifactStatus"];
  let observed: Record<string, unknown> = {};
  let installed: { over: string | null; overBuild: number | null } | undefined;

  log("attach.start", { client_bundle: client.bundleId, client_build: client.build, client_floor: client.ptydInterface });
  const finish = (outcome: AttachOutcome): AttachResult => {
    const ms = now() - start;
    log("attach.outcome", {
      outcome: outcome.kind, reason: "reason" in outcome ? outcome.reason : undefined,
      phase: outcome.kind === "blocked" ? outcome.phase : undefined,
      saw: saw?.bundleId, saw_build: saw?.build,
      installed: outcome.kind === "level" && outcome.installed !== undefined, ms,
    });
    if (outcome.kind === "level") log("attach.admit", { bundle: outcome.daemon.bundleId });
    return { outcome, txn, ms, attempts, waitMs,
      ...(artifactStatus !== undefined ? { artifactStatus } : {}),
      ...(installResult ? { installResult } : {}), ...(installRefusal ? { installRefusal } : {}) };
  };
  const blocked = (reason: AttachReason, phase: AttachPhase): AttachOutcome => ({
    kind: "blocked", reason, phase, saw, ...(installRefusal ? { installRefusal } : {}),
  });
  const ping = async (ms: number): Promise<DaemonPingReply> => {
    const raw = await bound(() => ask<Record<string, unknown>>("daemon:ping", { expect: client.bundleId, txn }, remaining(ms)), ms);
    observed = raw;
    saw = readIdentity(raw);
    return saw;
  };
  const redial = async (ms: number): Promise<void> => { ask = await bound(() => deps.redial(remaining(ms)), ms); };
  const pause = async (phaseDeadline: number): Promise<void> => {
    if (deps.signal?.aborted) return;
    const ms = remaining(phaseDeadline - now());
    await bounded(sleep(Math.min(Math.max(1, budgets.pollMs), ms)), ms, deps.signal).catch(() => {});
  };
  const identity = (daemon: DaemonPingReply): void => log("attach.identity", {
    bundle: daemon.bundleId, build: daemon.build, ptyd: daemon.ptydInterface,
    probation: daemon.probation, installing: typeof observed.installing === "boolean" ? observed.installing : undefined, env: daemon.env, admitted: typeof observed.admitted === "boolean" ? observed.admitted : undefined,
  });

  // A wait returns no daemon when the socket died and was replaced. The caller
  // re-runs identity on that new socket rather than reusing the old observation.
  const wait = async (reason: "probation" | "installing", deadline: number): Promise<DaemonPingReply | null | "expired"> => {
    const began = now();
    log("attach.wait", { reason, phase: "start" });
    try {
      while (now() < deadline && !deps.signal?.aborted) {
        await pause(deadline);
        if (now() >= deadline) break;
        let daemon: DaemonPingReply;
        try { daemon = await ping(deadline - now()); }
        catch {
          try { await redial(deadline - now()); return null; }
          catch { return "expired"; }
        }
        if (!daemon.probation && (reason !== "installing" || !daemon.installing)) return daemon;
      }
      return "expired";
    } finally {
      const ms = now() - began;
      waitMs += ms;
      log("attach.wait", { reason, phase: "end", ms });
    }
  };

  let daemon: DaemonPingReply;
  try {
    if (deps.connect) ask = await bound(() => deps.connect!(remaining()), remaining());
    daemon = await ping(budgets.respawnMs);
  }
  catch {
    try { await redial(budgets.respawnMs); daemon = await ping(budgets.respawnMs); }
    catch (error) { throw new AttachError(finish({ kind: "restart-needed", reason: "daemon-unavailable", daemon: null }), error); }
  }
  identity(daemon);

  const respawn = async (before: DaemonPingReply, sent: number): Promise<AttachOutcome> => {
    const began = now();
    const respawnDeadline = Math.min(deadline, began + budgets.respawnMs);
    let probationStart: number | undefined;
    let sawTarget = false;
    const end = (ending: "level" | "higher" | "lower" | "expired", outcome: AttachOutcome): AttachOutcome => {
      waitMs += now() - began;
      if (probationStart !== undefined) log("attach.wait", { reason: "probation", phase: "end", ms: now() - probationStart });
      log("attach.respawn", { saw: saw?.bundleId, saw_build: saw?.build, ending, ms: now() - sent });
      return outcome;
    };
    try { await redial(respawnDeadline - now()); }
    catch { return end("expired", blocked("install-expired", "respawn")); }
    while (now() < respawnDeadline && !deps.signal?.aborted) {
      let seen: DaemonPingReply;
      try { seen = await ping(respawnDeadline - now()); }
      catch {
        await pause(respawnDeadline);
        if (now() >= respawnDeadline) break;
        try { await redial(respawnDeadline - now()); } catch { break; }
        continue;
      }
      if (seen.bundleId === client.bundleId) {
        sawTarget = true;
        if (!seen.probation) {
          if (!seen.admitted) {
            // Recheck the entire identity on confirmation, since the socket may
            // have lost a race with another install while probation ended.
            try { seen = await ping(respawnDeadline - now()); } catch { await pause(respawnDeadline); continue; }
          }
          if (seen.bundleId === client.bundleId && !seen.probation && seen.admitted) {
            installed = { over: before.bundleId, overBuild: before.build };
            return end("level", { kind: "level", daemon: seen, installed });
          }
        }
        if (seen.bundleId === client.bundleId && seen.probation && probationStart === undefined) {
          probationStart = now();
          log("attach.wait", { reason: "probation", phase: "start" });
        }
      }
      if (seen.bundleId !== client.bundleId) {
        // The outgoing id is allowed until the target has actually been seen.
        if (seen.bundleId !== before.bundleId || sawTarget) {
          if (seen.build !== null && seen.build >= client.build) return end("higher", blocked("superseded", "respawn"));
          deps.demoted.add(client.bundleId);
          return end("lower", blocked("demoted", "respawn"));
        }
      }
      await pause(respawnDeadline);
    }
    return end("expired", blocked("install-expired", "respawn"));
  };

  while (true) {
    if (remaining() <= 0 || deps.signal?.aborted) return finish(blocked("timeout:identity", "identity"));
    const decision = decide(client, daemon);
    if (decision === "level") {
      if (daemon.admitted) return finish({ kind: "level", daemon, ...(installed ? { installed } : {}) });
      try { daemon = await ping(budgets.respawnMs); }
      catch { return finish(blocked("timeout:identity", "identity")); }
      if (++reruns > 5) return finish(blocked("timeout:identity", "identity"));
      continue;
    }
    if (decision === "machine-ahead") return finish({ kind: "machine-ahead", daemon });
    if (decision === "restart-needed") return finish({ kind: "restart-needed", reason: daemon.ptydInterface === null ? "ptyd-unknown" : "ptyd-floor", daemon });
    if (decision === "wait-probation") {
      const result = await wait("probation", Math.min(deadline, now() + budgets.probationMs));
      if (result === "expired") return finish(blocked("timeout:probation", "probation"));
      if (result !== null) { daemon = result; continue; }
    } else {
      if (deps.demoted.has(client.bundleId)) return finish(blocked("demoted-this-run", "install"));
      let bytes: Awaited<ReturnType<AttachDeps["bytes"]>>;
      // Start the provider first so its own deadline can classify/log failure
      // before the fallback timer for providers that never settle.
      const installDeadline = Math.min(deadline, now() + budgets.installMs);
      try { bytes = await bound(() => deps.bytes({ log, budgetMs: remaining(installDeadline - now()) }), installDeadline - now()); }
      catch (error) {
        if (error instanceof AttachBytesError) artifactStatus = error.artifactStatus;
        return finish(blocked(error instanceof AttachBytesError ? error.reason : "install-failed:read", "install"));
      }
      const manifest = parseManifest(bytes.manifest);
      if (!manifest) return finish(blocked("install-failed:read", "install"));
      if (manifest.bundleId !== client.bundleId || manifest.build !== client.build) return finish(blocked("hash-mismatch", "install"));
      if (remaining(installDeadline - now()) <= 0 || deps.signal?.aborted) return finish(blocked("timeout:install", "install"));
      const sent = now();
      attempts++;
      log("attach.install", { attempt: attempts, target: client.bundleId, target_build: client.build, over: daemon.bundleId, over_build: daemon.build });
      let code: string | undefined;
      let unknownCode: string | undefined;
      try {
        const reply = await bound(() => ask<{ ok: true }>("cubed:install", { bundleId: client.bundleId, index: bytes.index, manifest: bytes.manifest, txn, attempt: attempts }, remaining(installDeadline - now())), installDeadline - now());
        installResult = reply?.ok === true ? "accepted" : "unobserved";
      } catch (error) {
        code = refusal(error);
        const rawCode = error instanceof Error ? error.message : error;
        if (!code && typeof rawCode === "string") unknownCode = rawCode.slice(0, 32);
        installResult = code ? code.startsWith("install-failed:") ? "failed" : "refused" : "unobserved";
      }
      if (code) installRefusal = code;
      log("attach.install.reply", { attempt: attempts, reply: installResult, code, saw: unknownCode });
      if (installResult === "accepted" || installResult === "unobserved") return finish(await respawn(daemon, sent));
      if (code === "busy") {
        const result = await wait("installing", Math.min(deadline, now() + budgets.installMs));
        if (result === "expired") return finish(blocked("timeout:install", "install"));
      } else if (code !== "not-newer") {
        return finish(blocked(code as AttachReason, "install"));
      }
    }
    if (++reruns > 5) return finish(blocked("timeout:identity", "identity"));
    try { daemon = await ping(budgets.respawnMs); }
    catch {
      try { await redial(budgets.respawnMs); daemon = await ping(budgets.respawnMs); }
      catch { return finish(blocked("timeout:identity", "identity")); }
    }
    identity(daemon);
  }
}

/** Normalize a channel-era ping into the current reply shape. */
export function readIdentity(raw: Record<string, unknown>): DaemonPingReply {
  const integer = (key: string): number | null => typeof raw[key] === "number" && Number.isInteger(raw[key]) ? raw[key] as number : null;
  return {
    pid: integer("pid") ?? 0, uptime: typeof raw.uptime === "number" ? raw.uptime : 0,
    protocolVersion: 1, version: typeof raw.version === "string" ? raw.version : "",
    bundleId: typeof raw.bundleId === "string" ? raw.bundleId : null,
    cubedInterface: integer("cubedInterface"), build: integer("build"), ptydInterface: integer("ptydInterface"),
    probation: raw.probation === true, installing: raw.installing === true,
    env: raw.env === "production" || raw.env === "staging" || raw.env === "dev" ? raw.env : undefined,
    admitted: raw.admitted === true, release: raw.release === true,
  };
}

/** Request signature shared by scripted daemon test helpers. */
export type DaemonAsk = AttachDeps["ask"];
