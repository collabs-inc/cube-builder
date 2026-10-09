import { useState, useSyncExternalStore } from 'react';
import { ColumnBrowser } from '../sections/ColumnBrowser';
import { Dialog, DialogButton } from './Dialog';
import { services } from '../services';
import { Signal } from '../services/connection';

interface Request { home:string;resolve:(path:string|null)=>void }
let current:Request|null=null;
const changed=new Signal<[]>();
export function chooseFolder(home:string):Promise<string|null>{
 current?.resolve(null);
 return new Promise(resolve=>{current={home,resolve};changed.emit()});
}
function settle(path:string|null){const request=current;current=null;changed.emit();request?.resolve(path)}
function Picker({request}:{request:Request}) {
 const [path,setPath]=useState(request.home),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function accept(){setBusy(true);setError('');try{if(!await services.files.isDirectory(path))throw new Error('Choose a directory');settle(path)}catch(error){setError(error instanceof Error?error.message:String(error));setBusy(false)}}
 return <Dialog title="Choose a folder" size="lg" onClose={()=>settle(null)} actions={<><DialogButton onClick={()=>settle(null)}>Cancel</DialogButton><DialogButton variant="primary" disabled={busy} onClick={()=>void accept()}>Choose folder</DialogButton></>}>
  <label>Folder on this machine<input autoFocus style={{width:'100%'}} value={path} onChange={e=>setPath(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void accept()}}}/></label>
  <div style={{height:320,overflow:'auto'}}><ColumnBrowser roots={[{name:'Home',path:request.home,repoId:null},{name:'Filesystem',path:/^[A-Za-z]:/.test(request.home)?request.home.slice(0,2)+'/':'/',repoId:null}]} readDir={services.files.readDir} onPickFolder={setPath}/></div>
  {error&&<p role="alert">{error}</p>}
 </Dialog>;
}
export function FolderPickerHost(){const request=useSyncExternalStore(changed.on,()=>current);return request?<Picker request={request}/>:null}
