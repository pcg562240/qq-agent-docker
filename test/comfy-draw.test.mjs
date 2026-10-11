import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULTS, SIGMAS, config, parseSize, buildGraph, imageInfo, imageLocator, boundedBody, createClient } from '../examples/skills/comfy-draw/lib/qwen21-engine.js';
import { createSkill, resolveReference } from '../examples/skills/comfy-draw/lib/qwen21-runtime.js';
import { normalizeManifest } from '../src/skills/manifest.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
function fixture(t, changes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-draw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { requests: [], submitted: [], uploads: 0, sends: [], downloads: [], notices: [], settings: { ...DEFAULTS, baseUrl: 'http://fixture-' + randomUUID() + ':9000', notifyStart: false }, ...changes };
  const json = data => Response.json(data);
  async function fetchImpl(url, options) {
    const u = new URL(url); state.requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (u.pathname === '/queue') return json({queue_running: state.busy ? [[1]] : [], queue_pending: []});
    if (u.pathname.startsWith('/object_info/')) {
      const node = u.pathname.split('/').pop();
      const pair = {UNETLoader:['unet_name',state.settings.modelName],CLIPLoader:['clip_name',state.settings.clipName],VAELoader:['vae_name',state.settings.vaeName]}[node];
      return json({[node]:pair ? {input:{required:{[pair[0]]:[state.missing ? [] : [pair[1]]]}}} : {}});
    }
    if (u.pathname === '/upload/image') {
      state.uploads++; assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('subfolder'), 'qqagent_comfy');
      return json({name:'uploaded.png',subfolder:'qqagent_comfy',type:'input'});
    }
    if (u.pathname === '/prompt') {
      const body = JSON.parse(options.body); state.submitted.push(body);
      if (state.submitLost) throw Error('fetch failed');
      return json({prompt_id:body.prompt_id});
    }
    if (u.pathname.startsWith('/history/')) {
      state.onHistory?.();
      if (state.pending) return json({});
      const id = u.pathname.split('/').pop();
      return json({[id]:state.nodeError ? {status:{status_str:'error',messages:[['execution_error',{node_type:'VAEDecode',exception_message:'test error'}]]}} : {status:{status_str:'success'},outputs:{12:{images:[{filename:state.badFilename || 'test.png',subfolder:'qqagent_comfy',type:'output'}]}}}});
    }
    if (u.pathname === '/view') return new Response(png, {headers:{'content-type':'image/png'}});
    throw Error('Unexpected route ' + u.pathname);
  }
  const skill = createSkill({dataDir:dir, pollMs:1, downloadReference:async (url,max) => {state.downloads.push({url,max});return {buffer:png};}});
  const tools = {};
  skill.setup({config:()=>state.settings, fetch:fetchImpl, registerTool:def=>{tools[def.id]=def;},log:()=>{},warn:()=>{}});
  t.after(()=>skill.dispose());
  const ctx = {chatKey:'group:fixture',session:{id:'session-1',status:'running',trigger:[],sent:[]},store:{findByMid:()=>null},sender:{
    sendImage:async (chat,ref)=>{if(state.sendFails)throw Error('QQ timeout');state.sends.push({chat,ref,bytes:fs.readFileSync(ref.file)});},
    sendTextBatch:async (_chat,texts)=>state.notices.push(...texts),
  }};
  return {dir,state,skill,tools,ctx,fetchImpl};
}

test('manifest and settings conform to local skill API',()=>{
  const raw = JSON.parse(fs.readFileSync(new URL('../examples/skills/comfy-draw/skill.json',import.meta.url)));
  assert.deepEqual(normalizeManifest(raw).problems,[]);
  assert.deepEqual(raw.settings,DEFAULTS);
  assert.deepEqual(Object.keys(raw.settings).sort(),Object.keys(raw.configSchema).sort());
  assert.ok(raw.permissions.includes('web_fetch')); assert.equal(raw.id,'comfy-draw');
});
test('Turbo uses the exact eight official sigma intervals and native CFG=1 guider',()=>{
  const g=buildGraph(config(),{prompt:'鲸鱼',seed:0,size:{width:768,height:768},prefix:'qqagent/test'});
  assert.equal(g['8'].inputs.sigmas,SIGMAS);assert.equal(SIGMAS.split(',').length,9);
  assert.equal(g['6'].class_type,'BasicGuider');assert.equal(g['7'].inputs.sampler_name,'euler');
  assert.deepEqual(g['10'].inputs.latent_image,['4',2]);assert.equal(g['4'].inputs.negative_prompt,'');
});
test('portrait canvas and image edit V3 autogrow graph',()=>{
  const g=buildGraph(config(),{prompt:'x',seed:1,size:{width:640,height:960},prefix:'test'});
  assert.equal(g['14'].inputs.width,640);assert.deepEqual(g['10'].inputs.latent_image,['14',0]);
  const e=buildGraph(config(),{prompt:'red',seed:1,size:{width:768,height:768},inputName:'qqagent_comfy/x.png',prefix:'test'});
  assert.deepEqual(e['4'].inputs['images.image_1'],['13',0]);assert.equal(e['4'].inputs.image_1,undefined);
  assert.deepEqual(e['10'].inputs.latent_image,['4',2]);
});
test('config and size validation reject huge images, malformed settings and credentials',()=>{
  assert.deepEqual(parseSize('640×960'),{width:640,height:960});
  for(const size of ['4096x4096','1x1','768x769','1536x1536','NaN','512x1536'])assert.throws(()=>parseSize(size));
  for(const baseUrl of ['file:///tmp','http://u:p@host/','http://host/?token=secret','javascript:x']) assert.throws(()=>config({baseUrl}));
  assert.throws(()=>config({timeoutMs:0}));assert.throws(()=>config({editResolution:999}));assert.throws(()=>config({modelName:''}));
});
test('image magic, pixel cap, aspect ratio and static-only policy',()=>{
  assert.equal(imageInfo(png).mime,'image/png');assert.throws(()=>imageInfo(Buffer.from('html')));
  const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);assert.throws(()=>imageInfo(huge));
  const wide=Buffer.from(png);wide.writeUInt32BE(64,16);assert.throws(()=>imageInfo(wide),/长宽比/);
  assert.throws(()=>imageInfo(Buffer.from('GIF89a'+'\x01\x00\x01\x00')),/GIF/);
});
test('Comfy locators cannot traverse files or request input instead of output',()=>{
  for(const filename of ['../a.png','/x.png','x\\y','..','x\n'])assert.throws(()=>imageLocator({filename},'output'));
  for(const subfolder of ['../','x/../y','/tmp','x\\y'])assert.throws(()=>imageLocator({filename:'x.png',subfolder},'output'));
  assert.throws(()=>imageLocator({filename:'x',type:'input'},'output'));
});
test('response body limit handles both declared and chunked lengths',async()=>{
  await assert.rejects(boundedBody(new Response('12345',{headers:{'content-length':'5'}}),4));
  await assert.rejects(boundedBody(new Response('12345'),4));
  assert.equal((await boundedBody(new Response('123'),4)).toString(),'123');
});
test('same-chat reference resolves opaque IDs, explicit local IDs, and no stale fallback',()=>{
  const calls=[],entry={media:[{kind:'image',url:'https://qq.example/image'}]};
  const ctx={chatKey:'group:one',store:{findByMid:(c,id)=>{calls.push([c,id]);return id==='opaque.123' ? entry : null;},findByLocalId:(c,id)=>{calls.push([c,id]);return entry;}},session:{trigger:[]}};
  assert.equal(resolveReference(ctx,'opaque.123'),entry.media[0].url);assert.deepEqual(calls[0],['group:one','opaque.123']);
  assert.equal(resolveReference(ctx,'#7'),entry.media[0].url);assert.deepEqual(calls[1],['group:one',7]);
  assert.throws(()=>resolveReference(ctx,'other'),/当前会话/);assert.throws(()=>resolveReference(ctx,123),/字符串/);
  assert.throws(()=>resolveReference(ctx),/本轮/);ctx.session.trigger=[entry];assert.equal(resolveReference(ctx),entry.media[0].url);
  ctx.session.trigger=[entry,entry];assert.throws(()=>resolveReference(ctx),/本轮/);
});
test('text image downloaded into profile media and delivered once; duplicate tool retry is idempotent',async t=>{
  const {tools,state,ctx,dir,skill}=fixture(t);
  assert.equal(skill.available().ok,true);assert.equal(typeof skill.available().then,'undefined');
  const result=await tools.local_draw.execute(ctx,{prompt:'鲸鱼',seed:0});
  assert.equal(result.isError,undefined,result.content);assert.equal(state.submitted.length,1);assert.equal(state.sends.length,1);
  assert.ok(state.sends[0].ref.file.startsWith(path.join(dir,'media','comfy-draw')));assert.deepEqual(state.sends[0].bytes,png);
  assert.equal(ctx.session.sent.length,1);assert.match(result.content,/seed=0/);
  const again=await tools.local_draw.execute(ctx,{prompt:'鲸鱼',seed:0});assert.match(again.content,/已在本会话发过/);
  assert.equal(state.submitted.length,1);assert.equal(state.sends.length,1);
});
test('settings read on every execution, distinct trigger in reused session gets new request',async t=>{
  const {tools,state,ctx}=fixture(t);await tools.local_draw.execute(ctx,{prompt:'鲸鱼'});
  state.settings.defaultSize='640x960';ctx.session.trigger=[{mid:'new-event'}];
  const result=await tools.local_draw.execute(ctx,{prompt:'鲸鱼'});assert.equal(result.isError,undefined,result.content);
  assert.equal(state.submitted[1].prompt['14'].inputs.width,640);assert.equal(state.submitted.length,2);
});
test('count=2 runs separate tasks and rejects fractions/out-of-range before submit',async t=>{
  const {tools,state,ctx}=fixture(t);
  for(const count of [0,3,1.5,'2'])assert.equal((await tools.local_draw.execute(ctx,{prompt:'x',count})).isError,true);
  const result=await tools.local_draw.execute(ctx,{prompt:'鲸鱼',count:2});assert.equal(result.isError,undefined,result.content);assert.equal(state.sends.length,2);
});
test('busy queue and missing model never enqueue and never send progress notices',async t=>{
  const {tools,state,ctx}=fixture(t,{busy:true});
  assert.match((await tools.local_draw.execute(ctx,{prompt:'x'})).content,/其他任务/);assert.equal(state.submitted.length,0);
  state.busy=false;state.missing=true;assert.match((await tools.local_draw.execute(ctx,{prompt:'x'})).content,/未找到/);
  assert.equal(state.submitted.length,0);assert.equal(state.notices.length,0);
});
test('edit uploads only resolved chat attachment and uses namespaced image slot',async t=>{
  const {tools,state,ctx}=fixture(t);ctx.session.trigger=[{media:[{kind:'image',url:'https://qq.example/attachment?secret=test'}]}];
  const result=await tools.local_edit.execute(ctx,{prompt:'围巾改红色'});assert.equal(result.isError,undefined,result.content);
  assert.equal(state.uploads,1);assert.equal(state.downloads.length,1);assert.deepEqual(state.submitted[0].prompt['4'].inputs['images.image_1'],['13',0]);
});
test('editing a generated image uses chat-scoped task, never arbitrary filesystem arguments',async t=>{
  const {tools,state,ctx,dir}=fixture(t);await tools.local_draw.execute(ctx,{prompt:'鲸鱼'});
  const id=fs.readdirSync(path.join(dir,'skill-data/comfy-draw/jobs'))[0].replace('.json','');
  ctx.session.id='edit-next';const result=await tools.local_edit.execute(ctx,{prompt:'red',source_job_id:id});assert.equal(result.isError,undefined,result.content);
  assert.equal(state.uploads,1);assert.equal(state.downloads.length,0);
  ctx.chatKey='group:other';assert.equal((await tools.local_edit.execute(ctx,{prompt:'red',source_job_id:id})).isError,true);
  assert.equal((await tools.local_draw_result.execute(ctx,{job_id:id})).isError,true);assert.equal(state.submitted.length,2);
});
test('uncertain submission is persisted before POST, query never resubmits',async t=>{
  const {tools,state,ctx,dir}=fixture(t,{submitLost:true});
  const result=await tools.local_draw.execute(ctx,{prompt:'x'});assert.match(result.content,/提交未确认/);
  const id=fs.readdirSync(path.join(dir,'skill-data/comfy-draw/jobs'))[0].replace('.json','');
  const job=JSON.parse(fs.readFileSync(path.join(dir,'skill-data/comfy-draw/jobs',id+'.json')));
  assert.equal(job.promptId,state.submitted[0].prompt_id);
  const collected=await tools.local_draw_result.execute(ctx,{job_id:id});assert.equal(collected.isError,undefined,collected.content);assert.equal(state.submitted.length,1);
});
test('failed QQ send preserves output; requires explicit resend and does not regenerate',async t=>{
  const {tools,state,ctx,dir}=fixture(t,{sendFails:true});
  const result=await tools.local_draw.execute(ctx,{prompt:'x'});assert.match(result.content,/发送未确认/);
  const id=fs.readdirSync(path.join(dir,'skill-data/comfy-draw/jobs'))[0].replace('.json','');state.sendFails=false;
  assert.match((await tools.local_draw_result.execute(ctx,{job_id:id})).content,/上次发送结果未确认/);
  const retry=await tools.local_draw_result.execute(ctx,{job_id:id,resend:true});assert.equal(retry.isError,undefined,retry.content);
  assert.equal(state.submitted.length,1);assert.equal(state.sends.length,1);
});
test('node failures and malicious output names never send or interrupt other jobs',async t=>{
  const {tools,state,ctx}=fixture(t,{nodeError:true});
  assert.match((await tools.local_draw.execute(ctx,{prompt:'x'})).content,/VAEDecode/);assert.equal(state.sends.length,0);
  state.nodeError=false;state.badFilename='../secret';ctx.session.id='next';
  assert.match((await tools.local_draw.execute(ctx,{prompt:'x'})).content,/非法图片文件名/);assert.equal(state.sends.length,0);
  assert.ok(!state.requests.some(r=>/interrupt|\/free/.test(r.url)));
});
test('disable aborts polling without sending or submitting again; lock shared with reloaded module',async t=>{
  const {tools,state,ctx,skill}=fixture(t,{pending:true});
  const first=tools.local_draw.execute(ctx,{prompt:'x'});
  while(!state.submitted.length) await new Promise(r=>setTimeout(r,1));
  const second=await tools.local_draw.execute({...ctx,session:{id:'other'}},{prompt:'y'});assert.match(second.content,/另一项请求/);
  skill.deactivate();const result=await first;assert.equal(result.isError,true);assert.equal(state.sends.length,0);assert.equal(state.submitted.length,1);
  skill.activate();state.pending=false;const collected=await tools.local_draw.execute(ctx,{prompt:'x'});assert.equal(collected.isError,undefined,collected.content);assert.equal(state.submitted.length,1);
});
test('client rejects redirects and prevents over-limit upload before network call',async()=>{
  let called=false;const client=createClient(config(),()=>{called=true;throw Error('unexpected')});
  await assert.rejects(client.upload(Buffer.alloc(13*1048576),'x'),/大小限制/);assert.equal(called,false);
});
test('timeout preserves its prompt ID and later query fetches without submitting twice',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  const {tools,state,ctx,dir}=fixture(t,{pending:true});
  state.settings.timeoutMs=30000;state.onHistory=()=>t.mock.timers.tick(31000);
  const result=await tools.local_draw.execute(ctx,{prompt:'鲸鱼'});assert.match(result.content,/等待超时/);
  const id=fs.readdirSync(path.join(dir,'skill-data/comfy-draw/jobs'))[0].replace('.json','');
  state.pending=false;state.onHistory=null;
  const collected=await tools.local_draw_result.execute(ctx,{job_id:id});assert.equal(collected.isError,undefined,collected.content);
  assert.equal(state.submitted.length,1);assert.equal(state.sends.length,1);
});
