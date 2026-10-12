import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { summarizeUsage, createUsageReader, seconds } from '../plugins/claude-style/sidecars/injector/usage.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./last-generation.json',import.meta.url)));
const configs=[{label:'Gemini 3.8 Flash (High)',modelId:'gemini-3.8-flash-high',modelOrAlias:{model:'MODEL_PLACEHOLDER_M318'}}];
const id='2e870a27-a3de-4e46-a5e2-5e62253ad3d0';
const copy=()=>structuredClone(fixture);
test('real screenshot: old 618 is 149 reply rate and 208 effective throughput',()=>{
 const {last,totals}=summarizeUsage([fixture],configs);
 assert.equal(Math.round(last.output/last.streaming),618);
 assert.equal(Math.round(last.tps),149); assert.equal(Math.round(last.effectiveTps),208);
 assert.equal(last.response,313); assert.equal(totals.streamedOutput,313);
});
test('requested High and returned control stay separate',()=>{
 const {last}=summarizeUsage([fixture],configs);
 assert.equal(last.requestedModelId,'gemini-3.8-flash-high');assert.equal(last.responseModel,'gemini-3.8-flash-control');
});
test('no backend identity is never filled with requested model',()=>{
 const f=copy();delete f.chatModel.responseModel;
 assert.equal(summarizeUsage([f],configs).last.responseModel,null);
});
test('short buffered stream has usage but no misleading burst TPS',()=>{
 const f=copy();f.chatModel.streamingDuration='0.001500417s';
 const {last,totals}=summarizeUsage([f]);assert.equal(last.tps,null);assert.equal(totals.generations,1);assert.equal(totals.speedSamples,0);
});
test('missing/malformed timing stays unknown',()=>{
 for(const d of [undefined,'bad','-1s','Infinitys']) {assert.equal(seconds(d),null);const f=copy();f.chatModel.streamingDuration=d;assert.equal(summarizeUsage([f]).last.tps,null);}
});
test('omitted proto scalar derives non-thinking output, explicit zero stays zero',()=>{
 const f=copy();delete f.chatModel.usage.responseOutputTokens;assert.equal(summarizeUsage([f]).last.response,313);
 f.chatModel.usage.responseOutputTokens='0';assert.equal(summarizeUsage([f]).last.response,0);
});
test('mean rate uses eligible non-thinking tokens and duration',()=>{
 const f=copy();f.chatModel.usage.responseOutputTokens='100';f.chatModel.streamingDuration='1s';
 const {totals:t}=summarizeUsage([fixture,f]);assert.equal(t.streamedOutput,413);assert.equal(t.speedSamples,2);assert.equal(t.streaming,3.0961645);
});
test('concurrent readers do not double count; amend/rewind snapshots replace totals',async()=>{
 let records=[fixture],reads=0;
 const read=createUsageReader(async(method,args)=>{if(method==='GetCascadeModelConfigData')return {clientModelConfigs:configs};reads++;assert.equal(args.generatorMetadataOffset,0);await new Promise(r=>setImmediate(r));return {generatorMetadata:records};});
 const [a,b]=await Promise.all([read(id),read(id)]);assert.equal(reads,1);assert.equal(a.totals.generations,1);assert.deepEqual(a,b);
 records=[fixture,fixture];assert.equal((await read(id)).totals.generations,2);
 records=[];assert.equal((await read(id)).totals.generations,0);
 records=[{chatModel:{}}];assert.equal((await read(id)).last,null);
 records=[fixture];assert.equal((await read(id)).last.output,1296);
});
test('failed metadata read can retry',async()=>{
 let fail=true;const read=createUsageReader(async(method)=>{if(method==='GetCascadeModelConfigData')return {};if(fail)throw Error('offline');return {generatorMetadata:[fixture]};});
 await assert.rejects(read(id));fail=false;assert.equal((await read(id)).last.response,313);
});
test('invalid conversation does not call backend',async()=>{
 const read=createUsageReader(()=>assert.fail('unexpected API call'));assert.equal(await read('------------------------------------'),null);
});
const ui=fs.readFileSync(new URL('../plugins/claude-style/sidecars/injector/inject/app.js',import.meta.url),'utf8');
const pollCode=ui.slice(ui.indexOf('let polling = false;'),ui.indexOf('// Git drawer'));
function pollContext(call){const ctx=vm.createContext({call,Date,document:{hidden:false},cascadeId:()=>ctx.activeId,activeId:'A',usageState:{id:null},openPop:null,closePop(){},renderChip(){},refreshQuota(){}});vm.runInContext(pollCode+'\nglobalThis.runPoll=poll;',ctx);return ctx;}
test('switching conversations during metadata await does not write old result',async()=>{
 let finish;const ctx=pollContext(async(cmd)=>cmd==='status'?{status:'IDLE',steps:2}:new Promise(r=>finish=r));
 const p=ctx.runPoll();await new Promise(r=>setImmediate(r));ctx.activeId='B';finish({last:{response:313}});await p;assert.equal(ctx.usageState.data,null);
});
test('unchanged steps still refresh late usage; no DOM guessed live TPS',async()=>{
 let reads=0;const ctx=pollContext(async(cmd)=>cmd==='status'?{status:'RUNNING',steps:2}:(reads++,{last:{response:313}}));
 await ctx.runPoll();assert.equal(reads,1);assert.equal(ctx.usageState.live.tps,undefined);
 ctx.usageState.updated=1;await ctx.runPoll();assert.equal(reads,2);
});
