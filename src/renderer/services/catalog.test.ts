import { test,expect } from 'vitest';
import { BuilderConnection } from './connection';
import { createCatalogService } from './catalog';
import type { BuilderServices } from '../../web/services/types';
test('foreign catalog mutations never reach the backend',async()=>{
 let calls=0;
 const api={call:async()=>{calls++;throw Error('unexpected request')},subscribe:()=>()=>{}} as unknown as BuilderServices;
 const catalog=createCatalogService(new BuilderConnection(api),async()=>{throw Error('unexpected spawn')});
 await expect(catalog.addItem({machineId:'cloud-other',type:'term'})).rejects.toThrow('installation machine');
 await expect(catalog.removeItem('another','id')).rejects.toThrow('installation machine');
 await expect(catalog.reorder('another',{kind:'repos'},[])).rejects.toThrow('installation machine');
 expect(calls).toBe(0);
});
