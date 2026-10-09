import { expect,test } from 'vitest';
import { PersistentFileDraft } from './drafts';
import { createMemoryStorage } from './storage';
test('reload restores unsaved bytes and their base revision; disk conflict cannot advance the base',async()=>{
 const storage=createMemoryStorage();
 const first=new PersistentFileDraft(storage,'file');first.read('original','r1');first.edit('unsaved');
 const restored=new PersistentFileDraft(storage,'file');expect(restored.value).toBe('unsaved');expect(restored.revision).toBe('r1');
 expect(restored.read('agent edit','r2')).toBe(false);expect(restored.conflict).toBe(true);
 expect(await restored.save('unsaved',async()=>{throw Error('must not write')})).toBe(false);
 expect(new PersistentFileDraft(storage,'file').value).toBe('unsaved');
});
test('completed save preserves newer typing durably and clears only the saved version',async()=>{
 const storage=createMemoryStorage(),draft=new PersistentFileDraft(storage,'file');draft.read('base','r1');draft.edit('first');
 let release!:(v:string)=>void;
 const pending=draft.save('first',()=>new Promise<string>(r=>{release=r}));await Promise.resolve();
 draft.edit('second');release('r2');await pending;
 const restored=new PersistentFileDraft(storage,'file');expect(restored.value).toBe('second');expect(restored.revision).toBe('r2');
 await restored.save('second',async()=> 'r3');expect(new PersistentFileDraft(storage,'file').value).toBe(null);
});
test('reload after the server saved but before its reply acknowledges matching disk bytes',async()=>{
 const storage=createMemoryStorage(),draft=new PersistentFileDraft(storage,'file');
 draft.read('original','r1');draft.edit('saved before disconnect');
 const restored=new PersistentFileDraft(storage,'file');
 expect(restored.read('saved before disconnect','r2')).toBe(true);
 expect(restored.value).toBe(null);expect(restored.revision).toBe('r2');
 restored.edit('next edit');
 await restored.save('next edit',async revision=>{expect(revision).toBe('r2');return 'r3'});
 expect(restored.conflict).toBe(false);
});
