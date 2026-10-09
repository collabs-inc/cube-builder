import {test,expect} from 'vitest';
import {BuilderConnection} from './connection';
import {createRepoServices} from './repos';
import type {BuilderServices} from '../../web/services/types';
test('reconnection reports installation readiness even without registered repositories',async()=>{
 const connection=new BuilderConnection({call:async()=>({epoch:'test',revision:0,repos:[],items:[],capabilities:{platform:'linux',home:'/home/test'}}),subscribe:()=>()=>{}} as unknown as BuilderServices);
 await connection.start();
 const {repos}=createRepoServices(connection,async()=>null),seen:unknown[]=[];
 const stop=repos.onStatus(event=>seen.push(event));
 connection.connected.emit(false);connection.connected.emit(true);
 expect(seen).toEqual([{repoId:'machine',status:'connecting'},{repoId:'machine',status:'open'}]);
 stop();connection.dispose();
});
