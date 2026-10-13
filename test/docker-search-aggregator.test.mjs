import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {aggregate,normalizeUrl,parseResults,bingHtml} from '../plugins/search-aggregator/lib/aggregate.js';
import {createAggregator,configuration} from '../plugins/search-aggregator/lib/runtime.js';
import {createSearchSkill} from '../skills/chatgpt2api-search/runtime.js';
import {setup as setupTool} from '../skills/search-aggregator-skill/index.js';
import {setup as setupImage} from '../skills/image-gen-skill/index.js';
import {unsentQueryReplyReminder} from '../src/reply-completion.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const item=(n='one',domain='example.test')=>({title:`title ${n}`,url:`https://${domain}/${n}`,snippet:`snippet ${n}`});
const html=(url='https://example.test/news')=>`<html><a href="https://navigation.test/login">login</a><h2 class="title"><a href="${url}">Fixture title &amp; news</a></h2><p>A bounded result snippet</p></html>`;
const names=['bing','so360','baiduWeb','sogou'];
function fixture({config={},engines,capability,fetcher,has=true}={}) {
  let cfg=config;const calls=[];const mod=createAggregator({engines});
  const api={config:()=>cfg,hasCapability:()=>has,capability:capability||(()=>{throw Error('unexpected GPT call');}),
    fetch:fetcher || (async(url,options)=>{calls.push({url,options});return new Response(html());})};
  mod.setup(api);
  return {mod,calls,api,search:mod.providers['search.aggregate'],setConfig(c){cfg=c;}};
}
function adapters(fn) {return Object.fromEntries(names.map(n=>[n,(...args)=>fn(n,...args)]));}
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('default engines actually make four permission-injected searches; startup does nothing',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.mod.available().ok,true);
  const r=await f.search({query:'fixture only'});assert.equal(f.calls.length,4);
  assert.deepEqual(r.enginesUsed,names);assert.deepEqual(r.results[0].engines,names);assert.equal(r.allFailed,false);
  assert.ok(f.calls.every(x=>!x.options.headers.Authorization && x.options.redirect==='error'));
  assert.deepEqual(f.calls.map(x=>new URL(x.url).hostname),['cn.bing.com','www.so.com','www.baidu.com','www.sogou.com']);
});

test('engine aliases/deduplication, zero boost and validation do not waste requests',async()=>{
  const f=fixture({config:{engines:'bing,bingHtml,bing',consensusBoost:0}});
  assert.equal(configuration({consensusBoost:0}).consensusBoost,0);
  assert.equal((await f.search({query:'q'})).results.length,1);assert.equal(f.calls.length,1);
  for(const config of [{engines:'unknown'},{engines:''},{engines:'__proto__'},{timeoutMs:-1},{chatgptMode:'bad'},{maxResults:0}]){
    f.setConfig(config);assert.equal(f.mod.available().ok,false);await assert.rejects(f.search({query:'q'}));
  }
  f.setConfig({});for(const args of [{},{query:'  '},{query:'q',maxResults:0},{query:'q',maxResults:1.5}])await assert.rejects(f.search(args));
  assert.equal(f.calls.length,1);
});

test('HTML parsing excludes navigation, decodes entities/known redirects and bounds fetched bodies',async()=>{
  assert.deepEqual(parseResults('<a href="https://example.test/login">login and terms</a>','https://cn.bing.com/search'),[]);
  const destination='https://example.test/article?a=1&b=2';
  const wrapped='https://www.bing.com/ck/a?u=a1'+Buffer.from(destination).toString('base64url');
  assert.equal(parseResults(html(wrapped),'https://cn.bing.com/search')[0].url,destination);
  assert.equal(parseResults(html('https://example.test/?a=1&amp;b=2'),'https://www.so.com/s')[0].url,'https://example.test/?a=1&b=2');
  assert.deepEqual(parseResults(html('javascript:alert(1)'),'https://www.so.com/s'),[]);
  assert.equal(parseResults("<h3><a href='/link?url=opaque'>标题</a></h3><div class='c-abstract'>概要</div>",'https://www.baidu.com/s')[0].snippet,'概要');
  for(const response of [new Response('x',{status:429}),new Response('x'.repeat(2*1048576+1)),new Response('x',{headers:{'content-length':3*1048576}})]) {
    await assert.rejects(bingHtml('q',{fetcher:async()=>response}));
  }
});

test('URL normalization/fusion ignores unsafe URLs and same-engine duplicates, preserves real query IDs',()=>{
  assert.equal(normalizeUrl('https://EXAMPLE.test/a?id=2&utm_source=x#x'),'https://example.test/a?id=2');
  assert.notEqual(normalizeUrl('https://example.test/a?id=1'),normalizeUrl('https://example.test/a?id=2'));
  for(const s of ['file:///x','javascript:x','https://user:pass@example.test','bad'])assert.equal(normalizeUrl(s),'');
  const r=aggregate([{engine:'bing',items:[item('a'),item('a'),{...item('a'),url:item('a').url+'?utm_source=one'},item('b')]},
    {engine:'sogou',items:[item('a'),item('c','elsewhere.test')]},{engine:'bing',items:[item('a')]}],{maxPerDomain:1});
  assert.equal(r.items.length,2);assert.deepEqual(r.items[0].engines,['bing','sogou']);
  assert.equal(r.items[0].score,Math.round(2/61*1.25*10000)/10000);
});

test('parallel partial failures and empty pages are not reported as no-news success',async()=>{
  const f=fixture({engines:adapters(n=>{if(n==='bing')throw Error('PRIVATE upstream details');return n==='so360'?[item()]:[];})});
  const r=await f.search({query:'q'});assert.equal(r.allFailed,false);assert.equal(r.results.length,1);
  assert.equal(r.engineStatus[0].status,'failed');assert.equal(r.engineStatus[2].status,'empty');assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
  const empty=await fixture({engines:adapters(()=>[])}).search({query:'q'});assert.equal(empty.allFailed,false);
  const failed=await fixture({engines:adapters(()=>{throw Error('fail');})}).search({query:'q'});assert.equal(failed.allFailed,true);
});

test('HTML sources run concurrently and output ordering is deterministic',async()=>{
  let release;const gate=new Promise(r=>release=r);const seen=[];
  const f=fixture({engines:adapters(async n=>{seen.push(n);await gate;return [item(n)];})});
  const p=f.search({query:'q'});await delay(1);assert.deepEqual(seen,names);release();
  assert.deepEqual((await p).engineStatus.map(x=>x.engine),names);
});

test('ChatGPT only and mixed search reuse capability, preserve uncited answer separately, never summarize twice',async()=>{
  const calls=[];
  const f=fixture({config:{engines:'chatgpt2api,chatgpt2api'},capability:async(name,args)=>{calls.push({name,args});return {answer:'Synthetic answer',sources:[],_account_email:'PRIVATE'};}});
  const r=await f.search({query:'q',maxResults:20});assert.equal(f.calls.length,0);assert.equal(calls.length,1);
  assert.equal(calls[0].name,'search.chatgpt2api');assert.equal(calls[0].args.summarize,false);assert.equal(calls[0].args.maxResults,15);
  assert.equal(r.results.length,0);assert.equal(r.answers[0].hasSources,false);assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
  f.setConfig({engines:'bing,chatgpt2api'});await f.search({query:'q'});assert.equal(f.calls.length,1);assert.equal(calls.length,2);
});

test('explicit GPT fallback calls it at most once, only when ordinary sources lack usable links',async()=>{
  let gpt=0,items=[item()];const f=fixture({config:{engines:'bing,chatgpt2api',chatgptMode:'fallback'},engines:adapters(()=>items),
    capability:async()=>{gpt++;return {answer:'Fallback',sources:[item('gpt')]};}});
  assert.equal((await f.search({query:'q'})).engineStatus[1].status,'skipped');assert.equal(gpt,0);
  items=[{url:'javascript:fake'}];assert.equal((await f.search({query:'q'})).results.length,1);assert.equal(gpt,1);
  f.setConfig({engines:'bing'});await f.search({query:'q'});assert.equal(gpt,1);
});

test('missing/disabled GPT preserves ordinary results and never auto enables it',async()=>{
  const f=fixture({config:{engines:'bing,chatgpt2api'},has:false});
  assert.equal(f.mod.available().ok,true);const r=await f.search({query:'q'});
  assert.equal(r.results.length,1);assert.equal(r.engineStatus[1].status,'unavailable');
  f.setConfig({engines:'chatgpt2api'});assert.equal(f.mod.available().ok,false);
  assert.equal((await f.search({query:'q'})).allFailed,true);assert.equal(f.calls.length,1);
});

test('timeouts, external abort and deactivation bound waiting even if adapter ignores signals',async()=>{
  let signal;const f=fixture({config:{engines:'bing',timeoutMs:100},engines:adapters((n,q,o)=>{signal=o.signal;return new Promise(()=>{});})});
  assert.equal((await f.search({query:'q'})).allFailed,true);assert.equal(signal.aborted,true);
  const pending=f.search({query:'q',timeoutMs:10});await assert.rejects(pending,/预算/);assert.equal(signal.aborted,true);
  const c=new AbortController();const p=f.search({query:'q',signal:c.signal});c.abort();await assert.rejects(p,/停止/);
  const next=f.search({query:'q'});await delay(1);f.mod.deactivate();await assert.rejects(next,/停止/);await assert.rejects(f.search({query:'q'}),/停止/);
});

test('GPT fallback does not start after caller deadline expires',async()=>{
  let gpt=0;const f=fixture({config:{engines:'bing,chatgpt2api',chatgptMode:'fallback'},
    engines:adapters(()=>new Promise(()=>{})),capability:()=>{gpt++;throw Error('should not start');}});
  await assert.rejects(f.search({query:'q',timeoutMs:10}));assert.equal(gpt,0);
});

test('consumer dispatches only on execute and sees late enabled/disabled providers',async()=>{
  let calls=0,enabled=false,tool;setupTool({registerTool:t=>tool=t,capability:async(name,args)=>{calls++;assert.equal(name,'search.aggregate');return enabled?{results:[item()],answers:[],allFailed:false}:undefined;}});
  assert.equal(calls,0);assert.equal(tool.requiresSearch,true);
  assert.equal((await tool.execute({},{})).isError,true);assert.equal(calls,0);
  assert.equal((await tool.execute({},{query:'q'})).isError,true);enabled=true;
  assert.ok(!(await tool.execute({},{query:'q'})).isError);assert.equal(calls,2);
  enabled=false;assert.equal((await tool.execute({},{query:'q'})).isError,true);
});

test('image calibration dispatches lazily with deadline, respects rewrite switch and does not draw/send',async()=>{
  let tool,calls=0,cfg={searchTimeoutMs:1234,searchRewrite:false};
  setupImage({registerTool:t=>tool=t,config:()=>cfg,capability:async(name,args)=>{calls++;assert.equal(args.timeoutMs,1234);return {results:[item()]};}});
  assert.equal(calls,0);let r=JSON.parse((await tool.execute({},{prompt:'fixture'})).content);
  assert.equal(r.calibrated_prompt,'fixture');assert.match(r.facts,/snippet/);assert.match(r.next,/chatgpt2api-image__draw/);
  cfg={...cfg,searchRewrite:true};r=JSON.parse((await tool.execute({},{prompt:'fixture'})).content);assert.match(r.calibrated_prompt,/检索补充/);
  cfg={...cfg,searchFirst:false};await tool.execute({},{prompt:'fixture'});assert.equal(calls,2);
});

test('shared GPT provider calls search only, strips account fields, accepts cancellation and remains isolated',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-search-provider-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let cfg={baseUrl:'http://fixture.test',apiKey:'FIXTURE_SECRET',model:'Custom-Case',timeoutMs:10000};const calls=[];
  const skill=createSearchSkill({dataDir:dir});skill.setup({config:()=>cfg,registerTool(){},fetch:async(url,options)=>{calls.push({url,options});return Response.json({answer:'Result FIXTURE_SECRET',sources:[item()],_account_email:'private@example.test'});}});
  const r=await skill.providers['search.chatgpt2api']({query:'q'});assert.equal(calls.length,1);assert.equal(calls[0].url,'http://fixture.test/v1/search');
  assert.deepEqual(JSON.parse(calls[0].options.body),{prompt:'q'});assert.doesNotMatch(JSON.stringify(r),/FIXTURE_SECRET|private@example/);
  cfg={...cfg,apiKey:'SECOND_FIXTURE_KEY'};await skill.providers['search.chatgpt2api']({query:'q'});assert.equal(calls[1].options.headers.Authorization,'Bearer SECOND_FIXTURE_KEY');
  const c=new AbortController();c.abort();await assert.rejects(skill.providers['search.chatgpt2api']({query:'q',signal:c.signal}));assert.equal(calls.length,2);
  skill.deactivate();await assert.rejects(skill.providers['search.chatgpt2api']({query:'q'}));assert.equal(calls.length,2);
});

test('aggregation search is eligible for one bounded post-query reminder, not automatic QQ publishing',()=>{
  const name='search-aggregator-skill__web_search_agg';const base={kind:'group',trigger:[{mid:'current',atMe:true}],canSend:true,
    messages:[{role:'assistant',tool_calls:[{id:'c',function:{name,arguments:'{}'}}]},{role:'tool',tool_call_id:'c',name,content:'result'},{role:'assistant',content:''}]};
  assert.ok(unsentQueryReplyReminder(base));assert.equal(unsentQueryReplyReminder({...base,alreadyReminded:true}),'');
  assert.equal(unsentQueryReplyReminder({...base,sent:[{}]}),'');
});

test('manifest settings render as supported dropdown; defaults remain off and nested copies stay in sync',()=>{
  const read=p=>fs.readFileSync(path.join(root,p),'utf8');
  const manifest=JSON.parse(read('plugins/search-aggregator/plugin.json'));assert.equal(manifest.enabledByDefault,false);assert.equal(manifest.settings.engines.includes('chatgpt2api'),false);
  assert.deepEqual(manifest.permissions,['web_fetch']);assert.deepEqual(manifest.configSchema.chatgptMode.values,['parallel','fallback']);
  const scope=vm.createContext({esc:s=>String(s??''),state:{}});vm.runInContext(read('ui/app/06-settings-render.js'),scope);
  assert.match(scope.renderSkillSettingsModal({...manifest,settings:manifest.settings}).html,/<select[^>]+data-key="chatgptMode"[^>]*>[\s\S]*?value="fallback"/);
  for(const [base,files] of [['plugins/search-aggregator',['index.js','plugin.json','lib/aggregate.js','lib/runtime.js']],['skills/search-aggregator-skill',['index.js','skill.json']],['skills/image-gen-skill',['index.js','skill.json']]]) {
    for(const file of files)assert.equal(read(`${base}/${file}`),read(`${base}/${path.basename(base)}/${file}`));
  }
});

test('real loader: disabled startup, dynamic capability, GPT aggregation, reload, gate and unchanged config',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-aggregate-host-'));const oldData=process.env.QQ_AGENT_DATA_DIR,oldFetch=globalThis.fetch;
  process.env.QQ_AGENT_DATA_DIR=path.join(dir,'data');process.env.QQ_AGENT_DOCKER='1';
  fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');fs.symlinkSync(path.join(root,'src'),path.join(dir,'src'),'dir');
  for(const p of ['plugins/search-aggregator','skills/chatgpt2api-search','skills/search-aggregator-skill','skills/image-gen-skill'])fs.cpSync(path.join(root,p),path.join(dir,p),{recursive:true});
  const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});assert.ok(url==='http://fixture.test/v1/search' || url.startsWith('https://cn.bing.com/search?'));
    return url.startsWith('http:')?Response.json({answer:'GPT synthetic',sources:[item('gpt')]}):new Response(html());};
  const {loadPlugins}=await import('../src/plugin-loader.js');const {skillManager}=await import('../src/skills/manager.js');
  const {setSkillConfig}=await import('../src/skills/config.js');const {getTool,getToolAvailability}=await import('../src/tool-registry.js');
  t.after(()=>{for(const s of skillManager.registry.list())skillManager.unregister(s.manifest.id);globalThis.fetch=oldFetch;
    if(oldData===undefined)delete process.env.QQ_AGENT_DATA_DIR;else process.env.QQ_AGENT_DATA_DIR=oldData;fs.rmSync(dir,{recursive:true,force:true});});
  const roots={skills:path.join(dir,'skills'),plugins:path.join(dir,'plugins')};
  const loaded=await loadPlugins({roots,log:()=>{}});assert.deepEqual(loaded.failed,[]);assert.equal(calls.length,0);
  const id='search-aggregator-skill__web_search_agg';const tool=getTool(id);assert.ok(tool);assert.equal(skillManager.hasCapability('search.aggregate'),false);
  setSkillConfig('search-aggregator',{enabled:true,engines:'bing,chatgpt2api'});skillManager.activate('search-aggregator');
  setSkillConfig('search-aggregator-skill',{enabled:true});skillManager.activate('search-aggregator-skill');
  let result=await tool.execute({},{query:'fixture'});assert.ok(!result.isError,result.content);assert.match(result.content,/unavailable/);assert.equal(calls.length,1);
  setSkillConfig('chatgpt2api-search',{enabled:true,baseUrl:'http://fixture.test',apiKey:'OFFLINE_AGGREGATE_KEY',model:'Custom-Case',timeoutMs:10000});skillManager.activate('chatgpt2api-search');
  assert.equal(getToolAvailability(id,{searchEnabled:false}).code,'no-search');
  assert.equal(getToolAvailability(id,{searchEnabled:true}).enabled,true);
  const configFile=path.join(dir,'data/config.json'),before=fs.readFileSync(configFile);
  result=await tool.execute({},{query:'fixture'});assert.ok(!result.isError,result.content);assert.match(result.content,/GPT synthetic/);assert.equal(calls.length,3);
  const count=calls.length;assert.deepEqual((await loadPlugins({roots,log:()=>{}})).failed,[]);assert.equal(calls.length,count);
  result=await getTool(id).execute({},{query:'fixture'});assert.ok(!result.isError,result.content);assert.equal(calls.length,count+2);assert.deepEqual(fs.readFileSync(configFile),before);
  // The shared provider is only exposed while the supplying skill is enabled.
  setSkillConfig('chatgpt2api-search',{enabled:false});skillManager.deactivate('chatgpt2api-search');assert.equal(skillManager.hasCapability('search.chatgpt2api'),false);
  setSkillConfig('search-aggregator',{enabled:false});skillManager.deactivate('search-aggregator');assert.equal((await getTool(id).execute({},{query:'fixture'})).isError,true);
});
