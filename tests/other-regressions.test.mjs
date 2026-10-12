import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const preview=fs.readFileSync(new URL('../plugins/document-preview/sidecars/panel/app.js',import.meta.url),'utf8');
const render=preview.slice(preview.indexOf('  async function renderPdf('),preview.indexOf('  function toggleThumbs('));
test('slow old PDF cannot overwrite a newer document',async()=>{
 const tasks=[];const shown=[];const elements=new Map();
 const $=(id)=>{if(!elements.has(id))elements.set(id,{replaceChildren(){},setAttribute(){},classList:{toggle(){}}});return elements.get(id)};
 const ctx=vm.createContext({openToken:1,pdfDoc:null,pdfjs:{linkService:{setDocument(){}}},viewer:{setDocument(d){if(d)shown.push(d.name)}},$: $,absolute:v=>v,thumbsOpen:false,L:v=>v,buildThumbs(){},prompt(){assert.fail('unexpected prompt')},loadPdfjs:async()=>({lib:{getDocument(){let resolve;const promise=new Promise(r=>resolve=r);const t={promise,resolve,destroy(){}};tasks.push(t);return t;}}})});
 vm.runInContext(render,ctx);const a=ctx.renderPdf({src:'a'},1);await new Promise(r=>setImmediate(r));ctx.openToken=2;
 const b=ctx.renderPdf({src:'b'},2);await new Promise(r=>setImmediate(r));let destroyed=false;
 tasks[1].resolve({name:'b',numPages:2});await b;
 tasks[0].resolve({name:'a',numPages:9,destroy(){destroyed=true}});await a;
 assert.deepEqual(shown,['b']);assert.equal(ctx.pdfDoc.name,'b');assert.equal(destroyed,true);
});
test('switch away during PDF library load does not create stale document',async()=>{
 let finish;const ctx=vm.createContext({openToken:1,loadPdfjs:()=>new Promise(r=>finish=r)});vm.runInContext(render,ctx);
 const p=ctx.renderPdf({src:'a'},1);ctx.openToken=2;finish({lib:{getDocument(){assert.fail('stale load')}}});await p;
});
const translate=fs.readFileSync(new URL('../plugins/antigravity-zh/sidecars/injector/inject/translate.js',import.meta.url),'utf8');
function translator(){let cb,queued;let observations=0,translations=0;const frameCallbacks=new Map();let serial=0;
 const doc={documentElement:{dataset:{}},body:{nodeType:1,querySelectorAll:()=>[],matches:()=>false},createTreeWalker:()=>({nextNode:()=>null}),querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}};
 const ctx=vm.createContext({window:{__AGY_ZH_DICT__:{exact:{},patterns:[],units:[],time:[]}},document:doc,navigator:{language:'en'},Node:{TEXT_NODE:3,ELEMENT_NODE:1},NodeFilter:{SHOW_TEXT:4},MutationObserver:class{constructor(f){cb=f}observe(){observations++}disconnect(){}},requestAnimationFrame(f){queued=f;frameCallbacks.set(++serial,f);return serial},cancelAnimationFrame(i){frameCallbacks.delete(i)},setTimeout(){}});
 vm.runInContext(translate,ctx);
 return {ctx,emit:()=>cb([{type:'childList',addedNodes:[]}]),flush:()=>{const list=[...frameCallbacks.values()];frameCallbacks.clear();list.forEach(f=>f())},get observations(){return observations},queued:()=>queued};
}
test('unload cancels queued translation and cannot reconnect observer',()=>{
 const x=translator();x.emit();const stale=x.queued();x.ctx.window.__agyZhUnload();const before=x.observations;x.flush();stale();assert.equal(x.observations,before);assert.equal(x.ctx.document.documentElement.dataset.agyLocale,undefined);
});
test('detached translated nodes are released after DOM changes',()=>{
 const x=translator();vm.runInContext('textOriginals.set({isConnected:false}, "old"); attrOriginals.set({isConnected:false}, {});',x.ctx);x.emit();x.flush();assert.equal(vm.runInContext('textOriginals.size + attrOriginals.size',x.ctx),0);
});
const skin=fs.readFileSync(new URL('../plugins/claude-style/sidecars/injector/inject/app.js',import.meta.url),'utf8');
const refreshCode=skin.slice(skin.indexOf('const previewFrames ='),skin.indexOf('function previewBase()'));
function refreshContext(frames){const ctx=vm.createContext({$$:()=>frames,URL,Date,window:{addEventListener(){},removeEventListener(){}},document:{addEventListener(){},removeEventListener(){}},onCleanup(){},cascadeId:()=> 'conversation',artifactPath:async(link)=>link.path,PREVIEWABLE:/\.pdf$/i});vm.runInContext(refreshCode+'\nglobalThis.clickLink=onPreviewLinkClick;globalThis.fileMessage=onPreviewFileMessage;',ctx);return ctx;}
test('every repeated click reloads same PDF while preserving auth token',async()=>{
 const frame={src:'plugin://document-preview--panel/?token=secret&file=%2Ftmp%2Fa.pdf',contentWindow:{}};const ctx=refreshContext([frame]);
 const click={button:0,target:{closest:()=>({path:'/tmp/a.pdf'})}};
 await ctx.clickLink(click);const first=frame.src;await ctx.clickLink(click);assert.notEqual(frame.src,first);
 const url=new URL(frame.src);assert.equal(url.searchParams.get('token'),'secret');assert.equal(url.searchParams.get('file'),'/tmp/a.pdf');
});
test('different files, modifier clicks, and unrelated plugin frames are untouched',async()=>{
 const frame={src:'plugin://document-preview--panel/?file=%2Ftmp%2Fa.pdf',contentWindow:{}};const other={src:'plugin://other-plugin/?file=%2Ftmp%2Fa.pdf'};const ctx=refreshContext([frame,other]);
 const original=frame.src;await ctx.clickLink({button:0,target:{closest:()=>({path:'/tmp/b.pdf'})}});assert.equal(frame.src,original);
 await ctx.clickLink({button:0,metaKey:true,target:{closest:()=>({path:'/tmp/a.pdf'})}});assert.equal(frame.src,original);assert.equal(other.src,'plugin://other-plugin/?file=%2Ftmp%2Fa.pdf');
});
test('file selected inside preview supersedes original iframe URL',async()=>{
 const frame={src:'plugin://document-preview--panel/?file=%2Ftmp%2Fa.pdf',contentWindow:{}};const ctx=refreshContext([frame]);
 ctx.fileMessage({source:{},data:{type:'agy-preview-file',path:'/tmp/evil.pdf'}});assert.equal(frame.csPreviewPath,undefined);
 ctx.fileMessage({source:frame.contentWindow,data:{type:'agy-preview-file',path:'/tmp/b.pdf',requestedPath:'/tmp/b.pdf'}});
 await ctx.clickLink({button:0,target:{closest:()=>({path:'/tmp/b.pdf'})}});assert.equal(new URL(frame.src).searchParams.get('file'),'/tmp/b.pdf');
});
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createFiles } from '../plugins/document-preview/sidecars/panel/files.mjs';
test('reopen same PDF streams new file bytes even with same size/mtime',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-preview-test-'));const file=path.join(dir,'test.pdf');
 const old='%PDF-1.4\nversion A\n', next='%PDF-1.4\nversion B\n';fs.writeFileSync(file,old);const stamp=fs.statSync(file);
 const files=createFiles(path.join(dir,'data'));const a=await files.open(file);await files.prepare(a.id);
 const server=http.createServer((req,res)=>files.stream(a.id,req,res).catch(err=>{res.statusCode=500;res.end(err.message)}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/file`;
 try {
  assert.equal(await (await fetch(url)).text(),old);fs.writeFileSync(file,next);fs.utimesSync(file,stamp.atime,stamp.mtime);
  const b=await files.open(file);await files.prepare(b.id);assert.equal(b.id,a.id);
  const response=await fetch(url);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(await response.text(),next);
 } finally {await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
