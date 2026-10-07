// Adapted from src/main/cubed/attention/state.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, derive, emptySession, reduce, type AttentionEvent, type SessionData } from "../../src/server/attention/state";

const L = DEFAULT_LIMITS;
const at = 1_000;

function run(events: AttentionEvent[], limits = L, start: SessionData = emptySession()) {
  let data = start;
  let stamps = 0;
  for (const e of events) {
    const out = reduce(data, e, limits);
    data = out.data;
    if (out.stamp) stamps += 1;
  }
  return { data, stamps };
}
const state = (d: SessionData, now = at, limits = L) => derive(d, now, limits).state;

describe("derive", () => {
  it("is idle when nothing has happened", () => {
    expect(state(emptySession())).toBe("idle");
  });

  it("is running while a turn is open", () => {
    expect(state(run([{ kind: "turn-opened", turn: "A", at }]).data)).toBe("running");
  });

  it("is blocked while a request is pending, even with a turn open", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "k1", at },
    ]).data)).toBe("blocked");
  });
});

describe("pending sets are turn-keyed", () => {
  it("a turn ending retires only its own set", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "a1", at },
      { kind: "permission-requested", turn: "B", key: "b1", at },
      { kind: "turn-ended", turn: "A", at },
    ]).data)).toBe("blocked");
  });

  it("opening a new turn retires nothing", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "a1", at },
      { kind: "turn-opened", turn: "B", at },
    ]).data)).toBe("blocked");
  });

  it("a duplicate open for the current turn is idempotent", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "a1", at },
      { kind: "turn-opened", turn: "A", at },
    ]).data)).toBe("blocked");
  });
});

describe("the unattributed bucket is never retired by a turn", () => {
  it("survives a named turn ending", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: null, key: "u1", at },
      { kind: "turn-ended", turn: "A", at },
    ]).data)).toBe("blocked");
  });

  it("survives a turn-less end, which can claim no turn at all", () => {
    expect(state(run([
      { kind: "permission-requested", turn: null, key: "u1", at },
      { kind: "turn-ended", turn: null, at },
    ]).data)).toBe("blocked");
  });

  it("clears on gone", () => {
    expect(state(run([
      { kind: "permission-requested", turn: null, key: "u1", at },
      { kind: "gone", at },
    ]).data)).toBe("idle");
  });

  it("clears on dismissed", () => {
    expect(state(run([
      { kind: "permission-requested", turn: null, key: "u1", at },
      { kind: "dismissed", at },
    ]).data)).toBe("idle");
  });
});

describe("stale turn reports are rejected", () => {
  it("a permission naming an already-ended turn is ignored", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "turn-ended", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "late", at: at + 1 },
    ]).data, at + 1)).toBe("idle");
  });

  it("a second end for the same turn does not stamp again", () => {
    const { stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "turn-ended", turn: "A", at },
      { kind: "turn-ended", turn: "A", at: at + 1 },
    ]);
    expect(stamps).toBe(1);
  });

  it("a turn the FLOOR ended is remembered too", () => {
    // The floor closes a turn just as a hook does. If only hook-sourced ends
    // were recorded, a late permission could attach to a finished turn and
    // block the row forever.
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
      { kind: "permission-requested", turn: "A", key: "late", at: at + L.leaseMs + 2 },
    ]).data, at + L.leaseMs + 2)).toBe("idle");
  });

  it("a turn a BELL ended is remembered too", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "bell", at },
      { kind: "permission-requested", turn: "A", key: "late", at: at + 1 },
    ]).data, at + 1)).toBe("idle");
  });

  it("a floor-ended turn cannot be reopened and stamped a second time", () => {
    const { stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
      { kind: "turn-opened", turn: "A", at: at + L.leaseMs + 2 },
      { kind: "turn-ended", turn: "A", at: at + L.leaseMs + 3 },
    ]);
    expect(stamps).toBe(1);
  });

  it("a reopen of an already-ended turn is ignored", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "turn-ended", turn: "A", at },
      { kind: "turn-opened", turn: "A", at: at + 1 },
    ]).data, at + 1)).toBe("idle");
  });
});

describe("settlement is conservative", () => {
  it("a settle with no request identity removes nothing", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "a1", at },
      { kind: "permission-settled", turn: "A", key: null, at },
    ]).data)).toBe("blocked");
  });

  it("a turn-less settle does not clear an unattributed request", () => {
    // The spec retires an unattributed request by exit or dismissal only.
    // Nothing else is entitled to decide a question nobody could attribute
    // was answered.
    expect(state(run([
      { kind: "permission-requested", turn: null, key: "u1", at },
      { kind: "permission-settled", turn: null, key: "u1", at },
    ]).data)).toBe("blocked");
  });

  it("a settle naming the request removes it", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "a1", at },
      { kind: "permission-settled", turn: "A", key: "a1", at },
    ]).data)).toBe("running");
  });
});

describe("floor termination", () => {
  it("a bell while a request is pending does nothing and stamps nothing", () => {
    const { data, stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "a1", at },
      { kind: "bell", at },
    ]);
    expect(state(data)).toBe("blocked");
    expect(stamps).toBe(0);
  });

  it("a bell while an OTHER turn's request is pending still does nothing", () => {
    const { stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "B", key: "b1", at },
      { kind: "bell", at },
    ]);
    expect(stamps).toBe(0);
  });

  it("a bell while an UNATTRIBUTED request is pending still does nothing", () => {
    const { stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: null, key: "u1", at },
      { kind: "bell", at },
    ]);
    expect(stamps).toBe(0);
  });

  it("a bell ends an authoritative turn and stamps", () => {
    const { data, stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "bell", at },
    ]);
    expect(stamps).toBe(1);
    expect(state(data)).toBe("idle");
  });

  it("a bell on an idle session does nothing", () => {
    expect(run([{ kind: "bell", at }]).stamps).toBe(0);
  });
});

describe("the lease", () => {
  it("a hook-opened turn is not immediately ended by a sweep", () => {
    // The lease is renewed by the hook report itself. Without that, a turn
    // opened at T is stamped by the very next sweep, because no output has
    // arrived yet.
    const { stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "quiet", at: at + 1 },
    ]);
    expect(stamps).toBe(0);
  });

  it("a hook-opened turn is ended by the floor once the lease lapses", () => {
    const { stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
    ]);
    expect(stamps).toBe(1);
  });

  it("output renews the lease", () => {
    const { stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "output", cursor: 10, bytes: 10, at: at + L.leaseMs },
      { kind: "quiet", at: at + L.leaseMs + 1 },
    ]);
    expect(stamps).toBe(0);
  });
});

describe("the floor may open a turn but never stamps one it opened", () => {
  it("sustained output opens an inferred turn when no hook lane exists", () => {
    expect(state(run([
      { kind: "output", cursor: 500, bytes: L.openBytes, at },
    ]).data)).toBe("running");
  });

  it("accumulates a run across small chunks", () => {
    const chunk = Math.ceil(L.openBytes / 8);
    const events: AttentionEvent[] = [];
    for (let i = 0; i < 8; i++) events.push({ kind: "output", cursor: (i + 1) * chunk, bytes: chunk, at });
    expect(state(run(events).data)).toBe("running");
  });

  it("an inferred turn ends WITHOUT stamping", () => {
    const { data, stamps } = run([
      { kind: "output", cursor: 500, bytes: L.openBytes, at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
    ]);
    expect(stamps).toBe(0);
    expect(state(data, at + L.leaseMs + 1)).toBe("idle");
  });

  it("a hook-opened turn ended by the floor DOES stamp", () => {
    expect(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
    ]).stamps).toBe(1);
  });

  it("a healthy hook lane suppresses inference", () => {
    expect(state(run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "turn-ended", turn: "A", at },
      { kind: "output", cursor: 900, bytes: L.openBytes, at: at + 1 },
    ]).data, at + 1)).toBe("idle");
  });

  it("a slow streamer still opens a turn across sweeps", () => {
    // Small chunks with sweeps landing between them. An early quiet that
    // reset the run would mean a slowly streaming agent never infers a turn
    // at all, which is the whole fallback for a session with no hooks.
    const chunk = Math.ceil(L.openBytes / 8);
    const events: AttentionEvent[] = [];
    for (let i = 0; i < 8; i++) {
      events.push({ kind: "output", cursor: (i + 1) * chunk, bytes: chunk, at: at + i });
      events.push({ kind: "quiet", at: at + i });
    }
    expect(state(run(events).data, at + 8)).toBe("running");
  });

  it("quiet resets the accumulated run so it cannot carry across turns", () => {
    const half = Math.floor(L.openBytes / 2) + 1;
    expect(state(run([
      { kind: "output", cursor: half, bytes: half, at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
      { kind: "output", cursor: half * 2, bytes: half, at: at + L.leaseMs + 2 },
    ]).data, at + L.leaseMs + 2)).toBe("idle");
  });
});

describe("lane health and staleness", () => {
  it("blocked is stale once the health window lapses", () => {
    const { data } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "a1", at },
    ]);
    expect(derive(data, at, L).stale).toBe(false);
    expect(derive(data, at + L.laneHealthMs + 1, L).stale).toBe(true);
  });

  it("staleness never retires a request", () => {
    const { data } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "a1", at },
    ]);
    expect(state(data, at + L.laneHealthMs * 10)).toBe("blocked");
  });

  it("a lease lapsing with a turn open marks the lane failed, re-enabling inference", () => {
    // The hook promised a Stop for turn A and never sent one. Inference must
    // come back even though the health window has not expired.
    const d1 = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
    ]).data;
    const d2 = reduce(d1, { kind: "output", cursor: 9_000, bytes: L.openBytes, at: at + L.leaseMs + 2 }, L).data;
    expect(state(d2, at + L.leaseMs + 2)).toBe("running");
  });

  it("a lease lapsing after sustained output with no prompt report marks the lane failed", () => {
    // Hooks were healthy, then broke. Output arrived that a healthy lane
    // would have announced with a prompt-submit, and nothing came. Inference
    // must return without waiting out the whole health window.
    const d1 = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "turn-ended", turn: "A", at },
      { kind: "output", cursor: 1_000, bytes: L.openBytes, at: at + 1 },
      { kind: "quiet", at: at + L.leaseMs + 2 },
    ]).data;
    const d2 = reduce(d1, { kind: "output", cursor: 9_000, bytes: L.openBytes, at: at + L.leaseMs + 3 }, L).data;
    expect(state(d2, at + L.leaseMs + 3)).toBe("running");
  });

  it("a pending request whose lease lapses becomes stale without an open turn", () => {
    const { data } = run([
      { kind: "permission-requested", turn: "A", key: "a1", at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
    ]);
    const out = derive(data, at + L.leaseMs + 1, L);
    expect(out.state).toBe("blocked");
    expect(out.stale).toBe(true);
  });

  it("an early sweep does not erase the evidence a report was owed", () => {
    // The sweep fires more often than the lease lapses, so a quiet inside
    // the lease is the common case. It must not destroy the output run the
    // failure check reads.
    const d1 = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "turn-ended", turn: "A", at },
      { kind: "output", cursor: 1_000, bytes: L.openBytes, at: at + 1 },
      { kind: "quiet", at: at + 2 },
      { kind: "quiet", at: at + L.leaseMs + 2 },
    ]).data;
    const d2 = reduce(d1, { kind: "output", cursor: 9_000, bytes: L.openBytes, at: at + L.leaseMs + 3 }, L).data;
    expect(state(d2, at + L.leaseMs + 3)).toBe("running");
  });

  it("ordinary idle silence is not lane failure", () => {
    // Nothing was owed, so a quiet sweep must not mark the lane failed and
    // re-enable inference on a session that is simply sitting there.
    const d1 = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "turn-ended", turn: "A", at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
    ]).data;
    expect(d1.laneFailed).toBe(false);
  });

  it("a fresh hook report restores the lane and suspends inference again", () => {
    const d1 = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "quiet", at: at + L.leaseMs + 1 },
      { kind: "turn-opened", turn: "B", at: at + L.leaseMs + 2 },
      { kind: "turn-ended", turn: "B", at: at + L.leaseMs + 3 },
    ]).data;
    const d2 = reduce(d1, { kind: "output", cursor: 9_000, bytes: L.openBytes, at: at + L.leaseMs + 4 }, L).data;
    expect(state(d2, at + L.leaseMs + 4)).toBe("idle");
  });
});

describe("bounded retained state", () => {
  const small = { ...DEFAULT_LIMITS, maxRequests: 3 };
  const flood = () => {
    let data = emptySession();
    for (let i = 0; i < 10; i++) {
      data = reduce(data, { kind: "permission-requested", turn: `t${i}`, key: `k${i}`, at }, small).data;
    }
    return data;
  };

  it("collapses to a conservative marker at the cap rather than growing", () => {
    const data = flood();
    expect(data.overflowed).toBe(true);
    expect(data.pending.size).toBe(0);
    expect(state(data, at, small)).toBe("blocked");
  });

  it("the collapsed marker SURVIVES a turn ending", () => {
    const data = reduce(flood(), { kind: "turn-ended", turn: "t0", at }, small).data;
    expect(state(data, at, small)).toBe("blocked");
  });

  it("the collapsed marker clears on gone", () => {
    const data = reduce(flood(), { kind: "gone", at }, small).data;
    expect(state(data, at, small)).toBe("idle");
  });

  it("the ended-turn record is bounded", () => {
    let data = emptySession();
    for (let i = 0; i < 500; i++) {
      data = reduce(data, { kind: "turn-opened", turn: `t${i}`, at }, small).data;
      data = reduce(data, { kind: "turn-ended", turn: `t${i}`, at }, small).data;
    }
    expect(data.endedTurns.length).toBeLessThanOrEqual(small.maxEndedTurns);
  });
});

describe("harness profiles", () => {
  const CLAUDE = { opens: true, ends: true };
  const CODEX = { opens: false, ends: true };
  const burst = (t: number) => ({ kind: "output", cursor: 0, bytes: 4096, at: t }) as const;

  it("a lane that cannot report opens still infers turns while healthy", () => {
    const { data } = run([
      { kind: "turn-opened", turn: "T1", at },
      { kind: "turn-ended", turn: "T1", at },
      { kind: "input", at: at + 100, typed: true },
      burst(at + L.graceMs + 1),
    ], L, emptySession(CODEX));
    expect(state(data, at + L.graceMs + 1)).toBe("running");
  });

  it("a lane that reports opens suspends inference while healthy", () => {
    const { data } = run([
      { kind: "turn-opened", turn: "T1", at },
      { kind: "turn-ended", turn: "T1", at },
      burst(at + L.graceMs + 1),
    ], L, emptySession(CLAUDE));
    expect(state(data, at + L.graceMs + 1)).toBe("idle");
  });

  it("a full lane never infers a turn from its startup banner, before any report", () => {
    const { data } = run([burst(at), burst(at + 100), burst(at + 200)], L, emptySession(CLAUDE));
    expect(state(data, at + 200)).toBe("idle");
  });

  it("a full lane's redraws between turns neither fail the lane nor open a turn", () => {
    const quietAt = at + L.graceMs + 50 + L.leaseMs + 1;
    const { data } = run([
      { kind: "turn-opened", turn: "T1", at },
      { kind: "turn-ended", turn: "T1", at },
      burst(at + L.graceMs + 50),
      { kind: "quiet", at: quietAt },
      burst(quietAt + 10 * 60_000),
    ], L, emptySession(CLAUDE));
    expect(data.laneFailed).toBe(false);
    expect(state(data, quietAt + 10 * 60_000)).toBe("idle");
  });

  it("a full lane seen failing hands opening back to the floor", () => {
    const quietAt = at + L.leaseMs + L.hookQuietMs + 1;
    const { data } = run([
      { kind: "turn-opened", turn: "T1", at },
      // No Stop ever arrives: the floor ends it and marks the lane failed.
      { kind: "quiet", at: quietAt },
      burst(quietAt + L.graceMs + 1),
    ], L, emptySession(CLAUDE));
    expect(data.laneFailed).toBe(true);
    expect(state(data, quietAt + L.graceMs + 1)).toBe("running");
  });

  it("output right after input is echo and never opens a turn", () => {
    const { data } = run([
      { kind: "input", at, typed: true },
      burst(at + 10),
      burst(at + 20),
    ], L, emptySession(CODEX));
    expect(state(data, at + 20)).toBe("idle");
  });

  it("no turn is inferred inside the grace window after an end", () => {
    const { data } = run([
      { kind: "turn-opened", turn: "T1", at },
      { kind: "turn-ended", turn: "T1", at },
      burst(at + 100),
    ], L, emptySession(CODEX));
    expect(state(data, at + 100)).toBe("idle");
  });

  it("output with no keystroke behind it never opens a turn on a lane that cannot report opens", () => {
    const { data } = run([burst(at), burst(at + 100)], L, emptySession(CODEX));
    expect(state(data, at + 100)).toBe("idle");
    // A resize makes the harness redraw; it is not the user asking for work.
    const resized = run([{ kind: "input", at, typed: false }, burst(at + 500)], L, emptySession(CODEX)).data;
    expect(state(resized, at + 500)).toBe("idle");
  });

  it("a keystroke is spent when its turn ends", () => {
    const { data } = run([
      { kind: "input", at, typed: true },
      burst(at + 500),
      { kind: "turn-opened", turn: "T1", at: at + 900 },
      { kind: "turn-ended", turn: "T1", at: at + 1_000 },
      burst(at + 1_000 + L.graceMs + 1),
    ], L, emptySession(CODEX));
    expect(state(data, at + 1_000 + L.graceMs + 1)).toBe("idle");
  });

  it("a hook end closes an inferred turn and stamps", () => {
    const { data, stamps } = run([
      { kind: "input", at: at - 1_000, typed: true },
      burst(at),
      { kind: "turn-ended", turn: "T1", at: at + 50 },
    ], L, emptySession(CODEX));
    expect(state(data, at + 50)).toBe("idle");
    expect(stamps).toBe(1);
  });

  it("a hook-opened turn on a lane that reports ends survives a short silence", () => {
    const quietAt = at + L.leaseMs + 1_000;
    const { data, stamps } = run([
      { kind: "turn-opened", turn: "T1", at },
      { kind: "quiet", at: quietAt },
    ], L, emptySession(CLAUDE));
    expect(state(data, quietAt)).toBe("running");
    expect(stamps).toBe(0);
  });

  it("the floor still ends it after the hook patience runs out, and stamps", () => {
    const quietAt = at + L.leaseMs + L.hookQuietMs + 1;
    const { data, stamps } = run([
      { kind: "turn-opened", turn: "T1", at },
      { kind: "quiet", at: quietAt },
    ], L, emptySession(CLAUDE));
    expect(state(data, quietAt)).toBe("idle");
    expect(stamps).toBe(1);
  });
});

describe("review round: full-lane turn boundaries", () => {
  const CLAUDE = { opens: true, ends: true };

  it("an interrupted permission request does not strand later turns", () => {
    const { data, stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "permission-requested", turn: "A", key: "k", at },
      // Interrupted: claude sends no Stop(A).
      { kind: "turn-opened", turn: "B", at: at + 1_000 },
      { kind: "turn-ended", turn: "B", at: at + 2_000 },
    ], L, emptySession(CLAUDE));
    expect(state(data, at + 2_000)).toBe("idle");
    expect(stamps).toBe(1);
  });

  it("a quiet turn the floor closed still stamps on its real Stop", () => {
    const quietAt = at + L.leaseMs + L.hookQuietMs + 1;
    const { data, stamps } = run([
      { kind: "turn-opened", turn: "A", at },
      { kind: "quiet", at: quietAt },
      { kind: "turn-ended", turn: "A", at: quietAt + 5_000 },
    ], L, emptySession(CLAUDE));
    expect(state(data, quietAt + 5_000)).toBe("idle");
    expect(stamps).toBe(2);
  });

  it("a Stop for a turn this daemon never saw open stamps, once", () => {
    const { data, stamps } = run([
      { kind: "turn-ended", turn: "A", at },
      { kind: "turn-ended", turn: "A", at: at + 10 },
    ], L, { ...emptySession(CLAUDE), restoredBlock: true });
    expect(state(data, at + 10)).toBe("idle");
    expect(stamps).toBe(1);
  });
});

describe("a block inherited from a previous daemon", () => {
  const restored = () => ({ ...emptySession({ opens: true, ends: true }), restoredBlock: true });

  it("reads blocked and survives the floor", () => {
    const { data } = run([{ kind: "quiet", at: at + 60_000 }], L, restored());
    expect(state(data, at + 60_000)).toBe("blocked");
  });

  it("is retired by the next authoritative turn boundary", () => {
    expect(state(run([{ kind: "turn-opened", turn: "T9", at }], L, restored()).data)).toBe("running");
    expect(state(run([{ kind: "turn-ended", turn: "T9", at }], L, restored()).data)).toBe("idle");
  });

  it("is retired by exit", () => {
    expect(state(run([{ kind: "gone", at }], L, restored()).data)).toBe("idle");
  });
});
