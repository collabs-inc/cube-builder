import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgents, resolveCommand } from '../../src/server/agents.js';
test('agent discovery uses installed executables and rejects a missing command before creating a terminal', async () => {
  const path = await mkdtemp(join(tmpdir(), 'builder agents '));
  try { await writeFile(join(path, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal(await resolveCommand('codex', path), join(path, 'codex'));
    const agents = await listAgents(path); assert.equal(agents.find(a => a.id === 'codex')?.available, true); assert.equal(agents.find(a => a.id === 'claude')?.available, false);
    await assert.rejects(resolveCommand('missing', path), /not installed/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test('agent in a spaced directory reports attention, exits, and starts only on explicit resume', async () => {
  const { Registry } = await import('../../src/server/registry.js');
  const { ensureWorker } = await import('../../src/server/worker-runtime.js');
  const { Terminals } = await import('../../src/server/terminals.js');
  const path = await mkdtemp(join(tmpdir(), 'builder agent fixture '));
  const script = join(path, 'claude');
  await writeFile(script, `#!${process.execPath}\nimport {execFileSync} from 'node:child_process';\nconst settings = JSON.parse(process.argv[3]);\nconst hook = settings.hooks.UserPromptSubmit[0].hooks[0].command;\nconst resumed = process.argv.includes('--resume');\nexecFileSync(process.env.BROWSER,['https://example.invalid/login']);\nprocess.stdout.write(resumed ? 'RESUMED\\n' : 'STARTED\\n');\nconst send = hook_event_name => execFileSync('/bin/sh',['-c',hook],{input:JSON.stringify({hook_event_name,prompt_id:'fixture-turn'})});\nsend('UserPromptSubmit');\nsetTimeout(()=>send('PermissionRequest'),200);\nprocess.stdin.once('data',()=>{send('Stop');setTimeout(()=>process.exit(0),100);});\n`, { mode: 0o700 });
  const registry = await Registry.open(join(path, 'state')); const worker = await ensureWorker(join(path, 'state')); const terminals = new Terminals(registry, worker);
  const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('Fixture condition not reached'); };
  try {
    const first = await terminals.create({ requestId: 'first', cwd: path, command: script, harness: 'claude' });
    await until(() => registry.snapshot().items.some(i => i.type === 'term' && i.attention === 'waiting'));
    assert.match(Buffer.from((await terminals.read({ id: first.id, since: 0 })).data, 'base64').toString(), /5522;https:\/\/example.invalid\/login/);
    await terminals.write({ id: first.id, bytes: Buffer.from('continue\n').toString('base64') });
    await until(() => registry.snapshot().items.some(i => i.id === first.id && i.type === 'term' && i.exited));
    assert.equal((await worker.list()).length, 1);
    const resumed = await terminals.create({ requestId: 'resume', cwd: path, command: script, harness: 'claude', args: ['--resume'] });
    await until(async () => Buffer.from((await terminals.read({ id: resumed.id, since: 0 })).data, 'base64').includes('RESUMED'));
    assert.notEqual(first.id, resumed.id);
    await assert.rejects(terminals.create({ requestId: 'missing', cwd: path, command: join(path, 'missing') }), /not installed/);
    assert.equal(registry.snapshot().items.length, 2);
  } finally { await terminals.stopAll(); terminals.dispose(); worker.disconnect(); await registry.flush(); await rm(path, { recursive: true, force: true }); }
});


test('agent resolution skips generated host wrappers but preserves user wrappers and explicit commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'builder-wrapper-'));
  const host = join(root, 'host'), user = join(root, 'user'), vendor = join(root, 'vendor');
  try {
    await Promise.all([host,user,vendor].map(dir=>mkdir(dir)));
    await writeFile(join(host,'codex'), '#!/bin/sh\n# Written by cubed (shell-wrappers.ts): a hand-typed codex in a cloud\nexec codex --dangerously-bypass-approvals-and-sandbox "$@"\n', {mode:0o700});
    await writeFile(join(user,'codex'), '#!/bin/sh\n# Custom user launcher\nexit 0\n', {mode:0o700});
    await writeFile(join(vendor,'codex'), '#!/bin/sh\nexit 0\n', {mode:0o700});
    assert.equal(await resolveCommand('codex', `${host}:${vendor}`), join(vendor,'codex'));
    assert.equal(await resolveCommand('codex', `${host}:${user}:${vendor}`), join(user,'codex'));
    assert.equal(await resolveCommand(join(host,'codex'), `${host}:${vendor}`), join(host,'codex'));
    assert.equal((await listAgents(`${host}:${vendor}`)).find(a=>a.id==='codex')?.command, join(vendor,'codex'));
    await assert.rejects(resolveCommand('codex',host), /not installed/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
