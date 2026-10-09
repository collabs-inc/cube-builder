// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { act, useEffect, useRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setServices } from '../services';
import type { Services } from '../services/types';
import type { OwnedItem } from '@port/shared/catalog';
import { configureDrafts, fileDraft } from '../services/drafts';
import { FileItem } from './FileItem';

// Mirror Monaco's dirty unmount-save contract without testing its rendering.
vi.mock('@builder/components/CodeEditorView',()=>({CodeEditorView: function Editor(props:any){
 const current=useRef(props);current.current=props;
 const dirty=useRef<string|null>(null);
 useEffect(()=>()=>{if(dirty.current!==null)void current.current.onContentChange(dirty.current)},[]);
 return <textarea aria-label="Code" defaultValue={props.content} onChange={event=>{dirty.current=event.target.value;props.onDraftChange(event.target.value)}} />;
}}));
afterEach(()=>cleanup());
test('Reload from disk cannot resurrect a discarded dirty editor during unmount',async()=>{
 localStorage.clear();configureDrafts('discard-test');
 let content='original',revision='r1',notify:()=>void=()=>{};
 const write=vi.fn(async()=>({ok:true,mtime:'m',revision:'wrong'}));
 setServices({
  files:{readDocument:async()=>({content,stats:{mtime:'m',ctime:'c',revision}}),writeFile:write,onFsChanged:(callback:any)=>{notify=()=>callback([{dirPath:'/repo',changes:[{path:'/repo/code.ts',type:2}]}]);return()=>{};}},
  repos:{onStatus:()=>()=>{}},desktop:{capabilities:{images:true},clipboard:{writeText:async()=>{}}},
 } as unknown as Services);
 render(<FileItem item={{id:'code',machineId:'machine',type:'code',filePath:'/repo/code.ts',createdAt:'now'} as OwnedItem} />);
 const editor=await screen.findByRole('textbox',{name:'Code'});
 fireEvent.change(editor,{target:{value:'discard me'}});
 expect(fileDraft('/repo/code.ts').value).toBe('discard me');
 content='external content';revision='r2';await act(async()=>notify());
 fireEvent.click(await screen.findByRole('button',{name:'Reload from disk'}));
 await waitFor(()=>expect((screen.getByRole('textbox',{name:'Code'}) as HTMLTextAreaElement).value).toBe('external content'));
 expect(write).not.toHaveBeenCalled();expect(fileDraft('/repo/code.ts').value).toBe(null);
});
