import {resolve} from 'node:path';
import {HeadWatcher} from './ported/head-watch.js';
import {WorktreeWatcher} from './ported/worktree-watch.js';
import {projectCatalog} from '../shared/catalog.js';
import {Registry} from './registry.js';
import {Repos} from './repos.js';
import {git} from './git.js';

/** Original Git watchers; all ownership and subscriptions stay in Builder. */
export class RepoObservers {
 private heads:HeadWatcher;
 private worktrees:WorktreeWatcher;
 private pending=new Set<string>();
 private running?:Promise<void>;
 private closed=false;
 constructor(private registry:Registry,private repos:Repos,private warning=(message:string)=>console.warn('[repositories]',message)){
  this.heads=new HeadWatcher({onChanged:()=>{for(const repo of registry.snapshot().repos)this.refresh(repo.id)},onWarning:warning});
  this.worktrees=new WorktreeWatcher({onChanged:id=>this.refresh(id),onWarning:warning,gitCommonDir:async root=>{try{return resolve(root,(await git(root,['rev-parse','--git-common-dir'])).trim())}catch{return null}}});
 }
 private sync=()=>{void this.syncNow().catch(error=>this.warning(String(error)))};
 private async syncNow(){const rows=projectCatalog(this.registry.snapshot()).repos;await Promise.all([this.heads.sync(rows),this.worktrees.sync(rows)])}
 async start(){this.registry.on('changed',this.sync);await this.syncNow();for(const repo of this.registry.snapshot().repos)this.refresh(repo.id);await this.running;await this.syncNow()}
 private refresh(id:string){
  if(this.closed)return;this.pending.add(id);
  this.running??=this.drain().finally(()=>{this.running=undefined;if(this.pending.size)this.refresh(this.pending.values().next().value!)});
 }
 private async drain(){
  while(!this.closed&&this.pending.size){
   const id=this.pending.values().next().value!;this.pending.delete(id);
   if(!this.registry.snapshot().repos.some(r=>r.id===id))continue;
   try{await this.repos.refresh(id);await this.syncNow()}catch(error){this.warning(String(error))}
  }
 }
 async close(){this.closed=true;this.registry.off('changed',this.sync);this.pending.clear();await this.running;await Promise.all([this.heads.close(),this.worktrees.close()]);await this.registry.flush()}
}
