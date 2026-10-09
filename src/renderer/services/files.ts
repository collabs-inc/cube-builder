import type { FilesService, FileStats } from './types';
import { BuilderConnection, Signal } from './connection';
import type { FsChangeEvent } from '@port/shared/types';
import type { FileDownloadState } from '@port/shared/file-download';
import { bytesToBase64 } from '../../web/services/assets';

const parent=(path:string)=>path.slice(0,Math.max(path.lastIndexOf('/'),path.lastIndexOf('\\'))) || '/';
const nameOf=(path:string)=>path.split(/[\\/]/).at(-1)!;
const join=(path:string,name:string)=>path.replace(/[\\/]$/,'')+'/'+name;
const date=(ms:number|undefined)=>new Date(ms??0).toISOString();

export function createFilesService(connection:BuilderConnection):FilesService & {dispose():void} {
 const renamed=new Signal<[string,string]>(),deleted=new Signal<[string[]]>(),changed=new Signal<[FsChangeEvent[]]>();
 const downloadsChanged=new Signal<[FileDownloadState[]]>();
 const downloads=new Map<string,{state:FileDownloadState;path:string;abort?:AbortController;url?:string}>();
 const states=()=>[...downloads.values()].map(d=>({...d.state}));
 const emitPath=(path:string,type:1|2|3=2)=>changed.emit([{dirPath:parent(path),changes:[{path,type}]}]);
 const stop=connection.events.on(event=>{if(event.type==='files')for(const path of event.paths)emitPath(path)});
 const preview=async(path:string)=>(await connection.api.call('previews.file',{path})).url;
 async function readDocument(path:string){
  const file=await connection.api.call('files.read',{path});
  return {content:file.content,stats:{ctime:date(file.modified),mtime:date(file.modified),revision:file.revision}};
 }
 async function move(path:string,destination:string){
  if(path===destination)return path;
  const info=await connection.api.call('files.stat',{path});
  const result=await connection.api.call('files.rename',{path,destination,revision:info.revision});
  await connection.refresh();renamed.emit(path,result.path);emitPath(path,3);emitPath(result.path,1);return result.path;
 }
 async function download(path:string,id:string=crypto.randomUUID()){
  const entry={path,state:{id,name:nameOf(path),phase:'preparing' as FileDownloadState['phase'],bytesReceived:0,bytesPerSecond:0},abort:new AbortController(),url:undefined as string|undefined};
  downloads.set(id,entry);downloadsChanged.emit(states());
  try {
   const {url}=await connection.api.call('downloads.create',{path});
   const response=await fetch(url,{signal:entry.abort.signal});if(!response.ok)throw new Error('Download failed');
   const disposition=response.headers.get('content-disposition');
   const encoded=disposition?.match(/filename\*=UTF-8''([^;]+)/)?.[1];if(encoded)entry.state.name=decodeURIComponent(encoded);
   entry.state.phase='downloading';downloadsChanged.emit(states());
   const reader=response.body!.getReader(),chunks:Uint8Array<ArrayBuffer>[]=[],start=Date.now();
   while(true){const part=await reader.read();if(part.done)break;chunks.push(part.value);entry.state.bytesReceived+=part.value.byteLength;entry.state.bytesPerSecond=entry.state.bytesReceived/Math.max(1,(Date.now()-start)/1000);downloadsChanged.emit(states())}
   entry.url=URL.createObjectURL(new Blob(chunks));
   const link=document.createElement('a');link.href=entry.url;link.download=entry.state.name;link.click();
   entry.state.phase='completed';downloadsChanged.emit(states());
  }catch(error){entry.state.phase='error';Object.assign(entry.state,{error:error instanceof Error?error.message:String(error)});downloadsChanged.emit(states())}
 }
 const service:FilesService & {dispose():void}={
  readDocument,
  async readFile(path){return (await readDocument(path)).content},
  async getFileStats(path):Promise<FileStats>{const s=await connection.api.call('files.stat',{path});return {ctime:date(s.modified),mtime:date(s.modified)}},
  async writeFile(path,content,revision){
   try{const saved=await connection.api.call('files.write',{path,content,revision:revision??null});emitPath(path);return {ok:true,mtime:date(saved.modified),revision:saved.revision}}
   catch(error){if((error as {code?:string}).code==='file-changed')return {ok:false,mtime:'',conflict:true};throw error}
  },
  async readDir(path){return (await connection.api.call('files.list',{path})).entries.map(entry=>({name:entry.name,isDirectory:entry.directory,isFile:!entry.directory,isSymlink:entry.symlink,createdAt:date(entry.modified),modifiedAt:date(entry.modified)}))},
  async readTree({root}){return connection.api.call('files.tree',{path:root})},
  async readFolderTable(path){return connection.api.call('files.table',{path})},
  async isDirectory(path){return (await connection.api.call('files.stat',{path})).directory},
  async createDir(path){await connection.api.call('files.mkdir',{path});emitPath(path,1)},
  async trashFile(path){const info=await connection.api.call('files.stat',{path});await connection.api.call('files.trash',{path,revision:info.revision});await connection.refresh();deleted.emit([path]);emitPath(path,3)},
  async renameFile(path,title){if(!title||/[\\/]/.test(title)||title==='.'||title==='..')throw new Error('Choose a file name without slashes');return move(path,join(parent(path),title))},
  async moveFile(path,directory){return move(path,join(directory,nameOf(path)))},
  async getImageThumbnail(path){return preview(path)},
  async getImageFull(path){const url=await preview(path);return {url,width:0,height:0}},
  previewUrl:preview,
  async resolveImagePath(reference,from){if(/^https?:\/\//.test(reference))return reference;return preview(reference.startsWith('/')?reference:join(parent(from),reference))},
  async saveDroppedImage(directory,name,buffer){const result=await connection.api.call('files.upload',{directory,name,data:bytesToBase64(new Uint8Array(buffer))});emitPath(result.path,1);return result.name},
  async importFile(directory,name,payload){
   if(!('contentBase64' in payload))throw new Error('Drop file contents into Builder to upload them to this machine');
   const result=await connection.api.call('files.upload',{directory,name,data:payload.contentBase64});emitPath(result.path,1);return result.path;
  },
  async importWebArticle(url,directory){const result=await connection.api.call('files.importArticle',{url,directory});emitPath(result.path,1);return result},
  onFileRenamed:renamed.on,onFilesDeleted:deleted.on,onFsChanged:changed.on,
  downloadFile:download,
  async listDownloads(){return states()},
  async cancelDownload(id){downloads.get(id)?.abort?.abort()},
  async retryDownload(id){const old=downloads.get(id);if(old){if(old.url)URL.revokeObjectURL(old.url);await download(old.path,id)}},
  async dismissDownload(id){const old=downloads.get(id);old?.abort?.abort();if(old?.url)URL.revokeObjectURL(old.url);downloads.delete(id);downloadsChanged.emit(states())},
  async revealDownload(id){const entry=downloads.get(id);if(entry?.url){const link=document.createElement('a');link.href=entry.url;link.download=entry.state.name;link.click()}},
  onDownloadsChanged:downloadsChanged.on,
  dispose(){stop();for(const entry of downloads.values()){entry.abort?.abort();if(entry.url)URL.revokeObjectURL(entry.url)}downloads.clear();renamed.clear();deleted.clear();changed.clear();downloadsChanged.clear()}
 };
 return service;
}
