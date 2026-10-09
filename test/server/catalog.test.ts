import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/server/registry.js';
import { Catalog } from '../../src/server/catalog.js';
import { projectCatalog } from '../../src/shared/catalog.js';

test('original catalog projects worktree ownership, terminal identity and attention without client state', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'builder-catalog-'));
 try {
  const registry = await Registry.open(dir);
  await registry.mutate(null, d => {
   d.repos.push({ id:'repo', root:'/repos/r', name:'r', worktrees:[{ id:'main',root:'/repos/r',name:'r',branch:'main',main:true },{ id:'wt',root:'/repos/w',name:'w',branch:'feature',main:false }] });
   d.items.push({ id:'term',type:'term',repoId:'repo',cwd:'/repos/w/subdir',title:'claude',createdAt:'2026-01-01',updatedAt:'2026-01-02',sessionId:'pty',requestId:'req',command:'claude',args:[],harness:'claude',exited:false,exitCode:null,attention:'waiting' });
  });
  const doc = projectCatalog(registry.snapshot());
  assert.equal(doc.epoch, registry.snapshot().epoch);
  assert.equal(doc.rev, registry.snapshot().revision);
  assert.equal(doc.repos.find(r=>r.id==='wt')?.worktreeOf?.repoId,'repo');
  assert.equal(doc.items[0]?.repoId,'wt');
  assert.equal(doc.items[0]?.ptySessionId,'pty');
  assert.equal(doc.items[0]?.agentActivity,'blocked');
  assert.equal(doc.items[0]?.target,'claude');
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test('catalog titles and original scoped reordering survive backend restart; stale permutations refuse atomically', async () => {
 const dir=await mkdtemp(join(tmpdir(),'builder-catalog-'));
 try {
  let registry=await Registry.open(dir);
  await registry.mutate(null,d=> {
   for (const id of ['a','b','c']) d.items.push({id,type:'file',repoId:null,cwd:'/tmp',title:id,createdAt:'2026-01-01',updatedAt:'2026-01-01',filePath:`/tmp/${id}.md`});
  });
  const catalog=new Catalog(registry);
  await catalog.update('a',{userTitle:'My note'});
  assert.deepEqual(await catalog.reorder({kind:'items',repoId:null},['c','a','b']),{ok:true});
  const rev=registry.snapshot().revision;
  assert.deepEqual(await catalog.reorder({kind:'items',repoId:null},['a','b']),{ok:false,reason:'membership-changed'});
  assert.equal(registry.snapshot().revision,rev);
  await assert.rejects(catalog.update('a',{agentActivity:'running'} as any));
  registry=await Registry.open(dir);
  const doc=projectCatalog(registry.snapshot());
  assert.deepEqual(doc.items.map(i=>i.id),['c','a','b']);
  assert.equal(doc.items.find(i=>i.id==='a')?.userTitle,'My note');
  assert.equal(doc.items.find(i=>i.id==='a')?.type,'note');
 } finally { await rm(dir,{recursive:true,force:true}); }
});
