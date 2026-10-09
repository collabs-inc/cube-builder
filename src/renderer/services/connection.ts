import { moveFileDrafts } from './drafts';
import type { BuilderServices } from '../../web/services/types';
import type { BuilderSnapshot } from '../../shared/model';
import type { BuilderEvent } from '../../shared/events';

export class Signal<T extends unknown[]> {
 private listeners=new Set<(...args:T)=>void>();
 on=(callback:(...args:T)=>void)=>{this.listeners.add(callback);return ()=>{this.listeners.delete(callback)}};
 emit(...args:T) {for(const callback of this.listeners) callback(...args)}
 clear(){this.listeners.clear()}
}

/** One backend connection owned by Builder. No data or subscriptions live in its host. */
export class BuilderConnection {
 private current:BuilderSnapshot|null=null;
 private stop?:()=>void;
 private received=0;
 readonly changed=new Signal<[BuilderSnapshot]>();
 readonly events=new Signal<[BuilderEvent]>();
 readonly connected=new Signal<[boolean]>();
 constructor(readonly api:BuilderServices) {}
 get snapshot():BuilderSnapshot {if(!this.current)throw new Error('Builder is still connecting');return this.current}
 async start() {
  this.stop=this.api.subscribe(event=>{
   if(event.type==='snapshot') {this.received++;this.accept(event.snapshot)}
   this.events.emit(event);
  },state=>this.connected.emit(state));
  const before=this.received;
  const seed=await this.api.call('snapshot',{});
  if(this.received===before)this.accept(seed);
 }
 private accept(snapshot:BuilderSnapshot){
  if(this.current?.epoch===snapshot.epoch&&this.current.revision>=snapshot.revision)return;
  if(this.current?.epoch===snapshot.epoch)for(const next of snapshot.items){
   if(next.type==='term')continue;
   const old=this.current.items.find(item=>item.id===next.id);
   if(old&&old.type!=='term'&&old.filePath!==next.filePath)moveFileDrafts(old.filePath,next.filePath);
  }
  this.current=snapshot;this.changed.emit(snapshot);
 }
 async refresh(){const before=this.received;const value=await this.api.call('snapshot',{});if(this.received===before)this.accept(value);return this.snapshot}
 dispose(){this.stop?.();this.changed.clear();this.events.clear();this.connected.clear()}
}
