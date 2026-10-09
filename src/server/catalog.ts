import { Registry } from './registry.js';
import { BuilderError } from '../shared/errors.js';
import { projectCatalog } from '../shared/catalog.js';
import { applyScopeOrder, isPermutationOf, isReorderScope, scopeMemberIds, type ReorderScope, type ReorderRefusal } from '../port-shared/catalog-order.js';

import type { ItemPatch } from '../shared/catalog.js';
export class Catalog {
 constructor(private registry: Registry) {}
 async update(id: string, patch: ItemPatch) {
  if(!patch || typeof patch !== 'object' || Object.keys(patch).some(key=>!['userTitle','agentTitle','cwd','filePath','agentSessionId'].includes(key))) throw new BuilderError('invalid-request','Unsupported item update');
  for(const value of Object.values(patch)) if(typeof value !== 'string' || value.includes('\0') || value.length>16384) throw new BuilderError('invalid-request','Invalid item metadata');
  const next=await this.registry.mutate(null,d=> {
   const row=d.items.find(i=>i.id===id);
   if(!row) throw new BuilderError('item-missing','Item no longer exists');
   if('filePath' in patch && row.type==='term') throw new BuilderError('invalid-request','Terminal cannot have a file path');
   Object.assign(row,patch,{updatedAt:new Date().toISOString()});
  });
  return projectCatalog(next).items.find(i=>i.id===id)!;
 }
 async reorder(scope: ReorderScope, ids: string[]): Promise<{ok:true}|{ok:false;reason:ReorderRefusal}> {
  if(!isReorderScope(scope)||!Array.isArray(ids)||ids.some(id=>typeof id!=='string')) throw new BuilderError('invalid-request','Invalid catalog order');
  // Validate inside the registry transaction, so concurrent mutations cannot admit a stale permutation.
  try {
   await this.registry.mutate(null,d=> {
    const members=scopeMemberIds(projectCatalog(d),scope);
    if(members===null) throw new BuilderError('scope-unknown','Scope no longer exists');
    if(!isPermutationOf(ids,members)) throw new BuilderError('membership-changed','Scope membership changed');
    if(scope.kind==='repos') d.repos=applyScopeOrder(d.repos,ids);
    else if(scope.kind==='worktrees') {
     const repo=d.repos.find(r=>r.id===scope.parentId)!;
     repo.worktrees=applyScopeOrder(repo.worktrees,ids);
    } else d.items=applyScopeOrder(d.items,ids);
   });
   return {ok:true};
  } catch(error) {
   if(error instanceof BuilderError&&(error.code==='scope-unknown'||error.code==='membership-changed')) return {ok:false,reason:error.code};
   throw error;
  }
 }
}
