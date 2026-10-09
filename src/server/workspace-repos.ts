import { git } from './git.js';
import { integer } from './validation.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Registry } from './registry.js';
import { Repos, isWithin } from './repos.js';
import { Terminals } from './terminals.js';
import { CubedClones } from './ported/clones.js';
import { CubedWorktrees } from './ported/worktrees.js';
import { CubedGithub } from './ported/github.js';
import { CubedRepoPublisher } from './ported/repo-publish.js';
import { projectCatalog } from '../shared/catalog.js';
import { slugifyBranch, issueBranchName } from '../port-shared/worktree-naming.js';
import type { CreateRepoArgs, PublishRepoArgs } from '../port-shared/repo-create.js';
import type { WorktreeCreate } from '../shared/catalog.js';
import { BuilderError } from '../shared/errors.js';

/** Original filesystem/Git operations, registered in Builder's own durable catalog. */
export class WorkspaceRepos {
 readonly worktrees: CubedWorktrees;
 readonly github = new CubedGithub();
 readonly publisher = new CubedRepoPublisher();
 private clones: CubedClones;
 private creating = new Map<string,Promise<void>>();
 constructor(private registry:Registry,private repos:Repos,private terminals:Terminals){
  this.worktrees=new CubedWorktrees(undefined,join(registry.stateDir,'worktrees'));
  this.clones=new CubedClones({reposDir:join(registry.snapshot().capabilities.home,'repos')});
 }
 checkout(id:string){const row=projectCatalog(this.registry.snapshot()).repos.find(r=>r.id===id);if(!row)throw new BuilderError('repo-missing','Repository no longer exists');return row}
 async create(args:CreateRepoArgs){
  const created=await this.clones.create(args),repo=await this.repos.add(created.repoPath);
  await this.registry.mutate(null,d=>{const r=d.repos.find(r=>r.id===repo.id)!;r.name=created.name;r.managed=true});return this.checkout(repo.id);
 }
 async publish(args:PublishRepoArgs){const result=await this.publisher.publish(this.checkout(args.repoId).root,args);await this.registry.mutate(null,d=>{const row=d.repos.find(r=>r.id===args.repoId);if(row)row.originUrl=result.url+'.git'});return result}
 async createWorktree(args:WorktreeCreate){
  const parent=this.repos.get(args.parentId);
  if(!args.name||typeof args.name!=='string'||args.name.length>200)throw new BuilderError('invalid-request','Choose a worktree name');
  if(!args.source||!['new','branch','pr','issue'].includes(args.source.from))throw new BuilderError('invalid-request','Choose a worktree source');
  const source=args.source;
  const branch=source.from==='branch'||source.from==='pr'?args.name:source.from==='issue'?issueBranchName(source.number,args.name):slugifyBranch(args.name);
  if(source.from==='pr'||source.from==='issue')integer(source.number,'issue or pull request number',1,Number.MAX_SAFE_INTEGER);
  await git(parent.root,['check-ref-format','--branch',branch]);
  const id=randomUUID(),path=join(this.worktrees.worktreesDir,parent.id,id,slugifyBranch(args.name).replaceAll('/','-'));
  let baseBranch=args.baseBranch;
  if(source.from==='new'||source.from==='issue')baseBranch??=(await this.worktrees.repoInfo({repoPath:parent.root})).defaultBranch??'main';
  await this.registry.mutate(null,d=>{const row=d.repos.find(r=>r.id===parent.id);if(!row)throw new Error('Repository removed');row.worktrees.push({id,root:path,name:args.name,branch:null,main:false,createdOnBranch:branch,source,baseBranch,createdAt:new Date().toISOString(),creation:{state:'pending'}})});
  this.startCreation(parent.id,id);return {id};
 }
 private startCreation(parentId:string,id:string){
  if(this.creating.has(id))return;
  const task=this.driveCreation(parentId,id).catch(error=>console.error('[worktrees] failed to persist creation status',error)).finally(()=>this.creating.delete(id));this.creating.set(id,task);
 }
 private async driveCreation(parentId:string,id:string){
  const parent=this.repos.get(parentId),tree=parent.worktrees.find(t=>t.id===id)!;
  const mayWrite=()=>this.registry.snapshot().repos.some(r=>r.id===parentId&&r.worktrees.some(t=>t.id===id&&t.creation?.state==='pending'));
  try {
   await mkdir(join(tree.root,'..'),{recursive:true});
   const source=tree.source??{from:'branch'};
   await this.worktrees.add({repoPath:parent.root,path:tree.root,branch:tree.createdOnBranch!,source:source.from==='new'||source.from==='issue'?{from:source.from,baseBranch:tree.baseBranch!}:source.from==='pr'?{from:'pr',number:source.number}:{from:'branch'}},mayWrite);
   await this.repos.refresh(parentId);
   await this.registry.mutate(null,d=>{const row=d.repos.find(r=>r.id===parentId)?.worktrees.find(t=>t.id===id);if(row)delete row.creation});
  } catch(error) {
   await this.registry.mutate(null,d=>{const row=d.repos.find(r=>r.id===parentId)?.worktrees.find(t=>t.id===id);if(row)row.creation={state:'failed',error:error instanceof Error?error.message:String(error)}});
  }
 }
 async retry(id:string){const row=this.checkout(id);if(!row.worktreeOf)throw new Error('Choose a worktree');await this.registry.mutate(null,d=>{const tree=d.repos.find(r=>r.id===row.worktreeOf!.repoId)!.worktrees.find(t=>t.id===id)!;tree.creation={state:'pending'}});this.startCreation(row.worktreeOf.repoId,id)}
 async removeWorktree(id:string,force=false){
  const row=this.checkout(id);if(!row.worktreeOf)throw new Error('Choose a secondary worktree');
  if(this.creating.has(id))throw new Error('Wait for worktree creation to finish');
  const parent=this.repos.get(row.worktreeOf.repoId);
  if(!force){const status=await this.worktrees.inspect({path:row.root});if(status.dirty||status.unpushedCommits)throw new Error('Worktree has uncommitted or unpushed work');}
  for(const item of this.registry.snapshot().items)if(item.type==='term'&&isWithin(row.root,item.cwd))await this.terminals.close(item.id);
  await this.worktrees.remove({repoPath:parent.root,path:row.root,force});
  await this.registry.mutate(null,d=>{const repo=d.repos.find(r=>r.id===parent.id);if(repo)repo.worktrees=repo.worktrees.filter(w=>w.id!==id);d.items=d.items.filter(i=>!isWithin(row.root,i.cwd))});
 }
 async detach(id:string,operationId:string){
  const repo=this.repos.get(id);
  if([...this.creating.keys()].some(id=>repo.worktrees.some(w=>w.id===id)))throw new Error('Wait for worktree creation to finish');
  const family=new Set([id,...repo.worktrees.map(w=>w.id)]);
  for(const item of this.registry.snapshot().items)if(item.type==='term'&&item.repoId&&family.has(item.repoId))await this.terminals.close(item.id);
  await this.registry.mutate(null,d=>{d.repos=d.repos.filter(r=>r.id!==id);d.items=d.items.filter(i=>!i.repoId||!family.has(i.repoId))});
  return {operationId,state:'complete' as const};
 }
}
