import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../../src/server/registry.js';
import {Repos} from '../../src/server/repos.js';
import {git} from '../../src/server/git.js';
import {RepoObservers} from '../../src/server/repo-observers.js';
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));assert.ok(check(),'Git changes must reach the catalog without a client refresh')}
test('original Git watchers adopt external worktrees and follow branch changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'builder-repo-observers-'));
 let observers:RepoObservers|undefined;
 try {
  const registry=await Registry.open(join(root,'state')),repos=new Repos(registry);
  const repo=await repos.create(join(root,'repo'));
  await git(repo.root,['-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','fixture']);
  observers=new RepoObservers(registry,repos);await observers.start();
  const extra=join(root,'external');
  await git(repo.root,['worktree','add','-b','external',extra]);
  await until(()=>registry.snapshot().repos[0]!.worktrees.some(w=>w.root===extra));
  await git(extra,['checkout','-b','renamed']);
  await until(()=>registry.snapshot().repos[0]!.worktrees.some(w=>w.root===extra&&w.branch==='renamed'));
  await git(repo.root,['worktree','remove',extra]);
  await until(()=>!registry.snapshot().repos[0]!.worktrees.some(w=>w.root===extra));
 } finally {await observers?.close();await rm(root,{recursive:true,force:true,maxRetries:5})}
});
