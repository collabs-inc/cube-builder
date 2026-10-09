import { assertHarnessInstalled, listTerminalTargets } from './ported/terminal-target.js';
import { resolveBuilderTarget } from './launch-target.js';
import { FileDownloads } from './ported/file-downloads.js';
import { importWebArticle } from './ported/import-service.js';
import { absolutePath } from './repos.js';
import { WorkspaceRepos } from './workspace-repos.js';
import { cpus, homedir, totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';
import { Catalog } from './catalog.js';
import { listAgents } from './agents.js';
import { Registry } from './registry.js';
import { Terminals } from './terminals.js';
import { BuilderError } from '../shared/errors.js';
import type { MethodMap } from '../shared/methods.js';
import { Repos } from './repos.js';
import { Files } from './files.js';
import { Previews } from './previews.js';
type Handlers = { [K in keyof MethodMap]: (params: MethodMap[K]['params']) => MethodMap[K]['result'] | Promise<MethodMap[K]['result']> };
export function createMethods(registry: Registry, terminals: Terminals, repos: Repos, files: Files, previews: Previews, downloads: FileDownloads) {
  const catalog = new Catalog(registry);
  const workspaceRepos = new WorkspaceRepos(registry,repos,terminals);
  const handlers: Handlers = {
    'terminals.targets': () => listTerminalTargets(),
    'terminals.launch': async p => {
      const owner=p.repoId?workspaceRepos.checkout(p.repoId):undefined;
      const resolved=resolveBuilderTarget({...p,cwd:p.cwd??owner?.root});
      assertHarnessInstalled(resolved);
      return terminals.create({requestId:p.requestId,catalogItemId:p.catalogItemId,cwd:resolved.cwd,command:resolved.command,args:resolved.args,
        repoId:owner?.worktreeOf?.repoId??owner?.id,agentSessionId:resolved.agentSessionId,resumed:resolved.resumed,
        ...(resolved.target==='shell'||resolved.target==='powershell'||resolved.target.startsWith('wsl:')?{}:{harness:resolved.target}),cols:p.cols,rows:p.rows});
    },
    'downloads.create': async p => {const result=await downloads.mint({root:'',path:absolutePath(p.path),download:true});return {url:'/download?token='+encodeURIComponent(result.token)}},
    'files.importArticle': p => {const directory=absolutePath(p.directory);return importWebArticle(p.url,directory,directory)},
    'workspaceRepos.create': p => workspaceRepos.create(p),
    'workspaceRepos.owners': () => workspaceRepos.publisher.owners(),
    'workspaceRepos.publish': p => workspaceRepos.publish(p),
    'workspaceRepos.detach': p => workspaceRepos.detach(p.id,p.operationId),
    'workspaceWorktrees.create': p => workspaceRepos.createWorktree(p),
    'workspaceWorktrees.retry': async p => {await workspaceRepos.retry(p.id);return null},
    'workspaceWorktrees.remove': async p => {await workspaceRepos.removeWorktree(p.id,p.force);return null},
    'workspaceWorktrees.inspect': p => workspaceRepos.worktrees.inspect({path:workspaceRepos.checkout(p.id).root}),
    'workspaceWorktrees.info': async p => ({...await workspaceRepos.worktrees.repoInfo({repoPath:workspaceRepos.checkout(p.id).root}),worktreesDir:workspaceRepos.worktrees.worktreesDir}),
    'workspaceWorktrees.branches': p => workspaceRepos.worktrees.branches({repoPath:workspaceRepos.checkout(p.id).root}),
    'workspaceWorktrees.prs': p => workspaceRepos.github.listPrs({repoPath:workspaceRepos.checkout(p.id).root}),
    'workspaceWorktrees.issues': p => workspaceRepos.github.listIssues({repoPath:workspaceRepos.checkout(p.id).root}),
    'workspaceWorktrees.resolve': p => workspaceRepos.github.resolve({repoPath:workspaceRepos.checkout(p.id).root,kind:p.kind,number:p.number}),
    'computer.info': async () => {const disk=await statfs(homedir()).catch(()=>null);return {homeDir:homedir(),cpus:cpus().length,cpuModel:cpus()[0]?.model??null,memoryMb:Math.round(totalmem()/1024/1024),storageGb:disk?disk.blocks*disk.bsize/1e9:null,storageUsedBytes:disk?(disk.blocks-disk.bfree)*disk.bsize:null}},
    'files.tree': p => files.tree(p.path),
    'files.trash': p => files.trash(p),
    'files.table': p => files.table(p.path),
    'previews.file': p => previews.forPath(p.path),
    'catalog.update': p => catalog.update(p.id, p.patch),
    'catalog.reorder': p => catalog.reorder(p.scope, p.ids),
    snapshot: () => registry.snapshot(),
    'agents.list': () => listAgents(),
    'repos.add': p => repos.add(p.path),
    'repos.create': p => repos.create(p.path),
    'repos.clone': p => repos.clone(p.url, p.path),
    'repos.remove': async p => { await repos.remove(p.id); return null; },
    'repos.refresh': p => repos.refresh(p.id),
    'worktrees.create': p => repos.createWorktree(p),
    'worktrees.remove': async p => { await repos.removeWorktree(p); return null; },
    'files.list': p => files.list(p.path),
    'files.stat': p => files.info(p.path),
    'files.read': p => files.read(p.path),
    'files.write': p => files.write(p),
    'files.open': p => files.open(p.path, p.repoId),
    'files.close': async p => { await files.close(p.id); return null; },
    'files.rename': p => files.rename(p),
    'files.remove': async p => { await files.remove(p); return null; },
    'files.mkdir': p => files.mkdir(p.path),
    'files.upload': p => files.upload(p),
    'previews.create': p => previews.create(p.itemId),
    'terminals.create': params => terminals.create(params),
    'terminals.read': params => terminals.read(params),
    'terminals.write': async params => { await terminals.write(params); return null; },
    'terminals.resize': async params => { await terminals.resize(params); return null; },
    'terminals.close': async params => { await terminals.close(params.id); return null; },
    'terminals.stopAll': async () => { await terminals.stopAll(); return null; },
  };
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!Object.hasOwn(handlers, method)) throw new BuilderError('unknown-method', `Unknown method: ${method}`);
    return (handlers[method as keyof MethodMap] as (p: unknown) => unknown)(params);
  };
}
