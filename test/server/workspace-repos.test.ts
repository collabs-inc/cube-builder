import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,mkdir,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/server/registry.js';
import { Repos } from '../../src/server/repos.js';
import { WorkspaceRepos } from '../../src/server/workspace-repos.js';
import { Terminals } from '../../src/server/terminals.js';
import { git } from '../../src/server/git.js';

test('original worktree operations retain sidebar identity through creation, refresh, and removal refusal',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'builder-worktrees-'));
 try {
  const registry=await Registry.open(join(dir,'state')),repos=new Repos(registry);
  const repo=await repos.create(join(dir,'repo'));
  await git(repo.root,['-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','initial']);
  const service=new WorkspaceRepos(registry,repos,{close(){throw Error('No sessions in fixture')}} as unknown as Terminals);
  await mkdir(join(repo.root,'.cube'));
  await writeFile(join(repo.root,'.cube','worktree.json'),JSON.stringify({copy:['.env']}));
  await writeFile(join(repo.root,'.env'),'PORT=4321');
  const created=await service.createWorktree({parentId:repo.id,name:'feature',source:{from:'new'},baseBranch:'main'});
  assert.equal(service.checkout(created.id).worktreeOf?.creation?.state,'pending');
  const deadline=Date.now()+10000;
  while(service.checkout(created.id).worktreeOf?.creation?.state==='pending'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  const row=service.checkout(created.id);
  assert.equal(row.worktreeOf?.creation,undefined,JSON.stringify(row));
  assert.equal(row.head?.branch,'feature');
  assert.equal(row.root,join(dir,'state','worktrees','repo','feature'));
  assert.equal(await readFile(join(row.root,'.env'),'utf8'),'PORT=4321');
  await registry.mutate(null,d=>{d.repos[0]!.worktrees.find(w=>w.id===created.id)!.creation={state:'pending'}});
  const restarted=new WorkspaceRepos(registry,repos,{close(){throw Error('No sessions in fixture')}} as unknown as Terminals);
  const recoveryDeadline=Date.now()+1500;
  while(restarted.checkout(created.id).worktreeOf?.creation?.state==='pending'&&Date.now()<recoveryDeadline)await new Promise(r=>setTimeout(r,20));
  assert.equal(restarted.checkout(created.id).worktreeOf?.creation,undefined,'interrupted creation must finish against its existing checkout');
  await repos.refresh(repo.id);
  assert.equal(service.checkout(created.id).root,row.root);
  await writeFile(join(row.root,'unsaved.txt'),'keep this');
  await assert.rejects(service.removeWorktree(created.id),/uncommitted|unpushed/);
  assert.equal(service.checkout(created.id).id,created.id);
  await service.removeWorktree(created.id,true);
  assert.throws(()=>service.checkout(created.id),/no longer exists/);
 } finally {await rm(dir,{recursive:true,force:true})}
});
