import { describe, expect, test } from "vitest";
import { createCodexThreadReader, readCodexThread } from "./codex-locks";

const UUID = "01a00de0-a2e0-78e3-9a36-2f366b4eb743";
const LOCK = `/home/node/.codex/thread-writer-locks/${UUID}.lock`;

/** A fake /proc/<pid>/fd: fd name -> link target. */
function fds(table: Record<string, string>) {
  return {
    rootThread: (id: string) => id,
    listFds: () => Object.keys(table),
    readFd: (_pid: number, fd: string) => table[fd] ?? null,
  };
}

describe("readCodexThread", () => {
  test("chooses the held parent thread even when a child lock comes first", () => {
    const child = "01a08ccc-c321-7350-9a4f-660f7406dd97";
    expect(readCodexThread(42, {
      ...fds({ "1": `/home/node/.codex/thread-writer-locks/${child}.lock`, "2": LOCK }),
      rootThread: () => UUID,
    })).toBe(UUID);
  });

  test("returns the uuid of the thread lock the process holds", () => {
    expect(readCodexThread(42, fds({
      "14": "/home/node/.codex/state_5.sqlite",
      "41": LOCK,
    }))).toBe(UUID);
  });

  test("ignores the coordination lock, which is not a thread", () => {
    expect(readCodexThread(42, fds({
      "3": "/home/node/.codex/thread-writer-locks/.coordination.lock",
    }))).toBeNull();
  });

  test("ignores a lock file whose name is not a uuid", () => {
    expect(readCodexThread(42, fds({
      "3": "/home/node/.codex/thread-writer-locks/not-a-uuid.lock",
    }))).toBeNull();
  });

  test("returns null when the process holds no codex lock", () => {
    expect(readCodexThread(42, fds({ "1": "/dev/pts/3" }))).toBeNull();
  });

  test("returns null when the fd table cannot be listed", () => {
    expect(readCodexThread(42, {
      listFds: () => { throw new Error("ESRCH"); },
    })).toBeNull();
  });

  test("skips an fd that vanishes mid-scan and keeps looking", () => {
    expect(readCodexThread(42, {
      listFds: () => ["7", "41"],
      readFd: (_pid, fd) => {
        if (fd === "7") throw new Error("ENOENT");
        return LOCK;
      },
      rootThread: (id) => id,
    })).toBe(UUID);
  });
});

describe("createCodexThreadReader", () => {
  test("reads fresh on every call — the thread id changes over a session's life", () => {
    const first = "01a00de0-a2e0-78e3-9a36-2f366b4eb743";
    const second = "01a00de2-7cc3-7193-875e-7a9a1f468732";
    let call = 0;
    const read = createCodexThreadReader({
      listFds: () => ["41"],
      readFd: () => `/home/node/.codex/thread-writer-locks/${call++ === 0 ? first : second}.lock`,
      minIntervalMs: 0,
      rootThread: (id) => id,
    });
    expect(read(42)).toBe(first);
    expect(read(42)).toBe(second);
  });
});

describe("createCodexThreadReader throttling", () => {
  test("re-reads immediately when no interval is set", () => {
    let calls = 0;
    const read = createCodexThreadReader({
      listFds: () => { calls++; return []; },
      minIntervalMs: 0,
    });
    read(42);
    read(42);
    expect(calls).toBe(2);
  });

  test("serves the last answer for the same pid inside the interval", () => {
    let calls = 0;
    let clock = 1_000;
    const read = createCodexThreadReader({
      listFds: () => { calls++; return ["41"]; },
      readFd: () => LOCK,
      rootThread: (id) => id,
      minIntervalMs: 15_000,
      now: () => clock,
    });
    expect(read(42)).toBe(UUID);
    expect(read(42)).toBe(UUID);
    expect(calls).toBe(1);

    clock += 15_001;
    expect(read(42)).toBe(UUID);
    expect(calls).toBe(2);
  });

  test("throttles per pid, not globally", () => {
    let calls = 0;
    const read = createCodexThreadReader({
      listFds: () => { calls++; return []; },
      minIntervalMs: 15_000,
      now: () => 1_000,
    });
    read(1);
    read(2);
    read(3);
    expect(calls).toBe(3);
  });
});
