import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startServer } from '../../src/server/http.js';
import { ensureWorker } from '../../src/server/worker-runtime.js';
const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'builder-browser-'));
const repo = join(root, 'project'), stateDir = join(root, 'state');
await mkdir(repo);
// The original Add Repo workflow starts its default agent. Keep that workflow
// under test without invoking installed CLIs or using a developer account.
const fixtureBin=join(root,'bin');await mkdir(fixtureBin);
await writeFile(join(fixtureBin,'claude'),'#!/bin/sh\nexec /bin/sh\n',{mode:0o700});
process.env.PATH=fixtureBin+':'+process.env.PATH;
await writeFile(join(root, 'uploaded.txt'), 'Uploaded from browser.');
await exec('git', ['init', '-b', 'main', repo]);
await writeFile(join(repo, 'note.md'), '# Browser test\n\nInitial text.\n');
await writeFile(join(repo,'code.ts'),'const original = true;\n');
await writeFile(join(repo, 'picture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
await writeFile(join(repo, 'fixture.json'), '{"message":"resource loaded"}');
await writeFile(join(repo, 'preview.html'), `<!doctype html><title>Sandbox fixture</title><h1>Preview ready</h1><p id="status">loading</p><script type="module" src="./preview.js"></script>`);
await writeFile(join(repo, 'preview.js'), `const result = []; try { result.push((await (await fetch('./fixture.json')).json()).message); } catch { result.push('resource failed'); }
try { const r = await fetch('/api', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'attack',method:'files.mkdir',params:{path:${JSON.stringify(join(repo, 'attacked'))}}})}); result.push(r.ok ? 'API EXPOSED' : 'API blocked'); } catch { result.push('API blocked'); }
await new Promise(resolve => { const ws = new WebSocket(location.origin.replace('http','ws')+'/events'); ws.onopen = () => {result.push('WS EXPOSED');ws.close();resolve();}; ws.onerror = () => {result.push('WS blocked');resolve();}; }); document.querySelector('#status').textContent = result.join(';');`);
// Small valid PDF, with computed byte offsets rather than a browser-specific fixture.
let pdf = '%PDF-1.4\n'; const offsets = [0];
const pdfText='BT /F1 18 Tf 20 100 Td (PDF preview ready) Tj ET';
const pdfObjects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(pdfText)} >>\nstream\n${pdfText}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
for (const [i, body] of pdfObjects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; }
const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${pdfObjects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${pdfObjects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(join(repo, 'document.pdf'), pdf);
await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
let app = await startServer({ port: 0, stateDir, webRoot: resolve('dist/web') });
const port = app.port, base = `http://127.0.0.1:${port}`, session = `builder-acceptance-${process.pid}`;
const worker = await ensureWorker(stateDir);

const parent = createServer((_req, res) => res.end(`<html><body style="margin:0"><iframe title="Builder" src="${base}" style="border:0;width:100vw;height:100vh"></iframe></body></html>`));
parent.listen(0, '127.0.0.1'); await once(parent, 'listening');
const parentBase = `http://127.0.0.1:${(parent.address() as {port:number}).port}`;
let runtimeId:string|undefined;
let ciBrowser: import('playwright').Browser | undefined;
let ciPage: import('playwright').Page | undefined;
const command = async (...args: string[]) => {
  if (process.env.BUILDER_BROWSER_DRIVER === 'playwright') {
    if (args[0] === 'close') { await ciBrowser?.close(); ciBrowser = undefined; return; }
    if (!ciBrowser) { const { chromium } = await import('playwright'); ciBrowser = await chromium.launch(); ciPage = await ciBrowser.newPage({ viewport: { width: 1280, height: 800 } });ciPage.on('dialog',dialog=>void dialog.accept()); }
    if (args[0] === 'open') await ciPage!.goto(args[1]!);
    else if (args[0] === 'run-code') console.log(await new Function(`return (${args[1]})`)()(ciPage));
    else if (args[0] === 'screenshot') {
      await mkdir('test-results', { recursive: true }); console.log('Capturing browser diagnostics');
      try { await ciPage!.screenshot({ path: `test-results/browser-${Date.now()}.png`, timeout: 5000 }); } catch (error) { console.warn('Optional screenshot unavailable:', String(error)); }
      console.log('Browser diagnostics complete');
    }
    return;
  }
  const result = await exec('cube-browser', ['--session', session, ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  runtimeId=result.stdout.match(/Browser output directory: .*\/([^/\n]+)\s*$/)?.[1]??runtimeId;
  if (result.stdout.trim()) console.log(result.stdout.trim());
};
const run = async (body: string) => command('run-code', `async page => { page.setDefaultTimeout(10000); const repo = ${JSON.stringify(repo)}; const base = ${JSON.stringify(base)}; ${body} }`);
const acceptBeforeUnload=async()=>{
 if(ciPage)return;
 if(!runtimeId)throw Error('Browser runtime missing');
 const {runtimePaths,lockRuntime,runCli}=await import('/opt/cube/browser/runtime.mjs' as string);
 const paths=runtimePaths(runtimeId),unlock=await lockRuntime(paths,10000);
 try{await runCli(paths,['dialog-accept'],10000);}finally{await unlock();}
};
const reload=async()=>{await run('await page.reload();');await acceptBeforeUnload();};
const api = async (method: string, params: unknown = {}) => { const r = await fetch(base + '/api', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'test', method, params }) }); const data = await r.json() as any; if (!data.ok) throw new Error(JSON.stringify(data)); return data.result; };
try {
  await command('open',base);
  await run(`await page.evaluate(()=>localStorage.setItem('pref:terminalTarget',JSON.stringify('shell')));
    await page.locator('.sidebar-add-repo').click(); await page.getByRole('menuitem',{name:'Add existing repo…',exact:true}).click();
    await page.getByRole('button',{name:'Choose folder…',exact:true}).click();
    await page.getByLabel('Folder on this machine',{exact:true}).fill(repo);
    await page.getByRole('button',{name:'Choose folder',exact:true}).click();
    await page.locator('.mini-repo-row').filter({hasText:'project'}).waitFor();
    await page.getByRole('textbox',{name:'Terminal input',exact:true}).first().focus();
    await page.keyboard.type("printf 'BROWSER_%s' LIVE_OUTPUT");await page.keyboard.press('Enter');
    await page.locator('.xterm-accessibility-tree').filter({hasText:'BROWSER_LIVE_OUTPUT'}).first().waitFor();return 'original add-repo and live terminal output';`);
  let terminal:any;for(let n=0;n<100;n++){terminal=(await api('snapshot')).items.find((i:any)=>i.type==='term');if(terminal)break;await new Promise(r=>setTimeout(r,100));} if(!terminal)console.error('Fixture catalog',await api('snapshot'),'owned sessions',await worker.list());assert.ok(terminal);
  const pid=(await worker.list()).find(s=>s.id===terminal.sessionId)!.pid;
  await run(`await page.getByRole('tab').first().click({button:'right'});await page.getByRole('menuitem',{name:'Name screen…',exact:true}).click();
    await page.locator('[role=tablist] input').fill('Apps');await page.locator('[role=tablist] input').press('Enter');
    await page.locator('.workspace-navigation [title="preview.html"]').first().click();
    await page.frameLocator('iframe[title="preview.html"]:visible').first().getByText('resource loaded;API blocked;WS blocked',{exact:true}).waitFor();return 'named screen and sandboxed artifact';`);
  await assert.rejects(stat(join(repo,'attacked')),{code:'ENOENT'});
  const browse=`await page.locator('.mini-repo-row').filter({hasText:'project'}).first().hover();await page.locator('.mini-repo-row').filter({hasText:'project'}).first().getByRole('button',{name:'Browse files',exact:true}).click();`;
  const openNote=`${browse}await page.locator('.collection-item-row').filter({hasText:'note.md'}).dblclick();await page.locator('.bn-editor').waitFor();`;
  await run(`${openNote}await page.locator('.bn-editor').click();await page.keyboard.press('Control+End');await page.keyboard.type('Saved from browser.');await page.getByRole('tab',{name:'Apps',exact:true}).click();
    await page.waitForFunction(async path=>{const r=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'read',method:'files.read',params:{path}})});return (await r.json()).result.content.includes('Saved from browser.');},repo+'/note.md');return 'original rich editor saved';`);
  assert.match(await readFile(join(repo,'note.md'),'utf8'),/Saved from browser/);
  await run(`await page.route('**/api',async route=>{const data=route.request().postDataJSON();if(data?.method==='files.write')await route.abort();else await route.continue();});
    await page.locator('.bn-editor').click();await page.keyboard.press('Control+End');await page.keyboard.type('Immediate local draft.');
    if(!await page.evaluate(()=>Object.entries(localStorage).some(([key,value])=>key.startsWith('builder-draft:')&&value.includes('Immediate local draft.'))))throw Error('draft not durable');return 'draft persisted before save';`);
  await reload();
  await run(`await page.locator('.bn-editor').getByText('Immediate local draft.',{exact:true}).waitFor();if(!(await page.locator('.bn-editor').innerText()).includes('Saved from browser.'))throw Error('saved text lost');await page.unrouteAll();await page.getByRole('tab',{name:'Apps',exact:true}).waitFor();return 'draft and layout restored';`);
  await writeFile(join(repo,'note.md'),'# Agent change\n\nExternal wins until explicitly resolved.\n');
  await run(`await page.getByRole('button',{name:'Copy draft',exact:true}).waitFor();await page.getByRole('button',{name:'Reload from disk',exact:true}).click();await page.locator('.bn-editor').getByText('External wins until explicitly resolved.',{exact:true}).waitFor();return 'external conflict preserved, explicit reload works';`);
  assert.doesNotMatch(await readFile(join(repo,'note.md'),'utf8'),/Immediate local draft/);
  await run(`await page.route('**/api',async route=>{if(route.request().postDataJSON()?.method==='files.write')await route.abort();else await route.continue();});
    await page.locator('.bn-editor').click();await page.keyboard.press('Control+End');await page.keyboard.type('Draft survives rename.');
    await page.getByRole('textbox',{name:'Item title',exact:true}).fill('renamed.md');await page.getByRole('tab',{name:'Apps',exact:true}).click();
    await page.waitForFunction(path=>Object.entries(localStorage).some(([key,value])=>key.endsWith(path)&&value.includes('Draft survives rename.')),repo+'/renamed.md');return 'dirty title rename retained draft';`);
  await reload();
  await run(`await page.locator('.bn-editor').getByText('Draft survives rename.',{exact:false}).waitFor();await page.unrouteAll();
    await page.locator('.bn-editor').click();await page.keyboard.press('Control+End');await page.keyboard.type('Saved at renamed path.');await page.getByRole('tab',{name:'Apps',exact:true}).click();
    await page.waitForFunction(async path=>{const r=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'read',method:'files.read',params:{path}})});return (await r.json()).result.content.includes('Saved at renamed path.');},repo+'/renamed.md');return 'renamed draft saved after reload';`);
  assert.match(await readFile(join(repo,'renamed.md'),'utf8'),/Draft survives rename/);await assert.rejects(stat(join(repo,'note.md')),{code:'ENOENT'});
  await run(`${browse}await page.locator('.collection-item-row').filter({hasText:'code.ts'}).dblclick();await page.locator('.monaco-editor .view-lines').first().click({position:{x:40,y:8}});
    await page.route('**/api',async route=>{if(route.request().postDataJSON()?.method==='files.write')await route.abort();else await route.continue();});
    await page.keyboard.press('Control+A');await page.keyboard.type('const discarded = true;');
    await page.waitForFunction(()=>Object.values(localStorage).some(value=>value.includes('const discarded = true;')));return 'real Monaco dirty editor';`);
  await writeFile(join(repo,'code.ts'),'const external = true;\n');
  await run(`await page.getByRole('button',{name:'Reload from disk',exact:true}).click();
    await page.locator('.monaco-editor .view-lines').getByText('const external = true;',{exact:false}).waitFor();await page.unrouteAll();return 'Monaco discard does not save during unmount';`);
  assert.equal(await readFile(join(repo,'code.ts'),'utf8'),'const external = true;\n');
  await run(`${browse}const row=page.locator('.collection-folder-row').first();await row.evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['Uploaded from browser.'],'uploaded.txt',{type:'text/plain'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));});
    ${browse}await page.locator('.collection-item-row').filter({hasText:'uploaded.txt'}).waitFor();
    await page.locator('.collection-item-row').filter({hasText:'picture.png'}).dblclick();await page.waitForFunction(()=>[...document.querySelectorAll('img')].some(i=>i.naturalWidth===1));
    ${browse}await page.locator('.collection-item-row').filter({hasText:'document.pdf'}).dblclick();const pdfFrame=page.locator('iframe[title="'+repo+'/document.pdf"]');await pdfFrame.waitFor();
    if(await pdfFrame.getAttribute('sandbox')!==null)throw Error('Native PDF viewer is sandbox-disabled');
    await page.waitForFunction(path=>[...document.querySelectorAll('iframe')].some(frame=>frame.title===path&&frame.getAttribute('src')),repo+'/document.pdf');
    const documentUrl=await pdfFrame.evaluate(frame=>frame.src);const documentResponse=await page.request.get(documentUrl);
    if(documentResponse.headers()['content-type']!=='application/pdf'||documentResponse.headers()['content-security-policy']?.includes('sandbox'))throw Error('PDF response disables native rendering');
    if(!(await documentResponse.text()).startsWith('%PDF-'))throw Error('PDF capability did not return a PDF');return 'file drop, image and native PDF response';`);
  assert.equal(await readFile(join(repo,'uploaded.txt'),'utf8'),'Uploaded from browser.');
  await run(`await page.locator('.mini-repo-row').filter({hasText:'project'}).first().click({button:'right'});await page.getByRole('menuitem',{name:'New worktree…',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('browser-branch');await page.getByRole('button',{name:'Create worktree',exact:true}).click();return 'original worktree dialog submitted';`);
  let snapshot:any;
  for(let n=0;n<150;n++){snapshot=await api('snapshot');if(snapshot.repos[0]?.worktrees.some((w:any)=>w.branch==='browser-branch'&&!w.creation))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(snapshot.repos[0]?.worktrees.some((w:any)=>w.branch==='browser-branch'&&!w.creation),'worktree must become ready');
  await run(`const pane=page.locator('.rail-pane').filter({has:page.locator('.terminal-tab')}).first();await pane.getByRole('button',{name:'Hide',exact:true}).click();if(!await page.locator('.terminal-tab').count())throw Error('hide unmounted terminal');await page.getByTitle(repo,{exact:true}).first().click();return 'hidden terminal retained';`);
  await command('screenshot');
  await app.close();app=await startServer({port,stateDir,webRoot:resolve('dist/web')});
  await reload();
  await run(`await page.getByTitle(repo,{exact:true}).first().click();await page.getByRole('textbox',{name:'Terminal input',exact:true}).first().focus();await page.keyboard.type("printf 'AFTER_%s' RESTART_OUTPUT");await page.keyboard.press('Enter');
    await page.locator('.xterm-accessibility-tree').filter({hasText:'AFTER_RESTART_OUTPUT'}).first().waitFor();
    await page.waitForFunction(async id=>{const r=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'read',method:'terminals.read',params:{id,since:0}})});return atob((await r.json()).result.data).includes('AFTER_RESTART_OUTPUT');},${JSON.stringify(terminal.id)});return 'backend and page restart retained terminal';`);
  assert.equal((await worker.list()).find(s=>s.id===terminal.sessionId)!.pid,pid);
  await run(`await page.keyboard.press('Control+,');await page.getByRole('button',{name:'Appearance',exact:true}).click();await page.getByRole('radio',{name:'dark',exact:true}).click();await page.getByRole('button',{name:'Close',exact:true}).click();await page.setViewportSize({width:390,height:844});await page.getByRole('textbox',{name:'Terminal input',exact:true}).first().waitFor({state:'visible'});return 'original settings and narrow layout';`);
  await command('screenshot');
  await run(`await page.setViewportSize({width:1280,height:800});await page.evaluate(url=>{location.href=url;},${JSON.stringify(parentBase)});`);
  await acceptBeforeUnload();
  await run(`const child=page.frameLocator('iframe[title=Builder]');await child.locator('.workspace-navigation [title="preview.html"]').first().click();await child.frameLocator('iframe[title="preview.html"]:visible').first().getByText('resource loaded;API blocked;WS blocked',{exact:true}).waitFor();return 'standalone app in ordinary parent iframe';`);
  console.log('PASS: original Builder browser workflows, durable drafts, sessions and preview isolation');
} catch(error){console.error(error);await run("return await page.evaluate(()=>({editors:[...document.querySelectorAll('.bn-editor')].map(el=>el.textContent),drafts:Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('builder-draft:')))}));").catch(()=>{});await command('screenshot').catch(()=>{});throw error;}
finally{parent.close();await command('close').catch(()=>{});await worker.stopAll();worker.disconnect();await app.close();await rm(root,{recursive:true,force:true});}
