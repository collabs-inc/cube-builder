import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Registry} from '../../src/server/registry.js';
import {AgentSessions} from '../../src/server/agent-sessions.js';
import type {SessionInfo} from '../../src/shared/terminal-protocol.js';
test('discovery updates only this installation catalog agent and never adopts unrelated sessions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'builder-agent-ids-'));let service:AgentSessions|undefined;
 try {
  const registry=await Registry.open(dir);
  await registry.mutate(null,d=>{for(const id of ['agent','shell'])d.items.push({id,type:'term',sessionId:id,requestId:id,repoId:null,cwd:dir,title:id,createdAt:'now',updatedAt:'now',command:'/bin/sh',args:[],exited:false,exitCode:null,...(id==='agent'?{harness:'codex'}:{})})});
  const probes:number[]=[];
  const sessions=['agent','shell','unrelated'].map((id,i)=>({id,pid:i+100,exited:false} as SessionInfo));
  service=new AgentSessions(registry,async()=>sessions,{codex:pid=>{probes.push(pid);return 'thread-id'}},()=>pid=>[pid]);
  await service.sweep();
  assert.deepEqual(probes,[100]);assert.equal(registry.snapshot().items[0]!.agentSessionId,'thread-id');
  const rev=registry.snapshot().revision;await service.sweep();assert.equal(registry.snapshot().revision,rev);
  assert.equal(registry.snapshot().items.length,2);assert.equal(registry.snapshot().items[1]!.agentSessionId,undefined);
 }finally{service?.close();await rm(dir,{recursive:true,force:true})}
});
