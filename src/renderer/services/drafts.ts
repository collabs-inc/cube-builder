import { FileDraft } from '../../web/items/file-draft';
import { defaultStorage } from './storage';

/** Persist immediately on editing, before the editor's debounced save. */
export class PersistentFileDraft extends FileDraft {
 constructor(private storage:Storage,private key:string){
  super();
  const raw=storage.getItem(key);
  if(raw)try{const data=JSON.parse(raw);if(typeof data.value==='string'&&(typeof data.revision==='string'||data.revision===null)){this.value=data.value;this.revision=data.revision;this.conflict=data.conflict===true}}catch{storage.setItem(key+'.corrupt',raw)}
 }
 private persist(){
  if(this.value===null)this.storage.removeItem(this.key);
  else this.storage.setItem(this.key,JSON.stringify({value:this.value,revision:this.revision,conflict:this.conflict}));
 }
 override edit(value:string){super.edit(value);this.persist()}
 override read(content:string,revision:string){const result=super.read(content,revision);this.persist();return result}
 override saved(value:string,revision:string){super.saved(value,revision);this.persist()}
 discard(){this.value=null;this.revision=null;this.conflict=false;this.persist()}
}
let namespace='builder-draft:';
const drafts=new Map<string,PersistentFileDraft>();
export function configureDrafts(epoch:string){namespace=`builder-draft:${epoch}:`;drafts.clear()}
export function fileDraft(path:string){const key=namespace+path;let value=drafts.get(key);if(!value){value=new PersistentFileDraft(defaultStorage(),key);drafts.set(key,value)}return value}
