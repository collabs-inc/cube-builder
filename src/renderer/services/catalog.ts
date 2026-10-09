import { LOCAL_MACHINE_ID } from '@port/shared/types';
import { projectCatalog } from '../../shared/catalog';
import type { CatalogService, PtyCreateOptions, PtySession } from './types';
import type { BuilderConnection } from './connection';
import { Signal } from './connection';

export function requireInstallation(machineId:string) {
 if(machineId!==LOCAL_MACHINE_ID)throw new Error('This workspace operates on the installation machine only');
}

export function createCatalogService(connection:BuilderConnection,createTerminal:(options:PtyCreateOptions)=>Promise<PtySession>):CatalogService {
 const evicted=new Signal<[{machineId:string}]>();
 const doc=()=>projectCatalog(connection.snapshot);
 return {
  async get(){return [{machineId:LOCAL_MACHINE_ID,catalog:doc()}]},
  onChanged:cb=>connection.changed.on(snapshot=>cb({machineId:LOCAL_MACHINE_ID,catalog:projectCatalog(snapshot)})),
  onEvicted:evicted.on,
  async addRepo(args){
   requireInstallation(args.machineId);
   const root=args.root;
   if(!root)throw new Error('Choose a destination on this machine');
   const repo=args.gitUrl?await connection.api.call('repos.clone',{url:args.gitUrl,path:root}):await connection.api.call('repos.add',{path:root});
   await connection.refresh();return {repo:doc().repos.find(r=>r.id===repo.id)!};
  },
  async removeRepo(machineId,id,options){
   requireInstallation(machineId);
   const repo=doc().repos.find(r=>r.id===id);if(!repo)throw new Error('Repository no longer exists');
   if(repo.worktreeOf)await connection.api.call('workspaceWorktrees.remove',{id,force:options?.force});
   else await connection.api.call('repos.remove',{id});
   await connection.refresh();return {ok:true};
  },
  async addItem(args){
   requireInstallation(args.machineId);
   if(args.type==='term') {
    const result=await createTerminal({cwd:args.cwd,repoId:args.repoId,target:args.target,agentSessionId:args.agentSessionId});
    const item=doc().items.find(i=>i.ptySessionId===result.sessionId);
    if(!item)throw new Error('Terminal creation did not produce a catalog item');return {item};
   }
   if(!args.filePath)throw new Error('Choose a file on this machine');
   const file=await connection.api.call('files.open',{path:args.filePath,repoId:args.repoId});
   await connection.refresh();return {item:doc().items.find(i=>i.id===file.id)!};
  },
  async updateItem(machineId,id,patch){
   requireInstallation(machineId);
   const {ptySessionId,type,...metadata}=patch;
   if(ptySessionId!==undefined&&doc().items.find(i=>i.id===id)?.ptySessionId!==ptySessionId)throw new Error('Terminal identity must be assigned by its backend');
   const item=await connection.api.call('catalog.update',{id,patch:metadata});
   await connection.refresh();return {item};
  },
  async removeItem(machineId,id){
   requireInstallation(machineId);
   const item=doc().items.find(i=>i.id===id);
   if(!item)return {ok:true};
   await connection.api.call(item.type==='term'?'terminals.close':'files.close',{id});
   await connection.refresh();return {ok:true};
  },
  async reorder(machineId,scope,ids){requireInstallation(machineId);const result=await connection.api.call('catalog.reorder',{scope,ids});await connection.refresh();return result}
 };
}
