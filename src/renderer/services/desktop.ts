import { Signal, type BuilderConnection } from './connection';
import { createPrefsApi } from './prefs';
import { createContextMenuController, isContextMenuOpen } from './context-menu/ContextMenu';
import { detectPlatform, isDarkMode, resolveShortcut } from './browser-shortcuts';
import type { DesktopService, AgentActivityEvent } from './types';
import type { LaunchChoice } from '@port/shared/launch-menu';
import { requireInstallation } from './catalog';
import { copyText } from '../../web/services/clipboard';

export function createDesktopService(connection:BuilderConnection,openFolder:()=>Promise<string|null>):DesktopService & {dispose():void} {
 const prefs=createPrefsApi(),platform=detectPlatform();
 const files=new Signal<[string|null]>(),folders=new Signal<[string]>(),terminals=new Signal<[string,LaunchChoice?]>();
 const shortcuts=new Signal<[string]>(),settings=new Signal<['open'|'close',string|null]>(),drag=new Signal<[boolean]>(),agents=new Signal<[AgentActivityEvent]>();
 const menu=createContextMenuController(document,platform);
 let settingsOpen=false,paths:string[]=[],theme='system';
 const media=window.matchMedia('(prefers-color-scheme: dark)');
 const applyTheme=()=>{const dark=isDarkMode(theme,media.matches);document.documentElement.classList.toggle('dark',dark);document.documentElement.style.colorScheme=dark?'dark':'light'};
 const setSettings=(open:boolean,pane:string|null=null)=>{settingsOpen=open;settings.emit(open?'open':'close',pane)};
 const keydown=(event:KeyboardEvent)=>{
  if(event.defaultPrevented||event.isComposing||isContextMenuOpen())return;
  const action=resolveShortcut(event,platform);if(!action)return;
  // Dialogs own editing keys; settings can always be closed with its shortcut.
  if(document.querySelector('[aria-modal="true"]')&&action!=='toggle-settings')return;
  event.preventDefault();
  if(action==='toggle-settings')setSettings(!settingsOpen);else shortcuts.emit(action);
 };
 window.addEventListener('keydown',keydown,true);media.addEventListener('change',applyTheme);
 const queryTheme=new URLSearchParams(location.search).get('theme');
 void prefs.getPref('theme').then(value=>{theme=queryTheme??(typeof value==='string'?value:'system');applyTheme()});
 return {
  capabilities:{localRepos:true,images:true,nativeMenus:false,updater:false,revealInFinder:false,folderPicker:true},
  getPlatform:()=>platform,getConfig:prefs.getConfig,getAppVersion:prefs.getAppVersion,getDeviceId:prefs.getDeviceId,
  async listTerminalTargets(machineId){if(machineId)requireInstallation(machineId);return connection.api.call('terminals.targets',{})},
  selectFile:path=>files.emit(path),selectFolder:path=>folders.emit(path),openInTerminal:(path,choice)=>terminals.emit(path,choice),
  revealInFinder(){throw new Error('Use Browse files to view files on the installation machine')},
  onFileSelected:files.on,onFolderSelected:folders.on,onOpenTerminal:terminals.on,
  showContextMenu:items=>menu.show(items),openFolder,
  openExternal(url){const parsed=new URL(url,location.href);if(!['http:','https:','mailto:'].includes(parsed.protocol))throw new Error('Unsupported URL');window.open(parsed.href,'_blank','noopener,noreferrer')},
  onShortcut:shortcuts.on,onSettingsToggle:settings.on,
  openSettings:pane=>setSettings(true,pane??null),closeSettings:()=>setSettings(false),toggleSettings:()=>setSettings(!settingsOpen),
  onLoadingDone(callback){let active=true;queueMicrotask(()=>{if(active)callback()});return ()=>{active=false}},
  async setTheme(mode){theme=mode;applyTheme();await prefs.setPref('theme',mode)},
  // A browser File names bytes on the viewer's machine, never a backend path.
  getPathForFile:()=>'',
  dragPaths:{set(next){paths=[...next];drag.emit(paths.length>0)},clear(){paths=[];drag.emit(false)},async get(){return [...paths]}},
  onNavDragActive:drag.on,onAgentEvent:agents.on,
  onShellBlur(callback){window.addEventListener('blur',callback);return ()=>window.removeEventListener('blur',callback)},
  clipboard:{writeText:copyText},
  dispose(){window.removeEventListener('keydown',keydown,true);media.removeEventListener('change',applyTheme);menu.dispose();for(const signal of [files,folders,terminals,shortcuts,settings,drag,agents])signal.clear()}
 };
}
