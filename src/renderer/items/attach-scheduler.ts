/**
 * Which terminal attaches when. Visible tiles attach at once, in
 * parallel; hidden tiles (a pane at display:none, everything under the
 * mobile home list) queue PER MACHINE and attach one at a time, once the
 * machine's visible attaches have settled — so a reload with one pane on
 * screen fetches one tail, and a wedged cloud machine never holds local
 * terminals hostage. Spec §2 of
 * docs/superpowers/specs/2026-09-04-terminal-attach-cost-design.md.
 *
 * "Settled" is generous on purpose: a run counts as settled when it
 * resolves, rejects, or has held its slot for QUEUE_SLOT_MS. The attach
 * keeps going off-queue after that (reconnectWithRetry owns its own 180 s
 * budget, whose clock starts when the run starts, not when it queued) —
 * the queue simply stops waiting for it.
 *
 * `hasStarted` is the "already started" guard TerminalItem's
 * sessionInitStarted used to be: true once a request has RUN. A queued
 * request that is cancelled (unmount, session lost, close) was never
 * started and re-queues cleanly on the next mount.
 *
 * Plain module, injectable timers, no React, no DOM.
 */

export const QUEUE_SLOT_MS = 15_000;

export interface AttachRequest {
  itemId: string;
  machineId: string;
  visible: boolean;
  run: () => Promise<void>;
  /** Re-checked when a queued request's turn comes; false skips it. */
  stillValid?: () => boolean;
}

export interface AttachScheduler {
  request(req: AttachRequest): void;
  /** Runs at once, bypassing the started/queued guard — a remount's re-attach of an item that already started. */
  requestNow(req: AttachRequest): void;
  setVisible(itemId: string, visible: boolean): void;
  cancel(itemId: string): void;
  hasStarted(itemId: string): boolean;
  /** Test-only: forget everything. */
  _reset(): void;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface MachineQueue {
  /** Visible attaches in flight (their settle releases the hidden queue). */
  visibleInFlight: number;
  /** The hidden attach currently holding the slot, if any. */
  slotHeld: boolean;
  queued: AttachRequest[];
}

export function createAttachScheduler(deps: Partial<Timers> = {}): AttachScheduler {
  const timers: Timers = {
    setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
  };
  const machines = new Map<string, MachineQueue>();
  const started = new Set<string>();
  const queuedItems = new Map<string, string>(); // itemId -> machineId

  const queueFor = (machineId: string): MachineQueue => {
    let q = machines.get(machineId);
    if (!q) {
      q = { visibleInFlight: 0, slotHeld: false, queued: [] };
      machines.set(machineId, q);
    }
    return q;
  };

  const settle = (req: AttachRequest, onSettled: () => void): void => {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      onSettled();
    };
    const timer = timers.setTimeout(once, QUEUE_SLOT_MS);
    // Go through Promise.resolve().then so a run() that throws synchronously
    // settles the slot via the rejection path below instead of escaping
    // uncaught out of request/requestNow/setVisible.
    Promise.resolve().then(() => req.run()).then(
      () => {
        timers.clearTimeout(timer);
        once();
      },
      () => {
        timers.clearTimeout(timer);
        once();
      },
    );
  };

  /** Removes any queued (not-yet-started) entry for itemId, if present. */
  const dequeue = (itemId: string): AttachRequest | undefined => {
    const machineId = queuedItems.get(itemId);
    if (machineId === undefined) return undefined;
    const q = queueFor(machineId);
    const at = q.queued.findIndex((r) => r.itemId === itemId);
    if (at === -1) return undefined;
    const [req] = q.queued.splice(at, 1);
    queuedItems.delete(itemId);
    return req;
  };

  const runVisible = (req: AttachRequest): void => {
    const q = queueFor(req.machineId);
    started.add(req.itemId);
    q.visibleInFlight += 1;
    settle(req, () => {
      q.visibleInFlight -= 1;
      drain(req.machineId);
    });
  };

  const drain = (machineId: string): void => {
    const q = queueFor(machineId);
    if (q.slotHeld || q.visibleInFlight > 0) return;
    const next = q.queued.shift();
    if (!next) return;
    queuedItems.delete(next.itemId);
    if (next.stillValid && !next.stillValid()) {
      // Skipped, never started; move on in a microtask so a long run of
      // stale entries cannot recurse deeply.
      void Promise.resolve().then(() => drain(machineId));
      return;
    }
    started.add(next.itemId);
    q.slotHeld = true;
    settle(next, () => {
      q.slotHeld = false;
      drain(machineId);
    });
  };

  return {
    request(req) {
      if (started.has(req.itemId) || queuedItems.has(req.itemId)) return;
      if (req.visible) {
        runVisible(req);
        return;
      }
      queueFor(req.machineId).queued.push(req);
      queuedItems.set(req.itemId, req.machineId);
      // Deferred by a microtask, never drained inline. TerminalItems mount
      // in mountedItemIds order and every mount effect of one React commit
      // runs synchronously, so a hidden item listed BEFORE the visible pane
      // would otherwise see visibleInFlight === 0, take the slot, and
      // contend with the visible tail for the machine's socket — the exact
      // thing this queue exists to prevent. One microtask is enough: it
      // lands after the whole commit's effects, so every visible request of
      // that commit is already counted in.
      queueMicrotask(() => drain(req.machineId));
    },
    requestNow(req) {
      // Drop any stale queue entry first — otherwise drain() would run this
      // item a second time once the queue reaches it.
      dequeue(req.itemId);
      runVisible(req);
    },
    setVisible(itemId, visible) {
      if (!visible) return;
      const req = dequeue(itemId);
      if (!req) return;
      runVisible({ ...req, visible: true });
    },
    cancel(itemId) {
      dequeue(itemId);
    },
    hasStarted(itemId) {
      return started.has(itemId);
    },
    _reset() {
      machines.clear();
      started.clear();
      queuedItems.clear();
    },
  };
}

export const attachScheduler: AttachScheduler = createAttachScheduler();
