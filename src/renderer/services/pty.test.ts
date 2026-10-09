import { test,expect } from 'vitest';
import { BuilderConnection } from './connection';
import { createPtyService } from './pty';
import type { BuilderServices } from '../../web/services/types';
import type { BuilderEvent } from '../../shared/events';
import type { BuilderSnapshot } from '../../shared/model';
const initial:BuilderSnapshot={epoch:'e',revision:1,repos:[],items:[{id:'item',type:'term',sessionId:'session',requestId:'r',repoId:null,cwd:'/home/test',title:'sh',command:'/bin/sh',args:[],exited:false,exitCode:null,createdAt:'2026-01-01',updatedAt:'2026-01-01'}],capabilities:{platform:'linux',home:'/home/test'}};
test('attach uses session identity, then drains missed bytes exactly once through the item API',async()=>{
 let deliver!:(event:BuilderEvent)=>void;
 const reads:number[]=[];
 let output='hello';
 const api={subscribe(cb:any){deliver=cb;return ()=>{}},async call(method:string,p:any){
  if(method==='snapshot')return initial;
  if(method==='terminals.resize')return null;
  if(method==='terminals.read'){if(p.maxBytes>1024*1024)throw Error('Invalid replay cursor or size');expect(p.id).toBe('item');reads.push(p.since);return {data:btoa(output.slice(p.since)),seq:output.length,start:p.since,reset:false,modes:'',exited:false,exitCode:null}}
  throw Error(method);
 }} as BuilderServices;
 const connection=new BuilderConnection(api);await connection.start();
 const pty=createPtyService(connection,async()=>{throw Error('unexpected spawn')});
 const attached=await pty.reconnect('session',80,24,undefined,{sinceSeq:0});
 expect(attached.scrollback).toBe('hello');
 output+=' world'; // produced before TerminalTab subscribes
 const chunks:string[]=[];
 pty.onData('session',p=>{chunks.push(new TextDecoder().decode(p.data))});
 await new Promise(r=>setTimeout(r,20));
 deliver({type:'terminal',event:{type:'data',id:'item',data:btoa(' world'),seq:11}});
 await new Promise(r=>setTimeout(r,20));
 expect(chunks.join('')).toBe(' world');
 expect(reads).toEqual([0,5,11]);
 pty.dispose();connection.dispose();
});
