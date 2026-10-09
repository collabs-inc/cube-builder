export interface WorktreeCreate { parentId:string;name:string;source:import('../port-shared/catalog.js').WorktreeSource;baseBranch?:string }
export interface ItemPatch { userTitle?: string; agentTitle?: string; cwd?: string; filePath?: string; agentSessionId?: string }
import type { CatalogDocument, CatalogItem, CatalogRepo } from '../port-shared/catalog.js';
import type { BuilderSnapshot } from './model.js';

/** Translate storage records at the boundary; the original catalog/store owns UI semantics. */
export function projectCatalog(snapshot: BuilderSnapshot): CatalogDocument {
 const repos: CatalogRepo[] = [];
 for (const repo of snapshot.repos) {
  const primary = repo.worktrees.find(tree => tree.root === repo.root);
  repos.push({ id: repo.id, name: repo.name, root: repo.root, managed: repo.managed ?? false,
   createdAt: repo.createdAt ?? new Date(0).toISOString(),
   ...(repo.originUrl ? {originUrl:repo.originUrl} : {}),
   ...(primary ? {head:{branch:primary.branch,sha:primary.sha ?? ''}} : {}) });
  for (const tree of repo.worktrees) {
   if (tree.root === repo.root) continue;
   repos.push({id:tree.id,root:tree.root,name:tree.name,managed:repo.managed ?? false,
    createdAt:tree.createdAt ?? repo.createdAt ?? new Date(0).toISOString(),
    head:{branch:tree.branch,sha:tree.sha ?? ''},
    worktreeOf:{repoId:repo.id,createdOnBranch:tree.createdOnBranch ?? tree.branch ?? '',source:tree.source ?? {from:'branch'},baseBranch:tree.baseBranch,creation:tree.creation}});
  }
 }
 const items: CatalogItem[] = snapshot.items.map(item => {
  // Legacy terminals carry the parent registration even when running in a worktree.
  const family = repos.filter(r => r.id === item.repoId || r.worktreeOf?.repoId === item.repoId);
  const path = item.cwd.replaceAll('\\','/');
  const owner = family.filter(r => {const root=r.root.replaceAll('\\','/').replace(/\/$/,'');return path===root||path.startsWith(root+'/');}).sort((a,b)=>b.root.length-a.root.length)[0];
  const base = {id:item.id,repoId:owner?.id ?? item.repoId ?? undefined,createdAt:item.createdAt,cwd:item.cwd,
   userTitle:item.userTitle,agentTitle:item.agentTitle,updatedAt:item.updatedAt};
  if(item.type === 'term') return {...base,type:'term',ptySessionId:item.sessionId,target:item.harness ?? 'shell',
   agentSessionId:item.agentSessionId,workingDir:item.cwd,
   agentActivity:item.attention==='working'?'running':item.attention==='waiting'?'blocked':undefined,
   turnEndedAt:item.turnEndedAt,turnEndedLaunchId:item.sessionId,
   ...(item.exited?{exitedAt:item.updatedAt,...(item.exitCode!==null?{exitCode:item.exitCode}:{})}:{})};
  return {...base,type:item.type==='file'?(/\.(md|mdx|markdown)$/i.test(item.filePath)?'note':'code'):item.type,filePath:item.filePath};
 });
 return {version:1,epoch:snapshot.epoch,rev:snapshot.revision,repos,items};
}
