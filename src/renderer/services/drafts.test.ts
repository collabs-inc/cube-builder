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
test('quota errors preserve memory and do not prevent autosave',async()=>{
 const storage=createMemoryStorage();storage.setItem=()=>{throw new DOMException('Full','QuotaExceededError')};
 const draft=new PersistentFileDraft(storage,'file');draft.read('base','r1');
 expect(()=>draft.edit('typing')).not.toThrow();expect(draft.value).toBe('typing');expect(draft.persistenceError).toBe(true);
 await draft.save('typing',async revision=>{expect(revision).toBe('r1');return 'r2'});expect(draft.value).toBe(null);
});
test('rename carries the base revision, pending saves, and persisted bytes to the new path',async()=>{
 const storage=createMemoryStorage(),draft=new PersistentFileDraft(storage,'old','/old');draft.read('base','r1');draft.edit('typing');
 const paused=draft.pauseSaves();await paused.ready;
 const pending=draft.save('typing',async revision=>{expect(draft.path).toBe('/new');expect(revision).toBe('r1');return 'r2'});
 draft.retarget('new','/new');expect(storage.getItem('old')).toBe(null);expect(new PersistentFileDraft(storage,'new').value).toBe('typing');
 paused.resume();await pending;expect(draft.revision).toBe('r2');
});
test('discard invalidates queued writes and old completion without resurrecting text',async()=>{
 const draft=new PersistentFileDraft(createMemoryStorage(),'file');draft.read('base','r1');draft.edit('old');
 let finish!:(value:string)=>void;
 const first=draft.save('old',()=>new Promise<string>(resolve=>{finish=resolve}));await Promise.resolve();
 let wrote=false;const second=draft.save('obsolete',async()=>{wrote=true;return 'bad'});
 draft.invalidate();finish('r2');await draft.settled();draft.discard();
 expect(await first).toBe(false);expect(await second).toBe(false);expect(wrote).toBe(false);
 expect(draft.read('external','r3')).toBe(true);expect(draft.value).toBe(null);
});
test('duplicate rename notification cannot replace the migrated draft with a stale empty path',async()=>{
 const {configureDrafts,fileDraft,moveFileDrafts}=await import('./drafts');
 configureDrafts('repeat-rename');const draft=fileDraft('/old');draft.read('disk','r1');draft.edit('unsaved');
 moveFileDrafts('/old','/new');
 // React may render with its previous loadedPath before the load effect runs.
 fileDraft('/old');moveFileDrafts('/old','/new');
 expect(fileDraft('/new')).toBe(draft);expect(fileDraft('/new').value).toBe('unsaved');
});
