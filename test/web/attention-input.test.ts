// Adapted from src/main/cubed/attention/input.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { expect, test } from "vitest";
import { AttentionInputParser } from "../../src/server/attention/input";

test("model commands and picker confirmations are not prompts", () => {
  for (const command of ["/model", "/models", "/model gpt-5", " /model"]) {
    const parser = new AttentionInputParser();
    const feed = (text: string) => parser.feed(new TextEncoder().encode(text));
    for (const chunk of [command.slice(0, 3), command.slice(3), "\r", "\u001b[B", "\r", "\u001b[A", "\r"]) {
      expect(feed(chunk)).toBe(false);
    }
    expect(feed("hello\r")).toBe(true);
  }
});

test("work-producing slash commands still count as prompts", () => {
  const parser = new AttentionInputParser();
  expect(parser.feed(new TextEncoder().encode("/review\r"))).toBe(true);
});

test("split terminal replies never become submitted text", () => {
  const parser = new AttentionInputParser();
  for (const chunk of ["\u001b[", "1;2R", "\u001b]11;rgb:", "ffff/ffff/ffff\u001b", "\\", "\r"]) {
    expect(parser.feed(new TextEncoder().encode(chunk))).toBe(false);
  }
});

test("multiline bracketed paste is a draft until Enter after the paste", () => {
  const parser = new AttentionInputParser();
  for (const chunk of ["\u001b[200~", "first\nsecond\r\n", "\u001b[201~"]) {
    expect(parser.feed(new TextEncoder().encode(chunk))).toBe(false);
  }
  expect(parser.feed(new TextEncoder().encode("\r"))).toBe(true);
});

test("cleared drafts and empty confirmations do not submit a prompt", () => {
  const parser = new AttentionInputParser();
  for (const text of ["\r", "cancel\u0003\r", "clear\u0015\r", "x\u007f\r"]) {
    expect(parser.feed(new TextEncoder().encode(text))).toBe(false);
  }
  expect(parser.feed(new TextEncoder().encode("hello\r"))).toBe(true);
});

test("history recall followed by Enter submits without retyping the prompt", () => {
  for (const up of ["\u001b[A", "\u001bOA"]) {
    const parser = new AttentionInputParser();
    expect(parser.feed(new TextEncoder().encode(up))).toBe(false);
    expect(parser.feed(new TextEncoder().encode("\r"))).toBe(true);
  }
});

test("interrupt keys exclude protocol messages and pasted escapes", () => {
  const parser = new AttentionInputParser();
  const bytes = (text: string) => new TextEncoder().encode(text);
  expect(parser.takeInterrupt(bytes("\u001b[1;2R"))).toBe(false);
  expect(parser.takeInterrupt(bytes("\u001b"))).toBe(true);
  expect(parser.takeInterrupt(bytes("\u0003"))).toBe(true);
  parser.feed(bytes("\u001b[200~"));
  expect(parser.takeInterrupt(bytes("\u001b"))).toBe(false);
  expect(parser.takeInterrupt(bytes("\u0003"))).toBe(false);
});
