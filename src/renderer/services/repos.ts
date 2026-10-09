import { projectCatalog } from '../../shared/catalog';
import type { BuilderConnection } from './connection';
import { requireInstallation } from './catalog';
import type { ReposService, WorktreesService } from './types';

export function createRepoServices(connection:BuilderConnection,openFolder:()=>Promise<string|null>):{repos:ReposService;worktrees:WorktreesService} {
 const repos:ReposService={
  async create(machineId,args){requireInstallation(machineId);const repo=await connection.api.call('workspaceRepos.create',args);await connection.refresh();return {repo}},
  async githubOwners(machineId){requireInstallation(machineId);return connection.api.call('workspaceRepos.owners',{})},
  async publish(machineId,args){requireInstallation(machineId);const result=await connection.api.call('workspaceRepos.publish',args);await connection.refresh();return result},
  async add(){const path=await openFolder();if(!path)return null;const row=await connection.api.call('repos.add',{path});await connection.refresh();return {repo:projectCatalog(connection.snapshot).repos.find(r=>r.id===row.id)!}},
  async remove(id,operationId){const result=await connection.api.call('workspaceRepos.detach',{id,operationId});await connection.refresh();return result},
  async statusSnapshot(){return Object.fromEntries(projectCatalog(connection.snapshot).repos.map(r=>[r.id,{status:'open' as const}]))},
  onStatus(cb){
   const changed=connection.changed.on(snapshot=>{for(const repo of projectCatalog(snapshot).repos)cb({repoId:repo.id,status:'open'})});
   const connected=connection.connected.on(ready=>{for(const repo of projectCatalog(connection.snapshot).repos)cb({repoId:repo.id,status:ready?'open':'connecting'})});
   return ()=>{changed();connected()};
  }
 };
 const worktrees:WorktreesService={
  async create(machineId,args){requireInstallation(machineId);const result=await connection.api.call('workspaceWorktrees.create',args);await connection.refresh();return result},
  async retry(machineId,id){requireInstallation(machineId);await connection.api.call('workspaceWorktrees.retry',{id});await connection.refresh()},
  async inspect(machineId,id){requireInstallation(machineId);return connection.api.call('workspaceWorktrees.inspect',{id})},
  async repoInfo(machineId,id){requireInstallation(machineId);return connection.api.call('workspaceWorktrees.info',{id})},
  async listBranches(machineId,id){requireInstallation(machineId);return connection.api.call('workspaceWorktrees.branches',{id})},
  async listPrs(machineId,id){requireInstallation(machineId);return connection.api.call('workspaceWorktrees.prs',{id})},
  async listIssues(machineId,id){requireInstallation(machineId);return connection.api.call('workspaceWorktrees.issues',{id})},
  async resolve(machineId,id,kind,number){requireInstallation(machineId);return connection.api.call('workspaceWorktrees.resolve',{id,kind,number})}
 };
 return {repos,worktrees};
}
