// Adapted from src/main/cubed/attention/bell.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, it } from "vitest";
import { BellParser } from "../../src/server/attention/bell";

const enc = new TextEncoder();
const feed = (p: BellParser, s: string) => p.feed(enc.encode(s));

describe("BellParser", () => {
  it("counts a bare BEL in the ground state", () => {
    expect(feed(new BellParser(), "hello\x07world")).toBe(1);
  });

  it("does NOT count a BEL terminating an OSC", () => {
    expect(feed(new BellParser(), "\x1b]7;file://host/tmp\x07")).toBe(0);
  });

  it("does NOT count a BEL terminating the browser shim's OSC 5522", () => {
    expect(feed(new BellParser(), "\x1b]5522;https://example.com\x07")).toBe(0);
  });

  it("does not count a BEL inside an OSC split across chunks", () => {
    const p = new BellParser();
    expect(feed(p, "\x1b]7;file://ho")).toBe(0);
    expect(feed(p, "st/tmp\x07")).toBe(0);
  });

  it("counts a BEL after an OSC has terminated", () => {
    expect(feed(new BellParser(), "\x1b]7;x\x07\x07")).toBe(1);
  });

  it("handles OSC terminated by ST rather than BEL", () => {
    expect(feed(new BellParser(), "\x1b]0;title\x1b\\\x07")).toBe(1);
  });

  it("ignores CSI and counts the ground BEL after it", () => {
    expect(feed(new BellParser(), "\x1b[1;31mred\x1b[0m\x07")).toBe(1);
  });

  it("does not count a BEL inside a DCS string", () => {
    expect(feed(new BellParser(), "\x1bPsomething\x07more\x1b\\")).toBe(0);
  });

  it("does not count a BEL inside an OSC that contains a newline", () => {
    // The daemon's own OSC 7 interpolates $PWD without stripping newlines,
    // so a newline is NOT proof of ground state.
    expect(feed(new BellParser(), "\x1b]7;file://h/we\nird\x07")).toBe(0);
  });

  it("CAN cancels a sequence and restores ground", () => {
    expect(feed(new BellParser(), "\x1b]7;trunc\x18\x07")).toBe(1);
  });

  it("bounds a malformed overlong OSC without counting its terminator", () => {
    // Returning to ground at the cap would promote the overlong string's own
    // terminating BEL into a bell. It goes unsynced instead.
    const p = new BellParser();
    expect(feed(p, "\x1b]" + "a".repeat(9000))).toBe(0);
    expect(feed(p, "\x07")).toBe(0);
    expect(feed(p, "\x1b[0m\x07")).toBe(1);
  });

  it("does not count a BEL when ESC restarts a sequence from esc state", () => {
    // ESC abandons whatever was in progress. Falling through to ground here
    // left the following OSC unparsed and its terminator read as a bell.
    expect(feed(new BellParser(), "\x1b\x1b]0;title\x07")).toBe(0);
  });

  it("does not count a BEL when ESC interrupts a CSI", () => {
    // `]` sits inside the CSI final-byte range, so treating ESC as an
    // ordinary parameter byte ended the CSI on the OSC's own introducer.
    expect(feed(new BellParser(), "\x1b[1;\x1b]0;title\x07")).toBe(0);
  });

  it("ESC restarting a sequence is safe after resync too", () => {
    const p = new BellParser();
    p.resync();
    expect(feed(p, "\x1b\x1b]0;title\x07")).toBe(0);
  });

  it("after resync, counts nothing until a sequence boundary proves ground", () => {
    const p = new BellParser();
    p.resync();
    // A truncated OSC whose opening bytes were never seen: its terminator
    // must not be read as a bell, and neither must a newline inside it.
    expect(feed(p, "file://host/we\nird\x07")).toBe(0);
    // An ESC always begins a fresh sequence; following it to its end proves
    // we are back in ground.
    expect(feed(p, "\x1b[0m\x07")).toBe(1);
  });

  it("after resync, CAN alone restores ground", () => {
    const p = new BellParser();
    p.resync();
    expect(feed(p, "junk\x18\x07")).toBe(1);
  });
});
