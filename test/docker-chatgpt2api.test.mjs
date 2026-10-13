import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settings, serviceRoot, client, createCatalog, imageType } from '../src/chatgpt2api-client.js';
import { bindSkillSecrets, skillModelRoutes } from '../src/skill-models.js';
import { createImageSkill, referenceUrl } from '../skills/chatgpt2api-image/runtime.js';
import { createSearchSkill, searchResult } from '../skills/chatgpt2api-search/runtime.js';
import { unsentQueryReplyReminder } from '../src/reply-completion.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=','base64');
const config = {baseUrl:'http://service.test/v1',apiKey:'OFFLINE_USER_KEY',model:'web-image/Custom-Fast-V2',timeoutMs:10000};
test('completed chatgpt2api search qualifies for bounded send reminder, image tasks and unknown skills do not',()=>{
  const base={trigger:[{mid:'CURRENT',atMe:true}],kind:'group',canSend:true};
  for (const name of ['chatgpt2api-search__search','chatgpt2api-image__draw','chatgpt2api-image__result','unknown__search']) {
    const messages=[{role:'assistant',tool_calls:[{id:'call',function:{name,arguments:'{}'}}]},
      {role:'tool',name,tool_call_id:'call',content:'result'}, {role:'assistant',content:''}];
    assert.equal(Boolean(unsentQueryReplyReminder({...base,messages})),name==='chatgpt2api-search__search');
    assert.equal(unsentQueryReplyReminder({...base,messages,alreadyReminded:true}),'');
  }
});
const manifest = type => JSON.parse(fs.readFileSync(new URL(`../skills/chatgpt2api-${type}/skill.json`,import.meta.url)));
function tmp(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-c2a-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fake(t,{ image=true, fetcher, send, download }={}) {
  const dir=tmp(t), tools={}, calls=[], sent=[];let cfg={...config};
  const fetch=fetcher || (async (url,options={})=>{
    const body=options.body ? JSON.parse(options.body):null;calls.push({url,options,body});
    if(url.includes('/models'))return Response.json({data:[{id:'gpt-image-2.5-flare'},{id:'web-image/Exact-V2'},{id:'text-V2'}]});
    if(options.method==='POST')return Response.json({id:body.client_task_id,status:'queued'});
    if(url.includes('/api/image-tasks?ids='))return Response.json({items:[{id:url.split('ids=')[1],status:'success',data:[{url:'http://different-lan.test/images/fixture.png'}]}]});
    if(url.endsWith('/images/fixture.png'))return new Response(PNG);
    throw new Error('unexpected network');
  });
  const factory=image?createImageSkill:createSearchSkill;
  const mod=factory({dataDir:dir,download:download || (async()=>({buffer:PNG})),pollMs:1});
  const api={config:()=>cfg,fetch,registerTool:x=>tools[x.id]=x};mod.setup(api);
  const ctx={chatKey:'group:G',session:{id:'s1',status:'running',trigger:[{mid:'msg',media:[{kind:'image',url:'https://qq.example/image.png'}]}],sent:[]},
    store:{findByMid:(key,id)=>key==='group:G'&&id==='msg'?ctx.session.trigger[0]:null},
    sender:{sendImage:async(...args)=>{sent.push(args);if(send)return send(...args);}}};
  return {dir,tools,calls,sent,ctx,mod,api,setConfig:c=>cfg={...cfg,...c},getConfig:()=>cfg};
}

test('chatgpt2api normalization preserves exact model IDs and rejects malformed settings/URLs',()=>{
  assert.equal(serviceRoot('http://localhost:8030/v1/'),'http://localhost:8030');
  assert.equal(serviceRoot('https://service.test/prefix/v1'),'https://service.test/prefix');
  assert.equal(settings(config).model,'web-image/Custom-Fast-V2');
  for(const baseUrl of ['file:///tmp/x','https://user:pass@service.test','https://service.test/?key=x','bad'])assert.throws(()=>settings({...config,baseUrl}));
  for(const patch of [{model:''},{apiKey:'******'},{model:'a\nb'},{defaultSize:'0x512'},{defaultSize:'4097x512'},{timeoutMs:-1}])assert.throws(()=>settings({...config,...patch}));
  assert.equal(imageType(PNG).ext,'png');assert.throws(()=>imageType(Buffer.from('<html>')));
  const oversized=Buffer.from(PNG);oversized.writeUInt32BE(100000,16);assert.throws(()=>imageType(oversized));
});

test('endpoint-bound secrets stay only with same address, including equivalent root/v1',()=>{
  const schema=manifest('image').configSchema;
  assert.deepEqual(bindSkillSecrets({model:'new'},config,schema),{model:'new'});
  assert.equal(bindSkillSecrets({baseUrl:'http://elsewhere.test'},config,schema).apiKey,'');
  assert.equal(bindSkillSecrets({baseUrl:'http://service.test'},config,schema).apiKey,undefined);
  assert.equal(bindSkillSecrets({baseUrl:'http://elsewhere.test',apiKey:'NEW'},config,schema).apiKey,'NEW');
});

test('client sends credentials only to fixed service; images rebase storage paths and never forward keys',async()=>{
  const calls=[];const c=settings(config);
  const net=client(c,async(url,opts)=>{calls.push({url,opts});return url.includes('/images/')?new Response(PNG):Response.json({data:[]});});
  await net.request('/v1/models');assert.equal(calls[0].url,'http://service.test/v1/models');assert.equal(calls[0].opts.headers.Authorization,'Bearer OFFLINE_USER_KEY');assert.equal(calls[0].opts.redirect,'error');
  await net.image({url:'http://192.168.1.1:9000/images/fixture.png'});assert.equal(calls[1].url,'http://service.test/images/fixture.png');assert.equal(calls[1].opts.headers.Authorization,undefined);
  const n=calls.length;
  for(const url of ['http://evil.test/admin','file:///images/x.png','http://x/images/x.png?token=SECRET','http://x/images/%2e%2e/private.png'])await assert.rejects(net.image({url}));
  assert.equal(calls.length,n);
});

test('client bounds streamed bodies and discards raw errors/credentials without retry',async()=>{
  const c=settings(config);let n=0;
  for(const response of [new Response('OFFLINE_USER_KEY@example.test',{status:401}),new Response('html'),new Response('x'.repeat(2*1048576+1))]){
    const net=client(c,async()=>{n++;return response;});await assert.rejects(net.request('/v1/search'),e=>!e.message.includes(config.apiKey));
  }
  assert.equal(n,3);
  const net=client(c,async()=>{throw new Error('socket '+config.apiKey);});await assert.rejects(net.request('/v1/search'),e=>!e.message.includes(config.apiKey));
});

test('catalog refresh caches per profile/key, survives reload/failure and never changes selected model',async t=>{
  const dir=tmp(t);let cfg={...config}, fail=false, calls=0;
  const options={dataDir:dir,id:'chatgpt2api-image',images:true,getSettings:()=>cfg,getFetch:()=>async()=>{calls++;if(fail)throw Error('bad');return Response.json({data:[{id:'gpt-image-2.5-flare'},{id:'web-image/Exact-V2'},{id:'text-V2'},{id:'web-image/Exact-V2'}]});}};
  const catalog=createCatalog(options);
  assert.deepEqual((await catalog()).models,[]);assert.equal(calls,0);
  assert.deepEqual((await catalog({refresh:true})).models,['gpt-image-2.5-flare','web-image/Exact-V2']);
  assert.equal(cfg.model,config.model);fail=true;await assert.rejects(catalog({refresh:true}));
  assert.equal((await createCatalog(options)()).models.length,2);assert.equal(calls,2);
  cfg={...cfg,apiKey:'DIFFERENT_KEY'};assert.deepEqual((await catalog()).models,[]);
  assert.ok(!fs.readFileSync(path.join(dir,'skill-data/chatgpt2api-image',fs.readdirSync(path.join(dir,'skill-data/chatgpt2api-image'))[0]),'utf8').includes(config.apiKey));
});

test('draw generates count-limited tasks, sends through queue, persists dedupe across reload',async t=>{
  const f=fake(t);assert.equal(f.mod.available().ok,true);
  const args={prompt:'合成测试的小鲸鱼',count:2,size:'512x512'};
  const r=await f.tools.draw.execute(f.ctx,args);assert.ok(!r.isError,r.content);assert.equal(f.sent.length,2);assert.equal(f.ctx.session.sent.length,2);
  const posts=f.calls.filter(x=>x.body);assert.equal(posts.length,2);assert.notEqual(posts[0].body.client_task_id,posts[1].body.client_task_id);
  assert.equal(posts[0].body.model,config.model);assert.equal(posts[0].body.size,'512x512');assert.equal(posts[0].url,'http://service.test/api/image-tasks/generations');
  const reloaded=createImageSkill({dataDir:f.dir,download:async()=>({buffer:PNG})});reloaded.setup(f.api);
  const dup=await f.tools.draw.execute(f.ctx,args);assert.ok(!dup.isError);assert.equal(f.sent.length,2);assert.equal(f.calls.filter(x=>x.body).length,2);
  const job=posts[0].body.client_task_id;
  const cross=await f.tools.result.execute({...f.ctx,chatKey:'group:OTHER'},{job_id:job});assert.equal(cross.isError,true);
  f.setConfig({apiKey:'OTHER_KEY'});assert.equal((await f.tools.result.execute(f.ctx,{job_id:job})).isError,true);
});

test('edit references/quoted images stay in chat, upload inline bytes, mask and multiple refs use edits route',async t=>{
  const downloads=[];const f=fake(t,{download:async url=>{downloads.push(url);return {buffer:PNG};}});
  f.ctx.session.trigger=[{mid:'msg',media:[{kind:'image',url:'https://qq.example/one.png'}],reply:{media:[{kind:'image',url:'https://qq.example/quote.png'}]}}];
  const r=await f.tools.draw.execute(f.ctx,{prompt:'换背景',mode:'edit',references:[{message_id:'msg'},{message_id:'msg',image_index:2}],mask:{message_id:'msg'}});
  assert.ok(!r.isError,r.content);assert.equal(downloads.length,3);const post=f.calls.find(x=>x.body);
  assert.equal(post.url,'http://service.test/api/image-tasks/edits');assert.equal(post.body.images.length,2);assert.equal(post.body.images[0].b64_json,PNG.toString('base64'));assert.equal(post.body.mask.mime_type,'image/png');
  assert.ok(!JSON.stringify(post.body).includes('qq.example'));
  assert.equal(referenceUrl(f.ctx,{message_id:'#msg'}),'https://qq.example/one.png');
  assert.throws(()=>referenceUrl(f.ctx,{message_id:'#m…'}));
  for(const ref of [{message_id:'missing'},{url:'http://127.0.0.1/secret'},{message_id:'msg',image_index:0}])assert.throws(()=>referenceUrl(f.ctx,ref));
  f.ctx.session.trigger.push({mid:'other',media:[{kind:'image',url:'https://qq.example/other'}]});assert.throws(()=>referenceUrl(f.ctx,{}),/唯一/);
});

test('invalid refs/count or failed safe download never submit image tasks',async t=>{
  const f=fake(t,{download:async()=>{throw Error('signed-url-secret');}});
  for(const args of [{prompt:'p',count:5},{prompt:'p',mode:'edit',references:[{url:'http://evil'}]},{prompt:'p',mode:'edit'},{prompt:''}]){
    const r=await f.tools.draw.execute(f.ctx,args);assert.equal(r.isError,true);assert.ok(!r.content.includes('signed-url-secret'));
  }
  assert.equal(f.calls.length,0);
});

test('unknown submission outcome and QQ send failure never auto regenerate/resend',async t=>{
  let posts=0;
  const f=fake(t,{fetcher:async(url,opts)=>{if(opts.method==='POST'){posts++;throw Error('timeout');}return Response.json({items:[],missing_ids:[url.split('ids=')[1]]});}});
  const args={prompt:'test'};const r=await f.tools.draw.execute(f.ctx,args);assert.equal(r.isError,true);assert.match(r.content,/任务 [a-f0-9]{32}/);
  assert.equal((await f.tools.draw.execute(f.ctx,args)).isError,true);assert.equal(posts,1);
  let broken=true;const g=fake(t,{send:async()=>{if(broken)throw Error('ambiguous timeout');}});
  assert.equal((await g.tools.draw.execute(g.ctx,args)).isError,true);const job=g.calls.find(x=>x.body).body.client_task_id;
  broken=false;assert.equal((await g.tools.result.execute(g.ctx,{job_id:job})).isError,true);assert.equal(g.sent.length,1);
  assert.ok(!(await g.tools.result.execute(g.ctx,{job_id:job,resend_confirmed:true})).isError);assert.equal(g.sent.length,2);assert.equal(g.calls.filter(x=>x.body).length,1);
});

test('deactivation stops in-flight work without sending or automatically resubmitting',async t=>{
  let release;const waiting=new Promise(r=>release=r);
  const f=fake(t,{fetcher:async(url,opts)=>{if(opts.method==='POST'){await waiting;return Response.json({id:JSON.parse(opts.body).client_task_id});}return Response.json({items:[]});}});
  const work=f.tools.draw.execute(f.ctx,{prompt:'test'});await new Promise(r=>setTimeout(r,10));f.mod.deactivate();release();
  assert.equal((await work).isError,true);assert.equal(f.sent.length,0);
});

test('search returns only bounded answer/safe sources, not private account fields; exact optional summary model',async t=>{
  const calls=[];const f=fake(t,{image:false,fetcher:async(url,opts)=>{const body=JSON.parse(opts.body);calls.push({url,body});
    return url.endsWith('/search')?Response.json({answer:'原答案',sources:[{title:'source',url:'https://example.com/news'}],_account_email:'private@example.test',conversation_id:'PRIVATE'}):Response.json({choices:[{message:{content:'整理答案'}}]});}});
  f.setConfig({model:'Text-Custom-V2'});const r=await f.tools.search.execute(f.ctx,{query:'最新新闻'});assert.ok(!r.isError,r.content);
  assert.deepEqual(calls[0],{url:'http://service.test/v1/search',body:{prompt:'最新新闻'}});assert.equal(calls[1].body.model,'Text-Custom-V2');assert.equal(calls[1].body.stream,false);
  assert.match(r.content,/整理答案/);assert.match(r.content,/https:\/\/example.com\/news/);assert.doesNotMatch(r.content,/private@example|PRIVATE/);assert.equal(f.sent.length,0);
  const safe=searchResult({answer:config.apiKey,sources:[{url:'javascript:bad()'},{url:'https://u:p@example.com'},{url:'https://example.com'}]},config.apiKey);
  assert.equal(safe.sources.length,1);assert.ok(!safe.answer.includes(config.apiKey));assert.throws(()=>searchResult({answer:''}));
});

test('search no-summary mode makes one call; failed summary preserves sources and original answer, no retry',async t=>{
  let calls=0;const f=fake(t,{image:false,fetcher:async url=>{calls++;if(url.endsWith('/search'))return Response.json({answer:'原始搜索',sources:[]});throw Error('NO');}});
  f.setConfig({model:''});assert.match((await f.tools.search.execute(f.ctx,{query:'q'})).content,/没有可核验来源/);assert.equal(calls,1);
  f.setConfig({model:'Custom'});const r=await f.tools.search.execute(f.ctx,{query:'q'});assert.equal(calls,3);assert.match(r.content,/原始搜索/);assert.match(r.content,/未完成/);
});

test('catalog route is generic, whitelists output and hides raw error details',async()=>{
  const mod={modelCatalog:async({refresh})=>({models:['x'],updatedAt:'now',key:'PRIVATE',refresh})};
  const routes=skillModelRoutes({registry:new Map([['fixture',mod]])});
  const call=r=>r.handler({match:['','fixture'],res:{},json:(res,status,data)=>({status,data})});
  assert.deepEqual((await call(routes[1])).data,{ok:true,models:['x'],updatedAt:'now'});
  mod.modelCatalog=async()=>{throw Error('PRIVATE');};assert.ok(!JSON.stringify(await call(routes[1])).includes('PRIVATE'));
});

const uiCode=fs.readFileSync(new URL('../ui/app/06-settings-render.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('skill settings render model fetch + manual input, escape IDs and keep masked key out of value',()=>{
  const scope=vm.createContext({esc,state:{}});vm.runInContext(uiCode,scope);
  const sk=manifest('image');sk.settings={...sk.settings,apiKey:'******',model:'<bad>'};
  const html=scope.renderSkillSettingsModal(sk).html;assert.match(html,/获取模型列表/);assert.match(html,/data-model-select/);assert.match(html,/&lt;bad&gt;/);assert.doesNotMatch(html,/value="\*\*\*\*\*\*"/);
});
test('model UI failure/late response never clears manual ID, guards unsaved connections and instance switch',async()=>{
  const el=(extra={})=>({value:'',innerHTML:'',textContent:'',handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},dispatchEvent(){},...extra});
  const input=el({value:'Manual-V2',dataset:{key:'model'}}),secret=el({dataset:{key:'apiKey'}}),base=el({value:config.baseUrl,dataset:{key:'baseUrl'}});
  const select=el(),button=el(),status=el(),box=el({dataset:{modelKey:'model'},querySelector:q=>({'[data-model-select]':select,'[data-model-refresh]':button,'[data-model-status]':status}[q])});
  const overlay={isConnected:true,querySelector:()=>input,querySelectorAll:q=>q==='[data-model-key]'?[box]:[input,secret,base]};
  let fail=false,requestCount=0;const state={activeInst:{id:'A'}};
  const scope=vm.createContext({esc,state,Event:class{},api:async()=>{requestCount++;if(fail)throw Error('bad');return {models:['Fetched-V2']};}});vm.runInContext(uiCode,scope);
  scope.bindSkillModelCatalog(overlay,{...manifest('image'),settings:config});await new Promise(r=>setTimeout(r,0));assert.equal(input.value,'Manual-V2');const before=select.innerHTML;
  fail=true;await button.handlers.click();assert.equal(select.innerHTML,before);assert.equal(input.value,'Manual-V2');
  secret.value='UNSAVED';const n=requestCount;await button.handlers.click();assert.equal(requestCount,n);assert.match(status.textContent,/尚未保存/);
  secret.value='';state.activeInst.id='B';await button.handlers.click();assert.equal(requestCount,n);assert.match(status.textContent,/实例已切换/);
  select.value='Fetched-V2';select.handlers.change();assert.equal(input.value,'Fetched-V2');
});

// Real production router/loader and console authentication with synthetic QQ only.
test('chatgpt2api HTTP integration loads disabled skills, guards auth/profile context and binds keys', {timeout:60000},async t=>{
  const root=tmp(t),token='offline-chatgpt2api-console-token';let child,output='',context,calls=0;
  const server=http.createServer((req,res)=>{calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'gpt-image-2.5-flare'},{id:'Text-Custom'}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const probe=http.createServer().listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  t.after(async()=>{if(child){const end=once(child,'exit');child.kill('SIGKILL');await end;}server.closeAllConnections();await new Promise(r=>server.close(r));});
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({qqbot:{appId:'111',clientSecret:'FAKE',enabled:true},extensions:{hotReload:false}}));
  child=fork(fileURLToPath(new URL('./helpers/docker-profiles-fixture.mjs',import.meta.url)),[],{env:{...process.env,QQ_AGENT_DOCKER:'1',QQ_AGENT_CHANNEL:'qqbot',QQ_AGENT_DATA_DIR:root,QQ_AGENT_PROFILES_ROOT:'',QQ_AGENT_ACTIVE_ROBOT:'',QQ_AGENT_CONSOLE_TOKEN:token,QQ_AGENT_INTERNAL_PORT:String(port),QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',TEST_LLM_URL:''},stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  await new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(Error('not ready')));child.once('exit',c=>reject(Error(`startup ${c}: ${output}`)));});
  const request=(url,data,headers={})=>fetch(`http://127.0.0.1:${port}${url}`,{method:data===undefined?'GET':'POST',headers:{'content-type':'application/json','x-console-token':token,...(context?{'x-qq-profile-context':context}:{}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
  async function api(url,data){const r=await request(url,data);const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
  context=(await api('/api/robots')).context;
  const skills=(await api('/api/skills')).skills;
  for(const type of ['image','search']){const s=skills.find(s=>s.id===`chatgpt2api-${type}`);assert.equal(s.loaded,true);assert.equal(s.enabled,false);}
  assert.equal(calls,0);
  const route='/api/skills/chatgpt2api-image',catalog=route+'/model-catalog';
  assert.equal((await request(catalog,{}, {'x-console-token':'WRONG'})).status,401);
  assert.equal((await request(catalog,{}, {'x-qq-profile-context':'stale'})).status,409);
  const saved=await api(route,{settings:{baseUrl:base,apiKey:'OFFLINE_STORED_KEY',model:'web-image/Exact'}});assert.ok(!JSON.stringify(saved).includes('OFFLINE_STORED_KEY'));
  assert.deepEqual((await api(catalog)).models,[]);assert.equal(calls,0);
  assert.deepEqual((await api(catalog,{})).models,['gpt-image-2.5-flare']);assert.equal(calls,1);
  await api(route,{settings:{baseUrl:base+'/v1',apiKey:''}});assert.deepEqual((await api(catalog)).models,['gpt-image-2.5-flare']);
  const changed=await api(route,{settings:{baseUrl:base+'/different',apiKey:'******'}});assert.equal(changed.settings.apiKey,'');
  assert.equal((await request(catalog,{})).status,400);assert.equal(calls,1);
  const end=once(child,'exit');child.kill('SIGTERM');await end;child=null;
});
