import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeJson, readJson, profileDir } from '../src/robot-profiles.js';

test('multi-bot HTTP: migration, save, switch, switch back, QR, shared models, stale tabs and isolated history/memory', {timeout:60_000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-profiles-http-'));
  const token='profile-test-console-token-abcdefghijklmnopqrstuvwxyz';
  let child, output='', context;
  t.after(()=>{child?.kill('SIGKILL');fs.rmSync(root,{recursive:true,force:true});});
  const socket=net.createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening');
  const port=socket.address().port; await new Promise(r=>socket.close(r));
  writeJson(path.join(root,'config.json'),{
    qqbot:{appId:'111',clientSecret:'BOT_A_SECRET',enabled:true},
    api:{baseUrl:'https://example.invalid/v1',model:'shared-first',apiKey:'MODEL_SHARED_SECRET'},
    allow:{private:['USER_with-hyphen'],groups:[]},persona:{botName:'Robot A'},extensions:{hotReload:false},
  });
  const oldConfig=fs.readFileSync(path.join(root,'config.json'),'utf8');
  async function boot() {
    child=fork(fileURLToPath(new URL('./helpers/docker-profiles-fixture.mjs',import.meta.url)),[],{
      env:{...process.env,QQ_AGENT_DOCKER:'1',QQ_AGENT_CHANNEL:'qqbot',QQ_AGENT_DATA_DIR:root,
        QQ_AGENT_PROFILES_ROOT:'',QQ_AGENT_ACTIVE_ROBOT:'',QQ_AGENT_CONSOLE_TOKEN:token,QQ_AGENT_INTERNAL_PORT:String(port),QQBOT_APP_ID:'',QQBOT_APP_SECRET:''},
      stdio:['ignore','pipe','pipe','ipc'],
    });
    child.stdout.on('data',x=>{output+=x;});child.stderr.on('data',x=>{output+=x;});
    await new Promise((resolve,reject)=>{
      child.once('message',m=>m.ready?resolve():reject(new Error(JSON.stringify(m))));
      child.once('exit',code=>reject(new Error(`startup ${code}: ${output}`)));
    });
  }
  const base=`http://127.0.0.1:${port}`;
  const headers=()=>({'content-type':'application/json','x-console-token':token,...(context?{'x-qq-profile-context':context}:{})});
  const req=(url,body,overrides={})=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...headers(),...overrides},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function json(url,body) {const r=await req(url,body);const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;}
  async function ipc(action,data={}) {const reply=once(child,'message');child.send({id:action,action,...data});const [m]=await reply;assert.equal(m.error,undefined);return m;}
  async function switchTo(id) {
    const ended=once(child,'exit');assert.equal((await json('/api/robots/switch',{appId:id})).switching,true);
    assert.equal((await ended)[0],0);child=null;await boot();
    const old=context;context=undefined;
    const data=await json('/api/robots');context=data.context;assert.equal(data.active,id);assert.notEqual(context,old);return old;
  }
  await boot(); const data=await json('/api/robots');context=data.context;assert.equal(data.active,'111');
  assert.equal((await fetch(base+'/api/robots')).status,401);
  const html=await (await req('/connection.html')).text();
  assert.ok(html.includes(`content="${context}"`));assert.ok(html.includes('/profile-context.js'));assert.ok(html.includes('id="robot-switch"'));assert.ok(html.includes('id="robot-delete"'));assert.ok(html.includes('id="robot-delete-dialog"'));
  assert.equal((await req('/api/robots/save',{appId:'222',appSecret:'B'},{'x-qq-profile-context':''})).status,409);
  assert.equal((await req('/api/robots/save',{appId:'222',appSecret:'B'},{origin:'https://evil.invalid'})).status,403);
  assert.equal((await req('/api/events',undefined,{'x-qq-profile-context':''})).status,409);
  assert.equal((await req('/api/config',{qqbot:{appId:''}})).status,409);
  assert.equal((await req('/api/config',{qqbot:{__replace__:{appId:'222'}}})).status,409);
  assert.equal((await req('/api/reset-data',{})).status,409);
  await ipc('receive');await ipc('profile-memory',{text:'ONLY_A_MEMORY'});
  const memoryA=(await ipc('profile-memory-read')).value;assert.ok(JSON.stringify(memoryA).includes('ONLY_A_MEMORY'));
  const messages='/api/chats/private_USER_with-hyphen/messages';
  assert.equal((await json(messages)).messages.length,1);
  const saved=await json('/api/robots/save',{appId:'222',appSecret:'BOT_B_SECRET',name:'Robot B'});assert.equal(saved.switching,false);
  assert.equal((await json('/api/robots')).accounts.length,2);
  const oldContext=await switchTo('222');
  for(const [url,body] of [['/api/robots/delete',{appId:'111',confirmAppId:'111'}],['/api/config',{persona:{botName:'STALE'}}],['/api/config',undefined],['/api/robots/switch',{appId:'111'}],['/api/qq/login/start',{}]]) {
    assert.equal((await req(url,body,{'x-qq-profile-context':oldContext})).status,409);
  }
  assert.equal((await req('/api/events?profileContext='+oldContext,undefined,{'x-qq-profile-context':''})).status,409);
  let cfg=await json('/api/config');assert.equal(cfg.qqbot.appId,'222');assert.equal(cfg.api.model,'shared-first');assert.equal(cfg.api.hasApiKey,true);
  assert.deepEqual(cfg.allow.private,[]);assert.notEqual(cfg.persona.botName,'Robot A');
  assert.equal((await json('/api/chats')).chats.length,0);assert.ok(!JSON.stringify((await ipc('profile-memory-read')).value).includes('ONLY_A_MEMORY'));
  assert.deepEqual((await json('/api/integration')).peers,[]);
  await json('/api/config',{allow:{private:['USER_with-hyphen']},api:{model:'shared-second'},persona:{botName:'Robot B'}});
  await ipc('receive');await ipc('profile-memory',{text:'ONLY_B_MEMORY'});
  assert.equal((await json(messages)).messages.length,1);
  await switchTo('111');cfg=await json('/api/config');
  assert.equal(cfg.qqbot.appId,'111');assert.equal(cfg.persona.botName,'Robot A');assert.equal(cfg.api.model,'shared-second');assert.equal(cfg.api.hasApiKey,true);
  assert.equal((await json(messages)).messages.length,1);
  const restored=JSON.stringify((await ipc('profile-memory-read')).value);assert.ok(restored.includes('ONLY_A_MEMORY'));assert.ok(!restored.includes('ONLY_B_MEMORY'));
  assert.equal(fs.readFileSync(path.join(root,'config.json'),'utf8'),oldConfig);
  assert.equal(readJson(path.join(root,'shared-models.json')).api.apiKey,'MODEL_SHARED_SECRET');
  for(const id of ['111','222']) assert.equal(readJson(path.join(profileDir(root,id),'config.json')).api,undefined);
  // Confirming QR for a NEW bot saves it independently and triggers a switch.
  const qr=await json('/api/qq/login/start',{});await ipc('qr-authorize',{appId:'333'});
  assert.equal((await json('/api/robots')).accounts.length,2,'authorization alone does not save');
  const ended=once(child,'exit');const applied=await json('/api/qq/login/confirm',{id:qr.id,appId:'333',allowScanUser:true});
  assert.equal(applied.switching,true);assert.ok(!JSON.stringify(applied).includes('QR_FIXTURE_SECRET'));
  assert.equal((await ended)[0],0);child=null;await boot();context=undefined;
  const qrProfiles=await json('/api/robots');context=qrProfiles.context;assert.equal(qrProfiles.active,'333');assert.equal(qrProfiles.accounts.length,3);
  cfg=await json('/api/config');assert.equal(cfg.qqbot.authSource,'qr');assert.deepEqual(cfg.allow.private,['SCAN_user-1']);assert.equal(cfg.api.model,'shared-second');
  assert.equal((await json('/api/chats')).chats.length,0);
  await switchTo('222');assert.equal((await json('/api/config')).persona.botName,'Robot B');
  assert.ok(JSON.stringify((await ipc('profile-memory-read')).value).includes('ONLY_B_MEMORY'));
  // Deletion has the same authentication, origin and stale-tab guards as switching.
  const deleteA={appId:'111',confirmAppId:'111'};
  assert.equal((await fetch(base+'/api/robots/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(deleteA)})).status,401);
  assert.equal((await req('/api/robots/delete',deleteA,{'x-qq-profile-context':''})).status,409);
  assert.equal((await req('/api/robots/delete',deleteA,{origin:'https://evil.invalid'})).status,403);
  assert.equal((await req('/api/robots/delete',{appId:'111',confirmAppId:'222'})).status,409);
  assert.equal((await json('/api/robots')).accounts.length,3);
  const removedA=await json('/api/robots/delete',deleteA);assert.equal(removedA.switching,false);assert.equal(removedA.dataRetained,true);
  assert.equal((await json('/api/robots')).accounts.length,2);assert.equal((await json('/api/integration')).connected,true);
  assert.equal((await req('/api/robots/switch',{appId:'111'})).status,409);
  await json('/api/robots/save',{appId:'111'});
  await switchTo('111');assert.ok(JSON.stringify((await ipc('profile-memory-read')).value).includes('ONLY_A_MEMORY'));
  assert.equal((await json('/api/config')).persona.botName,'Robot A');
  const beforeDelete=context;const stopped=once(child,'exit');
  assert.equal((await json('/api/robots/delete',deleteA)).switching,true);
  assert.equal((await stopped)[0],0);child=null;await boot();context=undefined;
  const afterDelete=await json('/api/robots');context=afterDelete.context;
  assert.equal(afterDelete.active,'setup');assert.notEqual(context,beforeDelete);
  assert.equal(afterDelete.accounts.length,2);assert.equal((await json('/api/integration')).connected,false);
  assert.equal((await json('/api/config')).api.model,'shared-second');
  assert.equal((await req('/api/robots/delete',{appId:'222',confirmAppId:'222'},{'x-qq-profile-context':beforeDelete})).status,409);
  for(const appId of ['222','333']) await json('/api/robots/delete',{appId,confirmAppId:appId});
  assert.equal((await json('/api/robots')).accounts.length,0);
  assert.equal((await json('/api/robots')).archivedAccounts.length,3);
  await json('/api/robots/save',{appId:'222'});await switchTo('222');
  assert.ok(JSON.stringify((await ipc('profile-memory-read')).value).includes('ONLY_B_MEMORY'));
  const exit=once(child,'exit');child.kill('SIGTERM');assert.equal((await exit)[0],0);child=null;
  for(const secret of ['BOT_A_SECRET','BOT_B_SECRET','MODEL_SHARED_SECRET','QR_FIXTURE_SECRET',token]) assert.ok(!output.includes(secret),'secrets stay out of logs');
});
