import {Registry} from './registry.js';
import type {SessionInfo} from '../shared/terminal-protocol.js';
import {defaultAgentProbes,snapshotProcessGroups,discoverAcrossGroup,decideDiscoveryPatch,type AgentProbes} from './ported/agent-discovery.js';

/** Port of the original terminal discovery sweep, scoped to Builder-owned PTYs. */
export class AgentSessions {
 private timer:ReturnType<typeof setInterval>;
 private running?:Promise<void>;
 private closed=false;
 constructor(private registry:Registry,private list:()=>Promise<SessionInfo[]>,private probes:AgentProbes=defaultAgentProbes(),private groups=snapshotProcessGroups,private warning=(error:unknown)=>console.warn('[agent sessions]',error)){
  this.timer=setInterval(()=>{void this.sweep().catch(warning)},5000);this.timer.unref();
 }
 sweep(sessions?:SessionInfo[]):Promise<void>{
  if(this.closed)return Promise.resolve();
  return this.running??=this.read(sessions).finally(()=>{this.running=undefined});
 }
 private async read(sessions?:SessionInfo[]){
  const rows=this.registry.snapshot().items.filter(i=>i.type==='term'&&!i.exited&&i.harness&&this.probes[i.harness]);
  if(!rows.length)return;
  const live=sessions??await this.list();let groupOf:((pid:number)=>number[])|undefined;
  for(const item of rows){
   if(this.closed||item.type!=='term')return;
   const session=live.find(s=>s.id===item.sessionId&&!s.exited);if(!session)continue;
   try {
    groupOf??=this.groups();
    const patch=decideDiscoveryPatch(item.agentSessionId,discoverAcrossGroup(groupOf(session.pid),this.probes[item.harness!]!));
    if(patch&&!this.closed)await this.registry.mutate(null,d=>{const current=d.items.find(i=>i.id===item.id);if(current?.type==='term'&&current.sessionId===session.id)current.agentSessionId=patch.agentSessionId});
   } catch(error){this.warning(error)}
  }
 }
 close(){this.closed=true;clearInterval(this.timer)}
}
