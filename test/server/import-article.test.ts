import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importWebArticle} from '../../src/server/ported/import-service.js';
test('original article import extracts readable Markdown and never overwrites an earlier import',async()=>{
 const root=await mkdtemp(join(tmpdir(),'builder-article-'));
 const paragraph='This local article explains how the project works and why its original behavior matters. The imported document must preserve the useful text, its source, and its title while omitting navigation. ';
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(`<html><head><title>A local article</title></head><body><nav>Other links</nav><article><h1>A local article</h1><p>${paragraph.repeat(6)}</p><p>A second paragraph with useful details for the reader.</p></article></body></html>`)});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/article`;
  const first=await importWebArticle(url,root,root),second=await importWebArticle(url,root,root);
  assert.notEqual(first.path,second.path);
  const text=await readFile(first.path,'utf8');
  assert.match(text,/type: "article"/);assert.ok(text.includes(url));assert.ok(text.includes('This local article explains'));assert.match(text,/second paragraph/);
 } finally {await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}
});
