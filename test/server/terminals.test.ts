import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startServer } from '../../src/server/http.js';
import { Registry } from '../../src/server/registry.js';
import { ensureWorker } from '../../src/server/worker-runtime.js';
import { Terminals } from '../../src/server/terminals.js';

test('two browser clients share one durable terminal and reconnect after the HTTP server restarts', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'builder-service-'));
  let app = await startServer({ port: 0, stateDir });
  const sockets: WebSocket[] = [];
  let base = `http://127.0.0.1:${app.port}`;
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(`${base}/api`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'test', method, params }) });
    const reply = await response.json() as any;
    assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.result;
  };
  try {
    const initial = await call('snapshot'); assert.equal(initial.items.length, 0);
    for (let i = 0; i < 2; i++) {
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}/events`, { origin: base });
      sockets.push(socket); await once(socket, 'open');
    }
    const params = { requestId: 'lost-reply', cwd: stateDir, command: '/bin/sh', args: ['-c', 'read value; printf "VALUE:%s" "$value"; read rest'], cols: 80, rows: 24 };
    const [a, b] = await Promise.all([call('terminals.create', params), call('terminals.create', params)]);
    assert.equal(a.id, b.id);
    assert.equal((await call('snapshot')).items.length, 1);
    const frame = new Promise<any>(resolve => sockets[1]!.on('message', bytes => { const event = JSON.parse(bytes.toString()); if (event.type === 'terminal' && event.event.type === 'data') resolve(event); }));
    sockets[0]!.close();
    await call('terminals.write', { id: a.id, bytes: Buffer.from('one\n').toString('base64') });
    assert.equal((await frame).event.id, a.id);
    const first = await call('terminals.read', { id: a.id, since: 0 });
    assert.ok(first.seq > 0);
    await app.close();
    app = await startServer({ port: 0, stateDir }); base = `http://127.0.0.1:${app.port}`;
    const next = await call('snapshot'); assert.equal(next.items.length, 1);
    assert.equal(next.items[0].sessionId, a.sessionId);
    assert.equal(next.items[0].exited, false);
    const replay = await call('terminals.read', { id: a.id, since: 0 });
    assert.match(Buffer.from(replay.data, 'base64').toString(), /VALUE:one/);
    await call('terminals.stopAll');
  } finally { for (const ws of sockets) ws.terminate(); await app.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('persisted sessions missing after a reboot are shown as ended without relaunching commands', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'builder-reboot-'));
  const registry = await Registry.open(stateDir);
  const worker = await ensureWorker(stateDir);
  const terminals = new Terminals(registry, worker);
  try {
    await registry.mutate(null, draft => { draft.items.push({ id: 'gone', type: 'term', repoId: null, cwd: stateDir, title: 'Old shell', createdAt: '', updatedAt: '', sessionId: 'before-reboot', requestId: 'old-launch', command: '/bin/sh', args: [], exited: false, exitCode: null }); });
    await terminals.reconcile();
    const row = registry.snapshot().items[0]!;
    assert.equal(row.type === 'term' && row.exited, true);
    assert.equal((await worker.list()).length, 0);
    await terminals.close('gone');
    assert.equal(registry.snapshot().items.length, 0);
  } finally { terminals.dispose(); worker.disconnect(); await rm(stateDir, { recursive: true, force: true }); }
});

test('reconciliation recovers a PTY created just before registry persistence crashed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'builder-orphan-'));
  const registry = await Registry.open(stateDir);
  const worker = await ensureWorker(stateDir);
  const terminals = new Terminals(registry, worker);
  try {
    const session = await worker.spawn({ requestId: 'crashed-create', cwd: stateDir, command: '/bin/sh', args: [], cols: 80, rows: 24 });
    await terminals.reconcile();
    const row = registry.snapshot().items[0];
    assert.equal(row?.type === 'term' && row.sessionId, session.id);
    assert.equal((await terminals.create({ requestId: 'crashed-create', cwd: stateDir })).id, row?.id);
    assert.equal((await worker.list()).length, 1);
    await terminals.close(row!.id);
  } finally { await worker.stopAll(); terminals.dispose(); worker.disconnect(); await rm(stateDir, { recursive: true, force: true }); }
});

test('restarting an ended terminal preserves its catalog identity and never adopts its predecessor again', async () => {
 const stateDir=await mkdtemp(join(tmpdir(),'builder-restart-item-'));
 const registry=await Registry.open(stateDir),worker=await ensureWorker(stateDir),terminals=new Terminals(registry,worker);
 try {
  const first=await terminals.create({requestId:'initial',cwd:stateDir,command:'/bin/sh',args:['-c','exit 0']});
  const deadline=Date.now()+3000;
  while(!(registry.snapshot().items[0] as any)?.exited&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  const second=await terminals.create({requestId:'restart',catalogItemId:first.id,cwd:stateDir,command:'/bin/sh',args:[]});
  assert.equal(second.id,first.id);assert.notEqual(second.sessionId,first.sessionId);
  await terminals.reconcile();
  assert.equal(registry.snapshot().items.length,1);
  assert.equal((registry.snapshot().items[0] as any).sessionId,second.sessionId);
  const repeated=await terminals.create({requestId:'other-client',catalogItemId:first.id,cwd:stateDir,command:'/bin/sh'});
  assert.equal(repeated.sessionId,second.sessionId);
  assert.equal((await worker.list()).filter(s=>!s.exited).length,1);
 } finally {await worker.stopAll();terminals.dispose();await registry.flush();worker.disconnect();await rm(stateDir,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
});

test('crash recovery of a replacement preserves the item order, title and creation time', async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'builder-replacement-'));
 const registry=await Registry.open(stateDir),worker=await ensureWorker(stateDir),terminals=new Terminals(registry,worker);
 try {
  const first=await terminals.create({requestId:'old',cwd:stateDir,command:'/bin/sh',args:['-c','exit 0']});
  await terminals.create({requestId:'neighbor',cwd:stateDir,command:'/bin/sh'});
  await registry.mutate(null,d=>{d.items[0]!.userTitle='Keep my title'});
  const replacement=await worker.spawn({requestId:'replacement',cwd:stateDir,command:'/bin/sh',args:[],cols:80,rows:24,recovery:{catalogItemId:first.id,supersededSessionIds:[first.sessionId],repoId:null,launchId:"recovered",attentionHooks:false,args:[]}});
  await terminals.reconcile();
  const row=registry.snapshot().items[0]!;
  assert.equal(row.id,first.id);assert.equal(row.createdAt,first.createdAt);assert.equal(row.userTitle,'Keep my title');
  assert.equal(row.type==='term'&&row.sessionId,replacement.id);
  await terminals.reconcile();assert.equal(registry.snapshot().items.length,2);
 } finally {await worker.stopAll();terminals.dispose();await registry.flush();worker.disconnect();await rm(stateDir,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
});

test('an exit queued behind a replacement cannot mark the new terminal exited',async()=>{
 const {EventEmitter}=await import('node:events');
 const dir=await mkdtemp(join(tmpdir(),'builder-exit-race-'));
 const registry=await Registry.open(dir);
 const worker=Object.assign(new EventEmitter(),{list:async()=>[]});
 await registry.mutate(null,d=>{d.items.push({id:'tile',type:'term',repoId:null,cwd:dir,title:'Shell',createdAt:'',updatedAt:'',sessionId:'old',requestId:'original',command:'/bin/sh',args:[],exited:false,exitCode:null});});
 const terminals=new Terminals(registry,worker as unknown as import('../../src/server/worker-client.js').WorkerClient);
 try {
  const replacement=registry.mutate(null,d=>{const row=d.items[0]!;if(row.type==='term')row.sessionId='replacement';});
  worker.emit('event',{type:'exit',id:'old',exitCode:7});
  await replacement;await registry.flush();
  const row=registry.snapshot().items[0]!;
  assert.equal(row.type==='term'&&row.sessionId,'replacement');
  assert.equal(row.type==='term'&&row.exited,false);
 } finally {terminals.dispose();await registry.flush();await rm(dir,{recursive:true,force:true});}
});
