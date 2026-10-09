import { createRoot } from 'react-dom/client';
import { createBrowserServices } from './services/browser';
import { setServices } from './services';
import '../theme/styles.css';
import './App.css';
import './items/pane-chrome.css';

async function boot(){
 document.documentElement.classList.add('web-host');
 try {
  const backend=await createBrowserServices();
  setServices(backend);
  const {default:App}=await import('./App');
  createRoot(document.getElementById('root')!).render(<App/>);
  window.addEventListener('pagehide',()=>backend.dispose(),{once:true});
 }catch(error){
  const root=document.getElementById('root')!;
  const message=document.createElement('p');message.textContent=error instanceof Error?error.message:String(error);
  const retry=document.createElement('button');retry.textContent='Reconnect';retry.onclick=()=>location.reload();
  root.replaceChildren(message,retry);
 }
}
void boot();
