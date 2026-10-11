import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeJson, readJson } from '../src/robot-profiles.js';
import { unzipToModuleDir, parseZip } from '../src/zip-install.js';
import { moduleZip, zipFiles } from './helpers/module-zip.mjs';

test('ZIP staging cleans up failures, validates fallback names, bounds inflate and never overwrites existing installs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-zip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zip = moduleZip('offline');
  assert.equal(await unzipToModuleDir(zip, {root,type:'skill'}), 'offline');
  assert.equal(await unzipToModuleDir(zip, {root,type:'skill'}), 'offline_1');
  const flat = zipFiles({'skill.json':'{}','index.js':'export function setup() {}'});
  assert.equal(await unzipToModuleDir(flat, {root,preferId:'../../outside'}), 'module');
  await assert.rejects(unzipToModuleDir(zipFiles({'bad/a':'x','bad/a/b':'x'}), {root}), /EEXIST/);
  assert.ok(!fs.readdirSync(path.join(root, 'skills')).some(n => n.startsWith('.')));
  for (const name of ['../outside','C:/outside','a/../../outside','a\\..\\outside']) {
    assert.throws(() => parseZip(zipFiles({[name]:'x'})), /非法路径/);
  }
  assert.throws(() => parseZip(zipFiles({'bomb.txt':Buffer.alloc(33 * 1024 * 1024)})), /larger than|32MB|buffer/i);
  assert.throws(() => parseZip(zipFiles(Object.fromEntries(Array.from({length:101},(_,i)=>[`f${i}`,'x'])))), /数量/);
  const base = path.join(root, 'skills');
  for (let i=2;i<=100;i++) fs.mkdirSync(path.join(base, `offline_${i}`));
  await assert.rejects(unzipToModuleDir(zip, {root}), /同名安装目录过多/);
  assert.deepEqual(fs.readdirSync(path.join(base,'offline_100')), []);
});

test('Docker installs via code and ZIP: load, tools, reload, publish, restart, per-bot switch, uninstall; bundled modules stay read-only', {timeout:90_000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-skills-http-'));
  const token='skills-fixture-console-token-abcdefghijklmnopqrstuvwxyz';
  let child, output='', context;
  t.after(()=>{child?.kill('SIGKILL');fs.rmSync(root,{recursive:true,force:true});});
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  writeJson(path.join(root,'config.json'), { qqbot:{appId:'111',clientSecret:'FIXTURE_SECRET',enabled:true}, extensions:{hotReload:false} });
  const publishZip=path.join(root,'published.zip');
  async function boot() {
    child=fork(fileURLToPath(new URL('./helpers/docker-skills-fixture.mjs',import.meta.url)),[],{
      env:{...process.env,QQ_AGENT_DOCKER:'1',QQ_AGENT_DEV:'1',QQ_AGENT_CHANNEL:'qqbot',QQ_AGENT_DATA_DIR:root,
        QQ_AGENT_PROFILES_ROOT:'',QQ_AGENT_ACTIVE_ROBOT:'',QQ_AGENT_CONSOLE_TOKEN:token,QQ_AGENT_INTERNAL_PORT:String(port),
        QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',TEST_PUBLISHED_ZIP:publishZip}, stdio:['ignore','pipe','pipe','ipc']});
    child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
    await new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(new Error(JSON.stringify(m))));child.once('exit',c=>reject(new Error(`startup ${c}: ${output}`)));});
    context=undefined;context=(await json('/api/robots')).context;
  }
  async function stop() { const ended=once(child,'exit');child.kill('SIGTERM');assert.equal((await ended)[0],0);child=null; }
  async function request(url, body, method) {
    return fetch(`http://127.0.0.1:${port}${url}`,{method:method || (body===undefined?'GET':'POST'),headers:{'content-type':'application/json','x-console-token':token,...(context?{'x-qq-profile-context':context}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  }
  async function json(url,body,method) {const res=await request(url,body,method), data=await res.json();assert.equal(res.status,200,JSON.stringify(data));return data;}
  async function switchTo(id) {const ended=once(child,'exit');await json('/api/robots/switch',{appId:id});assert.equal((await ended)[0],0);child=null;await boot();}
  await boot();
  const bundled=(await json('/api/skills')).skills.find(s=>s.loaded);
  assert.ok(bundled);
  const verified=(await json('/api/market/verify',{codes:['SKILL1']})).results[0];
  const byCode=await json('/api/market/install',{code:'SKILL1',entry:verified});
  assert.equal(byCode.dir,path.join(root,'robots','111','extensions','skills','code-fixture'));
  const imported=await json('/api/skills/import',{zipName:'local.zip',zipBase64:moduleZip('zip-fixture').toString('base64')});
  assert.equal(imported.reloaded,true);assert.equal(imported.errors.length,0);
  assert.equal(imported.installed[0].dir,path.join(root,'robots','111','extensions','skills','zip-fixture'));
  await json('/api/market/install',{code:'PLUGIN1',entry:{ok:true,type:'plugin',id:'plugin-fixture'}});
  const localPlugin=await json('/api/skills/import',{kind:'skill',zipName:'plugin.zip',zipBase64:moduleZip('local-plugin','plugin').toString('base64')});
  assert.equal(localPlugin.installed[0].kind,'plugin');
  async function assertInstalled() {
    const skills=(await json('/api/skills')).skills, tools=(await json('/api/tools')).tools;
    for (const id of ['code-fixture','zip-fixture','plugin-fixture','local-plugin']) {
      const found=skills.find(s=>s.id===id);assert.equal(found?.loaded,true,JSON.stringify(found));
      assert.equal(found.kind,id.includes('plugin')?'plugin':'skill');
      assert.ok(tools.some(t=>t.id===`${id}__probe`));
    }
    assert.ok(skills.find(s=>s.id===bundled.id)?.loaded);
  }
  await assertInstalled();
  await json('/api/skills/reload',{});await assertInstalled();
  // The watcher must include persistent roots, not only the image directories.
  const watched=path.join(byCode.dir,'index.js');
  fs.writeFileSync(watched,fs.readFileSync(watched,'utf8').replace('Offline probe','Watched probe'));
  let watchedTool;
  for(let i=0;i<60;i++) {
    watchedTool=(await json('/api/tools')).tools.find(t=>t.id==='code-fixture__probe');
    if(watchedTool?.name==='Watched probe') break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(watchedTool?.name,'Watched probe');
  writeJson(path.join(root,'robots','111','account.json'),{accounts:[{username:'fixture',token:'MARKET_FIXTURE'}]});
  await json('/api/market/publish',{kind:'skill',id:'code-fixture',displayName:'fixture',accountUsername:'fixture'});
  assert.ok(parseZip(fs.readFileSync(publishZip)).some(e=>e.name==='index.js'));
  await stop();await boot();await assertInstalled();
  const configBefore=fs.readFileSync(path.join(root,'robots','111','config.json'));
  await json('/api/robots/save',{appId:'222',appSecret:'OTHER_FIXTURE'});await switchTo('222');
  assert.ok(!(await json('/api/skills')).skills.some(s=>s.id==='code-fixture'));
  assert.ok(!(await json('/api/tools')).tools.some(t=>t.id==='code-fixture__probe'));
  await switchTo('111');await assertInstalled();
  assert.deepEqual(fs.readFileSync(path.join(root,'robots','111','config.json')),configBefore);
  const coreDelete=await request(`/api/skills/${bundled.id}`,undefined,'DELETE');assert.equal(coreDelete.status,400);assert.match((await coreDelete.json()).error,/镜像内置模块/);
  await json('/api/skills/code-fixture',undefined,'DELETE');
  assert.equal(fs.existsSync(byCode.dir),false);
  assert.ok(!(await json('/api/tools')).tools.some(t=>t.id==='code-fixture__probe'));
  await stop();await boot();assert.ok(!(await json('/api/skills')).skills.some(s=>s.id==='code-fixture'));
  assert.equal(readJson(path.join(root,'robots','111','config.json')).qqbot.clientSecret,'FIXTURE_SECRET');
  await stop();
});
