import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexRootResolver } from "./codex-thread-root";
import { readCodexThread } from "./codex-locks";

const root = "01a08b5d-7de5-78e2-8cdc-cb1283982a40";
const child = "01a08ccc-c321-7350-9a4f-660f7406dd97";
const grandchild = "01a08ccc-c321-7350-9a4f-660f7406dd98";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true}); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codex-root-")); dirs.push(home);
  const dir = join(home, "sessions", "2026", "09", "10"); mkdirSync(dir, {recursive:true});
  const file = (id: string) => join(dir, `rollout-date-${id}.jsonl`);
  const meta = (id: string, fields: Record<string, unknown>) => writeFileSync(file(id), JSON.stringify({type:"session_meta",payload:{id,...fields}}) + "\n");
  return {home,file,meta};
}
test("follows nested ancestry and distinguishes forks from child agents", () => {
  const f = fixture();
  f.meta(root, {source:"cli", forked_from_id:grandchild});
  f.meta(child, {source:{subagent:{thread_spawn:{parent_thread_id:root}}},parent_thread_id:root});
  f.meta(grandchild, {source:{subagent:{thread_spawn:{parent_thread_id:child}}}});
  expect(createCodexRootResolver()(grandchild,f.home)).toBe(root);
});
test.each(["conflict", "cycle", "missing", "unknown", "malformed", "oversized"])("does not guess with %s metadata", kind => {
  const f = fixture();
  f.meta(root, {source:"cli"});
  f.meta(child, {source:{subagent:{thread_spawn:{parent_thread_id:root}}},parent_thread_id:kind==="conflict"?grandchild:root});
  if (kind === "cycle") f.meta(root, {source:{subagent:{thread_spawn:{parent_thread_id:child}}}});
  if (kind === "missing") rmSync(f.file(root));
  if (kind === "unknown") f.meta(child, {source:{subagent:"unrecognized"}});
  if (kind === "malformed") writeFileSync(f.file(child), "not json\n");
  if (kind === "oversized") writeFileSync(f.file(child), " ".repeat(256*1024)+"\n");
  expect(createCodexRootResolver()(child,f.home)).toBeNull();
});
test("discovery requires one unambiguous held root, independent of fd order", () => {
  const f = fixture(); f.meta(root,{source:"cli"});
  f.meta(child,{source:{subagent:{thread_spawn:{parent_thread_id:root}}}});
  f.meta(grandchild,{source:"cli"});
  const resolve = createCodexRootResolver();
  const read = (ids: string[]) => readCodexThread(1, {
    listFds:()=>ids, readFd:(_pid,id)=>`${f.home}/thread-writer-locks/${id}.lock`, rootThread:resolve,
  });
  expect(read([child,root])).toBe(root);
  expect(read([root,child])).toBe(root);
  expect(read([child])).toBeNull();
  expect(read([root,grandchild])).toBeNull();
});
test("a missing transcript can become readable on a later scan", () => {
  const f = fixture(); let now=0; const resolve=createCodexRootResolver(()=>now);
  expect(resolve(root,f.home)).toBeNull(); f.meta(root,{source:"cli"});
  now=15001; expect(resolve(root,f.home)).toBe(root);
});
