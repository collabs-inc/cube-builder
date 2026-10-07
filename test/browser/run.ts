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
await writeFile(join(root, 'uploaded.txt'), 'Uploaded from browser.');
await exec('git', ['init', '-b', 'main', repo]);
await writeFile(join(repo, 'note.md'), '# Browser test\n\nInitial text.\n');
await writeFile(join(repo, 'picture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
await writeFile(join(repo, 'fixture.json'), '{"message":"resource loaded"}');
await writeFile(join(repo, 'preview.html'), `<!doctype html><title>Sandbox fixture</title><h1>Preview ready</h1><p id="status">loading</p><script type="module" src="./preview.js"></script>`);
await writeFile(join(repo, 'preview.js'), `const result = []; try { result.push((await (await fetch('./fixture.json')).json()).message); } catch { result.push('resource failed'); }
try { const r = await fetch('/api', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'attack',method:'files.mkdir',params:{path:${JSON.stringify(join(repo, 'attacked'))}}})}); result.push(r.ok ? 'API EXPOSED' : 'API blocked'); } catch { result.push('API blocked'); }
await new Promise(resolve => { const ws = new WebSocket(location.origin.replace('http','ws')+'/events'); ws.onopen = () => {result.push('WS EXPOSED');ws.close();resolve();}; ws.onerror = () => {result.push('WS blocked');resolve();}; }); document.querySelector('#status').textContent = result.join(';');`);
// Small valid PDF, with computed byte offsets rather than a browser-specific fixture.
let pdf = '%PDF-1.4\n'; const offsets = [0];
for (const [i, body] of ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'].entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; }
const xref = Buffer.byteLength(pdf); pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(join(repo, 'document.pdf'), pdf);
await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
let app = await startServer({ port: 0, stateDir, webRoot: resolve('dist/web') });
const port = app.port, base = `http://127.0.0.1:${port}`, session = `builder-acceptance-${process.pid}`;
const worker = await ensureWorker(stateDir);
const parent = createServer((_req, res) => res.end(`<html><body style="margin:0"><iframe title="Builder" src="${base}" style="border:0;width:100vw;height:100vh"></iframe></body></html>`));
parent.listen(0, '127.0.0.1'); await once(parent, 'listening');
const parentBase = `http://127.0.0.1:${(parent.address() as {port:number}).port}`;
const command = async (...args: string[]) => { const result = await exec('cube-browser', ['--session', session, ...args], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }); if (result.stdout.trim()) console.log(result.stdout.trim()); };
const run = async (body: string) => command('run-code', `async page => { page.setDefaultTimeout(10000); const repo = ${JSON.stringify(repo)}; const base = ${JSON.stringify(base)}; ${body} }`);
const api = async (method: string, params: unknown = {}) => { const r = await fetch(base + '/api', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'test', method, params }) }); const data = await r.json() as any; if (!data.ok) throw new Error(JSON.stringify(data)); return data.result; };
try {
  await command('open', base);
  await run(`await page.getByRole('button',{name:'Open folder',exact:true}).first().click(); await page.locator('input[name=path]').fill(repo); await page.getByRole('button',{name:'Continue',exact:true}).click(); await page.locator('.mini-repo-row').hover(); await page.getByRole('button',{name:'New terminal here',exact:true}).click(); await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('printf BROWSER_ACCEPTANCE'); await page.keyboard.press('Enter'); return 'terminal launched';`);
  const terminal = (await api('snapshot')).items.find((i: any) => i.type === 'term'); assert.ok(terminal);
  const pid = (await worker.list()).find(s => s.id === terminal.id)!.pid;
  await run(`await page.getByRole('button',{name:'preview.html',exact:true}).click(); const frame = page.frameLocator('iframe[title="preview.html preview b"]'); await frame.getByText('resource loaded;API blocked;WS blocked',{exact:true}).waitFor(); return 'sandbox rejects control access and loads module resources';`);
  await assert.rejects(stat(join(repo, 'attacked')), { code: 'ENOENT' });
  await run(`await page.locator('.mini-repo-row').hover(); await page.getByRole('button',{name:'Browse files',exact:true}).click(); await page.getByRole('button',{name:'· note.md',exact:true}).click(); await page.locator('.bn-editor').click(); await page.keyboard.press('Control+End'); await page.keyboard.type('Saved from browser.'); await page.locator('.builder-screens').click(); await page.waitForFunction(async path => { const r=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'read',method:'files.read',params:{path}})}); return (await r.json()).result.content.includes('Saved from browser.'); },repo+'/note.md'); return 'rich editor saved';`);
  assert.match(await readFile(join(repo, 'note.md'), 'utf8'), /Saved from browser/);
  await run(`await page.locator('.bn-editor').click(); await page.keyboard.press('Control+End'); await page.keyboard.type('Fast local draft.'); await page.evaluate(async path => { const call=async(method,params)=>{ const r=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'external',method,params})}); return (await r.json()).result; }; const file=await call('files.read',{path}); await call('files.write',{path,revision:file.revision,content:'# Agent change\\n\\nExternal wins until explicitly resolved.\\n'}); },repo+'/note.md'); await page.getByRole('button',{name:'Download draft',exact:true}).waitFor(); await page.locator('.builder-screens').click(); return 'external edit during debounce blocks blur save';`);
  assert.match(await readFile(join(repo, 'note.md'), 'utf8'), /External wins/);
  assert.doesNotMatch(await readFile(join(repo, 'note.md'), 'utf8'), /Fast local draft/);
  await run(`await page.getByRole('button',{name:'Reload disk version',exact:true}).click(); await page.getByText('External wins until explicitly resolved.',{exact:true}).waitFor();`);
  await run(`await page.route('**/api', async route => { const body=route.request().postDataJSON(); if(body?.method==='files.write') await route.continue({postData:JSON.stringify({...body,params:{...body.params,revision:'stale-browser-fixture'}})}); else await route.continue(); }); await page.locator('.bn-editor').click(); await page.keyboard.press('Control+End'); await page.keyboard.type('Local conflict draft.'); await page.locator('.builder-screens').click(); await page.getByRole('button',{name:'Download draft',exact:true}).waitFor(); await page.locator('.builder-pane').filter({has:page.getByText('note.md',{exact:true})}).getByRole('button',{name:'Source',exact:true}).click(); await page.locator('.monaco-editor').getByText('Local conflict draft.',{exact:false}).first().waitFor(); await page.locator('.builder-pane').filter({has:page.getByText('note.md',{exact:true})}).getByRole('button',{name:'Preview',exact:true}).click(); await page.locator('.bn-editor').getByText('Local conflict draft.',{exact:false}).first().waitFor(); const downloadPromise=page.waitForEvent('download'); await page.getByRole('button',{name:'Download draft',exact:true}).click(); const download=await downloadPromise; await download.saveAs(${JSON.stringify(join(root, 'draft.md'))}); await page.unrouteAll(); return 'conflicting draft retained and downloadable';`);
  assert.match(await readFile(join(root, 'draft.md'), 'utf8'), /Local conflict draft/);
  assert.doesNotMatch(await readFile(join(repo, 'note.md'), 'utf8'), /Local conflict draft/);
  await writeFile(join(repo, 'note.md'), '# External edit\n\nReloaded from disk.\n');
  await run(`await page.getByRole('button',{name:'Reload disk version',exact:true}).click(); return 'explicit conflict reload';`);
  await run(`await page.getByText('Reloaded from disk.',{exact:true}).waitFor(); const title = page.locator('.builder-pane').filter({has:page.locator('.terminal-tab')}).locator('.pane-title'); const from = await title.boundingBox(), rail = await page.locator('.builder-rail').boundingBox(); await page.mouse.move(from.x+10,from.y+10); await page.mouse.down(); await page.mouse.move(rail.x+rail.width-12,rail.y+rail.height-10,{steps:12}); await page.mouse.up(); await page.locator('.builder-pane').filter({has:page.locator('.terminal-tab')}).getByTitle('Hide pane (keep running)').click(); if(await page.locator('.terminal-tab').count()!==1)throw Error('terminal unmounted'); await page.locator('.builder-item-row button[title="'+repo+'"]').click(); return 'external reload and retained pane';`);
  await run(`await page.locator('.mini-repo-row').hover(); await page.getByRole('button',{name:'Show worktrees',exact:true}).click(); await page.getByRole('button',{name:'New worktree',exact:true}).click(); await page.locator('input[name=path]').fill(repo+'-worktree'); await page.locator('input[name=branch]').fill('browser-branch'); await page.getByRole('button',{name:'Continue',exact:true}).click(); await page.getByText('browser-branch',{exact:true}).waitFor(); return 'worktree created';`);
  await run(`await page.locator('.mini-repo-row').hover(); await page.getByRole('button',{name:'Browse files',exact:true}).click(); await page.locator('input[type=file]').setInputFiles(${JSON.stringify(join(root, 'uploaded.txt'))}); await page.getByRole('button',{name:'· uploaded.txt',exact:true}).waitFor(); await page.getByRole('button',{name:'· picture.png',exact:true}).click(); await page.waitForFunction(() => [...document.querySelectorAll('.preview-content img')].some(i => i.naturalWidth === 1)); await page.locator('.mini-repo-row').hover(); await page.getByRole('button',{name:'Browse files',exact:true}).click(); await page.getByRole('button',{name:'· document.pdf',exact:true}).click(); await page.getByText('Page 1 of 1',{exact:true}).waitFor(); await page.waitForFunction(() => document.querySelector('.pdf-scroll canvas')?.height > 0); return 'upload, image and PDF';`);
  assert.equal(await readFile(join(repo, 'uploaded.txt'), 'utf8'), 'Uploaded from browser.');
  await command('screenshot');
  await app.close(); app = await startServer({ port, stateDir, webRoot: resolve('dist/web') });
  await run(`await page.waitForFunction(() => document.querySelector('.connection')?.textContent === 'Connected'); await page.reload(); await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('printf AFTER_RESTART'); await page.keyboard.press('Enter'); await page.waitForFunction(async id => { const r=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'read',method:'terminals.read',params:{id,since:0}})});return atob((await r.json()).result.data).includes('AFTER_RESTART'); },${JSON.stringify(terminal.id)}); return 'server and browser restart replay';`);
  assert.equal((await worker.list()).find(s => s.id === terminal.id)!.pid, pid);
  await run(`await page.evaluate(() => { Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:()=>Promise.reject(new Error('test denied'))}); }); return 'clipboard denial configured';`);
  await api('terminals.write', { id: terminal.id, bytes: Buffer.from("printf '\\033]52;c;Y29weSBtZQ==\\007'\n").toString('base64') });
  await run(`await page.getByRole('dialog',{name:'Copy terminal text'}).waitFor(); if(await page.getByRole('textbox',{name:'Text to copy'}).inputValue()!=='copy me')throw Error('clipboard recovery lost text'); await page.getByRole('button',{name:'Done',exact:true}).click(); return 'denied clipboard recovery';`);
  await run(`await page.getByTitle('Toggle theme').click(); await page.setViewportSize({width:390,height:844}); await page.locator('.builder-item-row button[title="'+repo+'"]').click(); await page.getByRole('button',{name:'Back to items'}).click(); await page.locator('.builder-item-row button[title="'+repo+'"]').click(); if(!await page.locator('.terminal-tab').isVisible())throw Error('phone terminal hidden'); return 'dark and narrow layout';`);
  await command('screenshot');
  await run(`await page.setViewportSize({width:1280,height:800}); await page.goto(${JSON.stringify(parentBase)}); const app=page.frameLocator('iframe[title=Builder]'); await app.locator('button[title="'+repo+'/preview.html"]').click(); await app.frameLocator('iframe[title="preview.html preview b"]').getByText('resource loaded;API blocked;WS blocked',{exact:true}).waitFor(); return 'nested iframe previews remain isolated';`);
  console.log('PASS: standalone browser, terminal lifetime, editors, previews, layout and security');
} catch (error) { await command('screenshot').catch(() => {}); throw error; } finally {
  parent.close(); await command('close').catch(() => {}); await worker.stopAll(); worker.disconnect(); await app.close(); await rm(root, { recursive: true, force: true });
}
