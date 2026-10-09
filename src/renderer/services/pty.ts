import type { TerminalItem } from '../../shared/model';
import { bytesToBase64 } from '../../web/services/assets';
import { BuilderConnection, Signal } from './connection';
import type { PtyService, PtyDataCallback, PtyExitCallback, PtyCreateOptions, PtySession, PtyStatusPayload } from './types';

const decode=(data:string)=>Uint8Array.from(atob(data),c=>c.charCodeAt(0));
interface Stream { cursor:number; callbacks:Set<PtyDataCallback>; queue:Promise<unknown>; pending:boolean; draining:boolean }
/** Cursor reads close both the attach gap and websocket reconnect gaps. */
export function createPtyService(connection:BuilderConnection,create:(options:PtyCreateOptions)=>Promise<PtySession>):PtyService & {dispose():void} {
 const streams=new Map<string,Stream>();
 const exits=new Signal<[Parameters<PtyExitCallback>[0]]>();
 const statuses=new Signal<[PtyStatusPayload]>();
 const lost=new Signal<[{sessionId:string}]>();
 const windows=new Signal<[{sessionId:string;start:number;end:number;reset:boolean}]>();
 const exitCallbacks=new Map<PtyExitCallback,()=>void>();
 const reportedExited=new Set<string>();
 const stream=(id:string)=>{let value=streams.get(id);if(!value){value={cursor:0,callbacks:new Set(),queue:Promise.resolve(),pending:false,draining:false};streams.set(id,value)}return value};
 const row=(sessionId:string):TerminalItem=>{
  const found=connection.snapshot.items.find((i):i is TerminalItem=>i.type==='term'&&i.sessionId===sessionId);
  if(!found)throw Object.assign(new Error('Terminal session no longer exists'),{code:'session-missing'});return found;
 };
 const serial=<T>(s:Stream,task:()=>Promise<T>):Promise<T>=>{const next=s.queue.catch(()=>{}).then(task);s.queue=next;return next};
 const reportExit=(id:string,code:number)=>{if(reportedExited.has(id))return;reportedExited.add(id);exits.emit({sessionId:id,exitCode:code})};
 async function drain(id:string){
  const s=stream(id);s.pending=true;if(s.draining||!s.callbacks.size)return;s.draining=true;
  try {
   while(s.pending&&s.callbacks.size){
    s.pending=false;
    await serial(s,async()=>{
     const result=await connection.api.call('terminals.read',{id:row(id).id,since:s.cursor,maxBytes:4*1024*1024});
     if(!s.callbacks.size)return;
     const bytes=decode(result.data);
     const data=result.reset?new TextEncoder().encode('\x1bc'+result.modes+new TextDecoder().decode(bytes)):bytes;
     s.cursor=result.seq;
     if(data.length)for(const cb of s.callbacks)cb({sessionId:id,data,replay:result.reset,seq:result.seq});
     windows.emit({sessionId:id,start:result.start,end:result.seq,reset:result.reset});
     if(result.exited)reportExit(id,result.exitCode??0);
    });
   }
  } catch(error){console.error('[terminal] stream read failed',error)}
  finally{s.draining=false}
 }
 const stop=connection.events.on(event=>{
  if(event.type==='snapshot')for(const [id,s] of streams){if(s.callbacks.size)void drain(id)}
  if(event.type==='terminal'){
   const item=connection.snapshot.items.find((i):i is TerminalItem=>i.type==='term'&&i.id===event.event.id);
   if(!item)return;
   if(event.event.type==='exit')reportExit(item.sessionId,event.event.exitCode);
   else if(streams.has(item.sessionId))void drain(item.sessionId);
  }
 });
 const meta=(item:TerminalItem)=>({shell:item.command,cwd:item.cwd,createdAt:item.createdAt,displayName:item.title,target:item.harness??'shell',cwdHostPath:item.cwd,agentSessionId:item.agentSessionId});
 return {
  async stopAll(){await connection.api.call('terminals.stopAll',{});await connection.refresh()},
  create,
  write(id,data){void connection.api.call('terminals.write',{id:row(id).id,bytes:bytesToBase64(new TextEncoder().encode(data))}).catch(error=>console.error('[terminal] input failed',error))},
  async resize(id,cols,rows){await connection.api.call('terminals.resize',{id:row(id).id,cols,rows})},
  async kill(id){await connection.api.call('terminals.close',{id:row(id).id});await connection.refresh()},
  async reconnect(id,cols,rows,_repoId,options){
   if(options?.machineId&&options.machineId!=='machine')throw new Error('This workspace operates on the installation machine only');
   const item=row(id),s=stream(id);
   return serial(s,async()=>{
    await connection.api.call('terminals.resize',{id:item.id,cols,rows});
    const reply=await connection.api.call('terminals.read',{id:item.id,since:options?.sinceSeq??0,maxBytes:options?.maxBytes});
    s.cursor=Math.max(s.cursor,reply.seq);
    return {sessionId:id,shell:item.command,displayName:item.title,target:item.harness??'shell',command:item.command,cwdHostPath:item.cwd,
     seq:reply.seq,scrollback:(reply.reset||!options?.sinceSeq?reply.modes:'')+new TextDecoder().decode(decode(reply.data)),scrollbackStart:reply.start,reset:reply.reset,exited:reply.exited,...(reply.exitCode!==null?{exitCode:reply.exitCode}:{})};
   });
  },
  async discover(){return connection.snapshot.items.filter((i):i is TerminalItem=>i.type==='term').map(i=>({sessionId:i.sessionId,meta:meta(i)}))},
  async readMeta(id){return meta(row(id))},
  async capture(id,lines){const result=await connection.api.call('terminals.read',{id:row(id).id,since:0});const text=new TextDecoder().decode(decode(result.data));return lines===undefined?text:text.split('\n').slice(-lines).join('\n')},
  async forgetRecord(id){const item=connection.snapshot.items.find(i=>i.type==='term'&&i.sessionId===id);if(item){await connection.api.call('terminals.close',{id:item.id});await connection.refresh()}},
  onData(id,cb){stream(id).callbacks.add(cb);void drain(id)},
  offData(id,cb){stream(id).callbacks.delete(cb)},
  onExit(id,cb){exitCallbacks.get(cb)?.();exitCallbacks.set(cb,exits.on(p=>{if(p.sessionId===id)cb(p)}))},
  offExit(_id,cb){exitCallbacks.get(cb)?.();exitCallbacks.delete(cb)},
  onAnyExit:exits.on,onSessionLost:lost.on,onStatusChanged:statuses.on,onWindow:windows.on,
  async stashFile(id,data,mime,name){
   const extension:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
   if(!name&&!extension[mime])throw new Error('Unsupported pasted image format');
   const file=await connection.api.call('files.upload',{directory:row(id).cwd,name:name??`pasted-${crypto.randomUUID()}.${extension[mime]}`,data});return {path:file.path};
  },
  dispose(){stop();for(const s of streams.values())s.callbacks.clear();streams.clear();exits.clear();statuses.clear();lost.clear();windows.clear();for(const off of exitCallbacks.values())off();exitCallbacks.clear()}
 };
}
