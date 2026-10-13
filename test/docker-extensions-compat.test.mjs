import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'extensions-regression-'));
process.env.QQ_AGENT_DATA_DIR = data;
process.env.QQ_AGENT_DOCKER = '1';
globalThis.fetch = async () => { throw Error('OFFLINE: unexpected network'); };
const A = 'A1'.repeat(16), B = 'B2'.repeat(16), G = 'C3'.repeat(16), H = 'D4'.repeat(16);
const ctx = (chatKey = `group:${G}`, userId = A) => ({ chatKey, kind: chatKey.split(':')[0], chatId: chatKey.split(':')[1], session: { trigger: [{ senderId: userId, text: '周末旅行', messageId: 'synthetic' }], sent: [] } });
const manifests = [];
for (const kind of ['skills', 'plugins']) for (const name of fs.readdirSync(path.join(root, kind))) {
  const dir = path.join(root, kind, name); if (!fs.statSync(dir).isDirectory()) continue;
  const file = ['skill.json', 'plugin.json'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
  if (file) manifests.push({ kind, dir, m: JSON.parse(fs.readFileSync(file)) });
}
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ skills: Object.fromEntries(manifests.map(({m}) => [m.id, {enabled:false}])) }));
after(() => fs.rmSync(data, { recursive: true, force: true }));
function apiFor(settings = {}, capabilities = {}) {
  const tools = new Map(), calls = [];
  return { tools, calls, config: () => settings, registerTool: t => tools.set(t.id, t), log() {}, warn() {}, error() {}, hasCapability: n => !!capabilities[n], capability: (n,a) => { calls.push([n,a]); return capabilities[n]?.(a); }, utils: { safeJsonParse: s => JSON.parse(s), sleep: async () => {} }, fetch: async () => { throw Error('OFFLINE'); } };
}
const { memberId, requesterId } = await import('../src/extension-context.js');
test('extension IDs and requester come from exact frozen triggers, never last speaker', () => {
  assert.equal(memberId(A), A); assert.equal(memberId('../x'), ''); assert.equal(memberId('<@'+A+'>'), '');
  assert.equal(requesterId(ctx()), A); assert.equal(requesterId({ ...ctx(), session:{trigger:[{senderId:A},{senderId:B}]}}), '');
});
for (const [id, tool, cap, response, args] of [
  ['emotion-skill','mood_state','bodystate.status',{ok:true,emotions:{},axes:{}},{}],
  ['feeling-skill','check_affinity','affinity.query',{ok:true,tier:{},responseProfile:{}},{userId:A}],
  ['mood-skill','mood_status','mood.status',{ok:true},{}],
  ['threads-skill','list_discussions','threads.select',{total:1,active:[{topic:'x',score:1}],dormant:[]},{}],
  ['meme-lib','meme_search','meme.data',{ok:true,items:[]},{query:'test'}],
  ['memory-growth-skill','memory_search','memory.recall',{hits:[{content:'周末旅行',score:1}]},{query:'周末旅行'}],
  ['knowledge-verify','kb_recall','knowledge.recall',{context:'synthetic result',source:'kb'},{query:'test'}]
]) test(`${id}: late provider, await, disabled and provider failure`, async () => {
  const mod = await import(`../skills/${id}/index.js`), caps = {}, api = apiFor({},caps); mod.setup(api);
  assert.equal(api.calls.length, 0, 'setup must not execute capabilities');
  const exec = () => api.tools.get(tool).execute(ctx(), args);
  assert.equal((await exec()).isError, true);
  caps[cap] = async () => response;
  assert.notEqual((await exec()).isError, true);
  assert.equal(api.calls.at(-1)[0], cap);
  caps[cap] = () => { throw Error('synthetic failure'); };
  assert.equal((await exec()).isError, true);
  delete caps[cap]; assert.equal((await exec()).isError,true);
});
test('conv-memory writes exact official OpenID and rejects malformed/empty input', async () => {
  const mod = await import('../skills/conv-memory-skill/index.js'), api = apiFor(); mod.setup(api);
  let call; const c = {...ctx(),memory:{append:(...args)=>{call=args; return {id:'fixture'};}}};
  const tool = api.tools.get('memory_append');
  assert.notEqual((await tool.execute(c,{userId:A,category:'memberImpression',content:'喜欢旅行'})).isError,true);
  assert.equal(call[3].userId,A);
  for (const userId of ['../file','<@'+A+'>','']) assert.equal((await tool.execute(c,{userId,content:'test'})).isError,true);
  assert.equal((await tool.execute(c,{userId:A,content:''})).isError,true);
});
test('todo: per-person dedupe, OpenID, injection session isolation, complete, write failure', async () => {
  const mod = await import('../skills/todo-skill/index.js'); mod.setup(apiFor()); mod.activate();
  const ck=`group:${G}`;
  assert.equal(mod.saveTodo({chatKey:ck,text:'周末旅行',userId:A}).ok,true);
  assert.equal(mod.saveTodo({chatKey:ck,text:'周末旅行',userId:B}).deduped,undefined);
  assert.equal(mod.saveTodo({chatKey:ck,text:'周末旅行',userId:A}).deduped,true);
  assert.equal(mod.saveTodo({chatKey:ck,text:'x',userId:'bad'}).ok,false);
  mod.hooks['before-context']({chatKey:ck,sessionId:'s1',triggerEntries:[{senderId:A}]});
  mod.hooks['before-context']({chatKey:`group:${H}`,sessionId:'s2',triggerEntries:[{senderId:A}]});
  const messages=[{role:'user',content:'hi'}]; mod.hooks['before-llm-messages']({sessionId:'s2',messages}); assert.equal(messages[0].content,'hi');
  mod.hooks['before-llm-messages']({sessionId:'s1',messages}); assert.match(messages[0].content,/周末旅行/);
  assert.equal(mod.completeTodo({chatKey:ck,text:'周末旅行'}),true);
  fs.mkdirSync(path.join(data,'todo-skill','pending-todos.json.'+process.pid+'.tmp'));
  assert.throws(()=>mod.saveTodo({chatKey:ck,text:'write failure',userId:A}));
});
test('threads: actual hook sessionId and changed scope; clear on disable', async () => {
  const mod = await import('../plugins/threads/index.js'); const api=apiFor({inject:true,activeThreshold:0}); mod.setup(api);
  mod.providers['threads.record']({chatKey:`group:${G}`,topic:'周末旅行',summary:'还未定地点',unresolved:80});
  mod.hooks['before-context']({chatKey:`group:${G}`,sessionId:'t1',triggerEntries:[{text:'周末旅行'}]});
  mod.hooks['before-context']({chatKey:`group:${H}`,sessionId:'t2',triggerEntries:[]});
  const messages=[{role:'system',content:'base'}]; mod.hooks['before-llm-messages']({sessionId:'t2',messages}); assert.equal(messages[0].content,'base');
  mod.hooks['before-llm-messages']({sessionId:'t1',messages}); assert.match(messages[0].content,/周末旅行/);
  mod.deactivate();
});
test('proactive guard respects live shared mute/unmute and never performs setup check', async () => {
  const mod = await import('../plugins/proactive-chat/index.js'); let muted=true;
  const api=apiFor({enabled:true},{'chat.ban-state':()=>({muted})}); mod.setup(api); await mod.activate();
  assert.equal(api.calls.length,0);
  assert.equal(mod.providers['chat.run-guard']({chatKey:`group:${G}`}).block,true);
  muted=false;
  assert.equal(mod.providers['chat.run-guard']({chatKey:`group:${G}`}).block,false);
  await mod.deactivate();
});
test('knowledge paths stay under profile, lexical maximum reaches default threshold', async () => {
  const {resolvePath}=await import('../plugins/kb-growth/lib/kb-config.js');
  assert.equal(resolvePath('kb-growth/local-chunks.jsonl'),path.join(data,'kb-growth/local-chunks.jsonl'));
  assert.throws(()=>resolvePath('../outside')); assert.throws(()=>resolvePath('/outside'));
  const {retrieveFromKb,buildKbContext}=await import('../plugins/kb-growth/lib/kb-retrieve.js');
  let pipeline; const mongo={db:{collection:()=>({aggregate:p=>{pipeline=p;return {toArray:async()=>[{hit_count:2,title:'test',content:'test',source_url:'https://example.com/'}]};}})}};
  const r=await retrieveFromKb(mongo,{tenant:'one',query:'hello world'});
  assert.equal(r.hits.length,1); assert.equal(r.confidence,1); assert.equal(pipeline[0].$match.tenant_id,'one');
  assert.match(buildKbContext(r.hits),/https:\/\/example.com/);
});
test('memory retrieval: matching lexical item reaches threshold, exact chat scope, no unrelated hits', async () => {
  const {recallMemory}=await import('../plugins/memory-growth/lib/mg-retrieve.js');let filter;
  const db={collection:()=>({find:f=>{filter=f;return {sort(){return this;},limit(){return this;},toArray:async()=>[{content:'hello world',embedding:[1,0]}]};}})};
  const r=await recallMemory(db,{},{tenant:'tenant',chatKey:`group:${G}`,query:'hello world'});
  assert.equal(r.hits[0].score,1); assert.equal(filter.chat_key,`group:${G}`);
  assert.equal((await recallMemory(db,{},{tenant:'tenant',chatKey:`group:${G}`,query:'totally unrelated'})).hits.length,0);
});
test('admin loop: explicit allowlist, pending before send, exact private answer and group-only lookup', async () => {
  const {updateConfig}=await import('../src/config.js'); updateConfig({allow:{private:[A],groups:[G]},deny:{private:[],groups:[]}});
  const mod=await import('../skills/ask-admin-skill/index.js');const api=apiFor({adminUserId:A});mod.setup(api);
  let calls=0;
  const c={...ctx(),sender:{sendTextBatch:async(key)=>{calls++;assert.equal(key,`private:${A}`);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'ask-admin/internal-knowledge.json'))).knowledge.at(-1).status,'sending');}}};
  const r=await api.tools.get('ask_admin').execute(c,{question:'旅行计划是什么'}); assert.notEqual(r.isError,true);assert.equal(calls,1);
  await api.tools.get('ask_admin').execute(c,{question:'旅行计划是什么'});assert.equal(calls,1);
  const item=JSON.parse(fs.readFileSync(path.join(data,'ask-admin/internal-knowledge.json'))).knowledge[0];
  let out=await api.tools.get('answer_admin').execute(ctx(`private:${B}`,B),{id:item.id,answer:'周末出发'});assert.equal(out.isError,true);
  mod.hooks['before-context']({kind:'private',chatId:A,chatKey:`private:${A}`,triggerEntries:[{senderId:A,text:`答复 ${item.id} 周末出发`}],sessionId:'admin'});
  out=await api.tools.get('internal_knowledge').execute(ctx(),{query:'旅行'});assert.match(out.content,/周末出发/);
  out=await api.tools.get('internal_knowledge').execute(ctx(`group:${H}`),{query:'旅行'});assert.equal(out.content,'[]');
  c.sender.sendTextBatch=async()=>{throw Error('timeout')};
  assert.equal((await api.tools.get('ask_admin').execute(c,{question:'另一个问题'})).isError,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'ask-admin/internal-knowledge.json'))).knowledge.at(-1).status,'unknown');
});
test('verify-first uses permission-gated bounded safe fetch and reports failure/quotes', async () => {
  const mod=await import('../examples/skills/verify-first/index.js');const api=apiFor();let calls=0;
  api.safeFetchText=async(url,opts)=>{calls++;assert.equal(opts.browseLocked,true);assert.ok(opts.maxBytes<=5e6);return {statusCode:200,body:'<p>旅行计划周末出发。</p>',contentType:'text/html'};};mod.setup(api);
  const tool=api.tools.get('verify_quote');assert.match((await tool.execute({}, {url:'https://example.com',keywords:'旅行'})).content,/周末出发/);
  assert.equal((await tool.execute({}, {url:'http://user:pass@example.com',keywords:'旅行'})).isError,true);assert.equal(calls,1);
  api.safeFetchText=async()=>{throw Error('blocked')}; assert.equal((await tool.execute({}, {url:'http://[fd00::1]',keywords:'test'})).isError,true);
});
// Every shipping directory participates: import and syntax are checked even when disabled.
for(const {kind,dir,m} of manifests) test(`${kind}/${m.id}: manifest, JS syntax and relative imports`, () => {
  assert.ok(['model','message','knowledge','media','utility'].includes(m.category || 'utility'));
  const walk = d => { for(const ent of fs.readdirSync(d,{withFileTypes:true})){const file=path.join(d,ent.name);if(ent.isDirectory())walk(file);else if(file.endsWith('.js')){
    const check=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
    const src=fs.readFileSync(file,'utf8');for(const match of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g))assert.ok(fs.existsSync(path.resolve(path.dirname(file),match[1])),file+': '+match[1]);
  } } };walk(dir);
});
test('all bundled modules: unique identities, real loader, declared capability parity and object tool schemas', async () => {
  assert.equal(new Set(manifests.map(x=>x.m.id)).size,manifests.length);
  const {loadPlugins}=await import('../src/plugin-loader.js');const {skillManager}=await import('../src/skills/manager.js');const {listTools}=await import('../src/tool-registry.js');
  const r=await loadPlugins({roots:{skills:path.join(root,'skills'),plugins:path.join(root,'plugins')},log:()=>{}});
  assert.deepEqual(r.failed,[]);
  for(const sk of skillManager.registry.list())assert.deepEqual(Object.keys(sk.providers||{}).sort(),[...(sk.manifest.capabilities||[])].sort(),sk.manifest.id);
  for(const t of listTools()){assert.equal(t.parameters.type,'object');assert.equal(typeof t.execute,'function');}
  for(const sk of [...skillManager.registry.list()])skillManager.unregister(sk.manifest.id);
});
