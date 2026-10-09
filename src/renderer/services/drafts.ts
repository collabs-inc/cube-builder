import { useSyncExternalStore } from 'react';
import { FileDraft } from '../../web/items/file-draft';
import { defaultStorage, getStorage } from './storage';
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}};

/** Persist immediately on editing, before the editor's debounced save. */
export class PersistentFileDraft extends FileDraft {
 persistenceError=false;
 constructor(private storage:Storage,private key:string,public path?:string,private durable=true){
  super();
  try {
   const raw=storage.getItem(key);
   if(raw){const data=JSON.parse(raw);if(typeof data.value==='string'&&(typeof data.revision==='string'||data.revision===null)){this.value=data.value;this.revision=data.revision;this.conflict=data.conflict===true}}
  }catch{this.persistenceError=true}
 }
 private persist():boolean {
  let failed=false;
  try {
   if(this.value===null)this.storage.removeItem(this.key);
   else if(!this.durable)failed=true;
   else this.storage.setItem(this.key,JSON.stringify({value:this.value,revision:this.revision,conflict:this.conflict}));
  }catch{failed=true}
  if(failed!==this.persistenceError){this.persistenceError=failed;for(const listener of listeners)listener()}
  return !failed;
 }
 override edit(value:string){super.edit(value);this.persist()}
 override read(content:string,revision:string){const result=super.read(content,revision);this.persist();return result}
 override saved(value:string,revision:string){super.saved(value,revision);this.persist()}
 discard(){this.invalidate();this.value=null;this.revision=null;this.conflict=false;this.persist()}
 retarget(key:string,path:string){
  const previous=this.key;this.key=key;this.path=path;
  if(this.persist())try{this.storage.removeItem(previous)}catch{ /* Keep the recoverable old copy if storage refuses removal. */ }
 }
}
let namespace='builder-draft:';
const drafts=new Map<string,PersistentFileDraft>();
export function configureDrafts(epoch:string){namespace=`builder-draft:${epoch}:`;drafts.clear()}
export function fileDraft(path:string){const key=namespace+path;let value=drafts.get(key);if(!value){value=new PersistentFileDraft(defaultStorage(),key,path,getStorage()!==null);drafts.set(key,value)}return value}
export function useDraftPersistenceError(path:string|null){return useSyncExternalStore(subscribe,()=>path?fileDraft(path).persistenceError:false)}
const within=(root:string,path:string)=>path===root||path.startsWith(root.replace(/\/$/,'')+'/');
/** Preserve drafts before a catalog rename notification reaches any editor. */
export function moveFileDrafts(from:string,to:string){
 if(from===to)return;
 const storage=defaultStorage();
 // Include persisted drafts whose panes have not mounted in this page yet.
 try{for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith(namespace)&&within(from,key.slice(namespace.length)))fileDraft(key.slice(namespace.length))}}catch{ /* Mounted drafts can still move in memory. */ }
 for(const [key,draft] of [...drafts]){
  const path=key.slice(namespace.length);if(!within(from,path))continue;
  const next=to+path.slice(from.length);
  // The snapshot and rename reply can both report this move. Between them,
  // an editor render may request the old path before its effect switches.
  // That empty placeholder must not erase the already-migrated draft.
  if(drafts.has(namespace+next)&&draft.value===null){draft.invalidate();drafts.delete(key);continue}
  draft.retarget(namespace+next,next);drafts.delete(key);drafts.set(namespace+next,draft);
 }
}
/** Edits continue in memory while an explicit rename waits for prior writes. */
export function pauseFileDraftSaves(path:string){
 const paused=[...drafts.values()].filter(draft=>draft.path&&within(path,draft.path)).map(draft=>draft.pauseSaves());
 return {ready:Promise.all(paused.map(p=>p.ready)),resume(){for(const pause of paused)pause.resume()}};
}
