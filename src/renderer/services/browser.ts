import type { Services, PtyCreateOptions, PtySession } from './types';
import type { PersistableWorkspaceState } from '../state/workspace';
import { services as http } from '../../web/services/http';
import { BuilderConnection } from './connection';
import { createCatalogService, requireInstallation } from './catalog';
import { createRepoServices } from './repos';
import { createFilesService } from './files';
import { createPtyService } from './pty';
import { createDesktopService } from './desktop';
import { createPrefsApi } from './prefs';
import { createWorkspaceApi } from './workspace';
import { configureDrafts } from './drafts';
import { chooseFolder } from '../overlays/FolderPicker';

export async function createBrowserServices():Promise<Services & {dispose():void}> {
 const connection=new BuilderConnection(http);
 try{await connection.start()}catch(error){connection.dispose();throw error}
 configureDrafts(connection.snapshot.epoch);
 const prefs=createPrefsApi();
 const workspace=createWorkspaceApi({storageKey:'builder-workspace:'+connection.snapshot.epoch});
 const openFolder=()=>chooseFolder(connection.snapshot.capabilities.home);
 const desktop=createDesktopService(connection,openFolder);
 async function launch(options:PtyCreateOptions):Promise<PtySession>{
  const target=options.target??await prefs.getPref('terminalTarget');
  const item=await http.call('terminals.launch',{requestId:crypto.randomUUID(),target:typeof target==='string'?target:'auto',cwd:options.cwd,repoId:options.repoId,catalogItemId:options.catalogItemId,agentSessionId:options.agentSessionId,resume:options.resume,cols:options.cols,rows:options.rows});
  await connection.refresh();
  return {sessionId:item.sessionId,shell:item.command,command:item.command,args:item.args,displayName:item.title,target:item.harness??'shell',cwdHostPath:item.cwd,seq:0,resumed:item.resumed};
 }
 const pty=createPtyService(connection,launch),files=createFilesService(connection);
 const backend:Services & {dispose():void}={
  log:line=>console.info('[builder]',line),
  computer:{localInfo:()=>http.call('computer.info',{})},
  desktop,pty,files,catalog:createCatalogService(connection,launch),...createRepoServices(connection,openFolder),
  prefs:{get:prefs.getPref,set:prefs.setPref,getWorkspace:prefs.getWorkspacePref,setWorkspace:prefs.setWorkspacePref},
  workspace:{async load(){return await workspace.workspaceLoad() as PersistableWorkspaceState|null},save:state=>workspace.workspaceSave(state)},
  artifacts:{async artifactUrl(machineId,args){
   requireInstallation(machineId);
   const repo=connection.snapshot.repos.find(r=>r.id===args.repoId);
   const root=repo?.root??connection.snapshot.repos.flatMap(r=>r.worktrees).find(w=>w.id===args.repoId)?.root;
   const item=connection.snapshot.items.find(i=>i.type==='artifact'&&(i.id===args.repoId||!!root&&i.filePath===root+'/'+args.file));
   if(!item)throw new Error('Artifact no longer exists');
   const {url}=await http.call('previews.create',{itemId:item.id});return new URL(url+'?theme='+args.theme,location.href).href;
  }},
  dispose(){desktop.dispose();files.dispose();pty.dispose();connection.dispose()}
 };
 return backend;
}
