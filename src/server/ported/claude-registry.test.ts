import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSessionReader, readClaudeSession } from "./claude-registry";

const PROC_START = "Fri Aug 14 20:22:10 2026";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Renders an instant the way `ps -o lstart=` and Claude's registry do. */
function ctime(at: Date, utc: boolean): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const [day, month, date, hours, minutes, seconds, year] = utc
    ? [at.getUTCDay(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(),
       at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCFullYear()]
    : [at.getDay(), at.getMonth(), at.getDate(), at.getHours(),
       at.getMinutes(), at.getSeconds(), at.getFullYear()];
  return (
    `${DAYS[day]} ${MONTHS[month]} ${String(date).padStart(2, " ")} ` +
    `${pad(hours)}:${pad(minutes)}:${pad(seconds)} ${year}`
  );
}

function home(entry?: Record<string, unknown>, pid = 4242): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-registry-"));
  mkdirSync(join(dir, ".claude", "sessions"), { recursive: true });
  if (entry) {
    writeFileSync(join(dir, ".claude", "sessions", `${pid}.json`), JSON.stringify(entry));
  }
  return dir;
}

describe("readClaudeSession", () => {
  it("reads the conversation id of a live session", () => {
    const dir = home({
      pid: 4242,
      sessionId: "uuid-1",
      cwd: "/repo",
      procStart: PROC_START,
    });
    expect(
      readClaudeSession(4242, { home: dir, procStartOf: () => PROC_START }),
    ).toBe("uuid-1");
  });

  // The bug that made discovery a no-op for its entire first life: Claude
  // records the start time in UTC, `ps -o lstart=` prints it in local time,
  // and the two were compared as strings. Same process, same instant, seven
  // hours apart on paper — so every lookup returned null and nothing ever
  // said so. Both stamps here are derived from one instant, so this holds
  // in any timezone, including UTC.
  it("matches a UTC registry stamp against ps's local rendering of it", () => {
    const at = new Date("2026-08-15T18:23:10.000Z");
    const dir = home({ sessionId: "uuid-1", procStart: ctime(at, true) });
    expect(
      readClaudeSession(4242, { home: dir, procStartOf: () => ctime(at, false) }),
    ).toBe("uuid-1");
  });

  it("still matches when a platform records the start time in local time", () => {
    const at = new Date("2026-08-15T18:23:10.000Z");
    const dir = home({ sessionId: "uuid-1", procStart: ctime(at, false) });
    expect(
      readClaudeSession(4242, { home: dir, procStartOf: () => ctime(at, false) }),
    ).toBe("uuid-1");
  });

  it("tolerates the trailing padding ps emits", () => {
    const dir = home({ sessionId: "uuid-1", procStart: PROC_START });
    expect(
      readClaudeSession(4242, { home: dir, procStartOf: () => `${PROC_START}    ` }),
    ).toBe("uuid-1");
  });

  it("tolerates surrounding whitespace in the recorded start time", () => {
    const dir = home({ sessionId: "uuid-1", procStart: `${PROC_START} ` });
    expect(
      readClaudeSession(4242, { home: dir, procStartOf: () => PROC_START }),
    ).toBe("uuid-1");
  });

  // Pids are reused. Handing back a recycled pid's stale entry would have
  // the caller durably record it and later resume a tile into somebody
  // else's conversation, so anything short of a confirmed match is "no".
  it("refuses an entry whose process start time does not match", () => {
    const dir = home({ sessionId: "uuid-1", procStart: PROC_START });
    expect(
      readClaudeSession(4242, {
        home: dir,
        procStartOf: () => "Sat Aug 15 09:00:00 2026",
      }),
    ).toBeNull();
  });

  it("refuses when the process start time cannot be read at all", () => {
    const dir = home({ sessionId: "uuid-1", procStart: PROC_START });
    expect(readClaudeSession(4242, { home: dir, procStartOf: () => null })).toBeNull();
  });

  it("refuses an entry with no start time to check against", () => {
    const dir = home({ sessionId: "uuid-1" });
    expect(
      readClaudeSession(4242, { home: dir, procStartOf: () => PROC_START }),
    ).toBeNull();
  });

  it("returns null for a pid with no entry, and for a corrupt one", () => {
    const empty = home();
    expect(
      readClaudeSession(4242, { home: empty, procStartOf: () => PROC_START }),
    ).toBeNull();

    const corrupt = mkdtempSync(join(tmpdir(), "claude-registry-"));
    mkdirSync(join(corrupt, ".claude", "sessions"), { recursive: true });
    writeFileSync(join(corrupt, ".claude", "sessions", "4242.json"), "{ not json");
    expect(
      readClaudeSession(4242, { home: corrupt, procStartOf: () => PROC_START }),
    ).toBeNull();
  });

  it("returns null when the entry names no session", () => {
    const dir = home({ procStart: PROC_START, sessionId: "" });
    expect(
      readClaudeSession(4242, { home: dir, procStartOf: () => PROC_START }),
    ).toBeNull();
  });
});

// Linux records the kernel's start-ticks rather than a ctime string. Both
// sides are the same integer there, and treating it as a date — which
// Date.parse will happily do, reading "76074" as a year — is what made
// discovery silently useless on every cloud machine.
describe("readClaudeSession on Linux-shaped stamps", () => {
  it("matches identical start-ticks", () => {
    const dir = home({ sessionId: "uuid-1", procStart: "76074" });
    expect(readClaudeSession(4242, { home: dir, procStartOf: () => "76074" })).toBe("uuid-1");
  });

  // A tick count long enough that Date.parse gives up on it — which is
  // every process on a machine up more than about twenty minutes, at 100
  // ticks a second. Treating these as dates reads them as NaN and refuses
  // a session that is plainly itself.
  it("matches start-ticks too large to look like a year", () => {
    const dir = home({ sessionId: "uuid-1", procStart: "760740" });
    expect(readClaudeSession(4242, { home: dir, procStartOf: () => "760740" })).toBe("uuid-1");
  });

  it("refuses different start-ticks for the same pid", () => {
    const dir = home({ sessionId: "uuid-1", procStart: "76074" });
    expect(readClaudeSession(4242, { home: dir, procStartOf: () => "99999" })).toBeNull();
  });

  // Mixing the two forms means one side is lying about what it read, and
  // any "match" would be a coincidence of parsing, not of identity.
  it("refuses a tick count against a date, and the reverse", () => {
    const ticks = home({ sessionId: "uuid-1", procStart: "76074" });
    expect(readClaudeSession(4242, { home: ticks, procStartOf: () => PROC_START })).toBeNull();

    const date = home({ sessionId: "uuid-1", procStart: PROC_START });
    expect(readClaudeSession(4242, { home: date, procStartOf: () => "76074" })).toBeNull();
  });
});

describe("createClaudeSessionReader", () => {
  it("confirms a pid once and then follows its conversation for free", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-registry-"));
    mkdirSync(join(dir, ".claude", "sessions"), { recursive: true });
    const write = (sessionId: string): void => {
      writeFileSync(
        join(dir, ".claude", "sessions", "4242.json"),
        JSON.stringify({ sessionId, procStart: PROC_START }),
      );
    };

    let checks = 0;
    const read = createClaudeSessionReader({
      home: dir,
      procStartOf: () => {
        checks += 1;
        return PROC_START;
      },
    });

    write("conv-1");
    expect(read(4242)).toBe("conv-1");
    // The conversation moved (the user ran /resume) — the id must follow…
    write("conv-2");
    expect(read(4242)).toBe("conv-2");
    expect(read(4242)).toBe("conv-2");
    // …without paying for the identity check again: a process's start time
    // cannot change, and this runs on a timer for every live session.
    expect(checks).toBe(1);
  });

  it("re-confirms when a recycled pid reports a different start time", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-registry-"));
    mkdirSync(join(dir, ".claude", "sessions"), { recursive: true });
    const write = (sessionId: string, procStart: string): void => {
      writeFileSync(
        join(dir, ".claude", "sessions", "4242.json"),
        JSON.stringify({ sessionId, procStart }),
      );
    };

    let actual = PROC_START;
    const read = createClaudeSessionReader({ home: dir, procStartOf: () => actual });

    write("conv-1", PROC_START);
    expect(read(4242)).toBe("conv-1");

    // Same pid, different process: the memo must not vouch for it.
    const later = "Sat Aug 15 09:00:00 2026";
    write("someone-elses-conv", later);
    actual = PROC_START; // the running process is still the original one
    expect(read(4242)).toBeNull();
  });
});
