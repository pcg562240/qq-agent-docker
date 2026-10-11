import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRobotProfiles, RobotProfiles, readJson, writeJson, profileDir } from '../src/robot-profiles.js';

function fixture(t, config = {qqbot:{appId:'111',clientSecret:'BOT_A_SECRET'},api:{apiKey:'SHARED_MODEL',model:'first'},allow:{private:['ONLY_A'],groups:['GROUP_A']},persona:{botName:'A'}}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'qqa-profiles-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  writeJson(path.join(root,'config.json'), config);
  writeJson(path.join(root,'sessions','test.json'),{message:'OLD_HISTORY'});
  return root;
}
test('legacy migration preserves originals, backup, history, credentials and shared model; restart is idempotent', t => {
  const root = fixture(t), before = fs.readFileSync(path.join(root,'config.json'));
  writeJson(path.join(root,'qqbot','account.json'),{appId:'111'});
  const p = prepareRobotProfiles(root,{});
  assert.equal(p.id,'111'); assert.equal(p.dir,path.join(root,'robots','111'));
  assert.deepEqual(fs.readFileSync(path.join(root,'config.json')),before);
  const registry = readJson(path.join(root,'robot-profiles.json'));
  assert.deepEqual(fs.readFileSync(path.join(root,registry.migrationBackup,'config.json')),before);
  const cfg = readJson(path.join(p.dir,'config.json'));
  assert.equal(cfg.qqbot.clientSecret,'BOT_A_SECRET'); assert.equal(cfg.api,undefined);
  assert.equal(readJson(path.join(root,'shared-models.json')).api.apiKey,'SHARED_MODEL');
  assert.equal(readJson(path.join(p.dir,'sessions','test.json')).message,'OLD_HISTORY');
  assert.equal(fs.statSync(path.join(p.dir,'config.json')).mode & 0o777,0o600);
  assert.deepEqual(prepareRobotProfiles(root,{}),p);
  assert.equal(fs.readdirSync(path.join(root,'legacy-backups')).length,1);
});
test('new robots inherit no identity data; switching back restores private config and never returns secrets', t => {
  const root=fixture(t); prepareRobotProfiles(root,{});
  const a=new RobotProfiles({root,active:'111',env:{}});
  assert.equal(a.save({appId:'222',appSecret:'BOT_B_SECRET',name:'测试 B'}),'222');
  const bdir=profileDir(root,'222'), b=readJson(path.join(bdir,'config.json'));
  assert.deepEqual(b.allow,{private:[],groups:[]}); assert.equal(b.allowAllWhenEmpty,false);
  assert.equal(b.api,undefined); assert.equal(b.persona,undefined); assert.equal(fs.existsSync(path.join(bdir,'sessions')),false);
  assert.equal(a.list().accounts.length,2); assert.equal(JSON.stringify(a.list()).includes('SECRET'),false);
  assert.equal(a.select('222'),true); assert.throws(()=>a.save({appId:'333',appSecret:'s'}),/正在切换/);
  assert.equal(prepareRobotProfiles(root,{}).id,'222');
  const managerB=new RobotProfiles({root,active:'222',env:{}});
  managerB.save({appId:'111',appSecret:'',name:'重命名 A'});
  assert.equal(readJson(path.join(profileDir(root,'111'),'config.json')).qqbot.clientSecret,'BOT_A_SECRET');
  managerB.select('111'); const restored=prepareRobotProfiles(root,{});
  assert.deepEqual(readJson(path.join(restored.dir,'config.json')).allow.private,['ONLY_A']);
  assert.equal(readJson(path.join(restored.dir,'sessions','test.json')).message,'OLD_HISTORY');
});
test('first install creates disabled setup profile; QR credentials save in a separate profile with explicit allowlisting', t => {
  const root=fixture(t,{}); assert.equal(prepareRobotProfiles(root,{}).id,'setup');
  assert.equal(readJson(path.join(profileDir(root,'setup'),'config.json')).qqbot.enabled,false);
  const profiles=new RobotProfiles({root,active:'setup',env:{}});
  profiles.save({appId:'333',appSecret:'QR_SECRET',authSource:'qr',userOpenid:'SCANNER'});
  assert.equal(profiles.select('333'),true);
  const c=readJson(path.join(prepareRobotProfiles(root,{}).dir,'config.json'));
  assert.equal(c.qqbot.authSource,'qr'); assert.deepEqual(c.allow.private,['SCANNER']);
});
test('validation rejects wrong identity, unsafe paths, corrupt JSON and environment-managed mutation', t => {
  const root=fixture(t);
  assert.throws(()=>prepareRobotProfiles(root,{QQBOT_APP_ID:'999'}),/身份/);
  assert.equal(fs.existsSync(path.join(root,'robot-profiles.json')),false);
  prepareRobotProfiles(root,{}); const profiles=new RobotProfiles({root,active:'111',env:{}});
  for(const id of ['../x','',222,'1/2','setup']) assert.throws(()=>profiles.save({appId:id,appSecret:'S'}));
  assert.throws(()=>profiles.save({appId:'222',appSecret:''}),/需要/);
  assert.throws(()=>profiles.select('999'),/请选择/);
  assert.throws(()=>new RobotProfiles({root,active:'111',env:{QQBOT_APP_SECRET:'ENV'}}).select('111'),/环境变量/);
  profiles.save({appId:'222',appSecret:'S'});
  writeJson(path.join(profileDir(root,'222'),'qqbot','account.json'),{appId:'999'});
  assert.throws(()=>profiles.select('222'),/身份/);
  assert.equal(readJson(path.join(root,'robot-profiles.json')).active,'111');
  fs.writeFileSync(path.join(profileDir(root,'222'),'config.json'),'{"secret":"DONT_LEAK');
  assert.throws(()=>profiles.select('222'),e=>/JSON/.test(e.message) && !e.message.includes('DONT_LEAK'));
});
test('migration rejects symlinks and never overwrites unregistered data', t => {
  const root=fixture(t); fs.symlinkSync(path.join(root,'config.json'),path.join(root,'link'));
  assert.throws(()=>prepareRobotProfiles(root,{}),/链接/);
  fs.unlinkSync(path.join(root,'link')); prepareRobotProfiles(root,{});
  const profiles=new RobotProfiles({root,active:'111',env:{}});
  const dir=profileDir(root,'222'); writeJson(path.join(dir,'keep.json'),{valuable:true});
  assert.throws(()=>profiles.save({appId:'222',appSecret:'S'}),/未登记/);
  assert.equal(readJson(path.join(dir,'keep.json')).valuable,true);
  fs.symlinkSync(profileDir(root,'111'),path.join(root,'robots','333'));
  assert.throws(()=>profiles.save({appId:'333',appSecret:'S'}),/符号链接/);
});

test('delete inactive robot retains its data and credentials; explicit re-add restores only that identity', t => {
  const root=fixture(t); prepareRobotProfiles(root,{});
  const p=new RobotProfiles({root,active:'111',env:{}});
  p.save({appId:'222',appSecret:'BOT_B_SECRET',name:'Robot B'});
  const dir=profileDir(root,'222'); writeJson(path.join(dir,'memory','keep.json'),{text:'ONLY_B'});
  const config=fs.readFileSync(path.join(dir,'config.json'));
  const shared=fs.readFileSync(path.join(root,'shared-models.json'));
  const active=fs.readFileSync(path.join(profileDir(root,'111'),'config.json'));
  assert.deepEqual(p.remove({appId:'222',confirmAppId:'222'}),{appId:'222',switching:false,dataRetained:true});
  assert.deepEqual(p.list().accounts.map(a=>a.id),['111']);
  assert.deepEqual(p.list().archivedAccounts.map(a=>a.id),['222']);
  assert.ok(!JSON.stringify(p.list()).includes('BOT_B_SECRET'));
  assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),config);
  assert.equal(readJson(path.join(dir,'memory','keep.json')).text,'ONLY_B');
  assert.throws(()=>p.select('222'),/已保存/);
  assert.throws(()=>p.remove({appId:'222',confirmAppId:'222'}),/已经删除/);
  p.save({appId:'222',appSecret:''});
  assert.equal(p.list().accounts.find(a=>a.id==='222').name,'Robot B');
  assert.equal(p.list().archivedAccounts.length,0);
  assert.equal(readJson(path.join(dir,'config.json')).qqbot.clientSecret,'BOT_B_SECRET');
  assert.equal(readJson(path.join(dir,'memory','keep.json')).text,'ONLY_B');
  assert.deepEqual(fs.readFileSync(path.join(root,'shared-models.json')),shared);
  assert.deepEqual(fs.readFileSync(path.join(profileDir(root,'111'),'config.json')),active);
});
test('delete current/last robot transitions to disabled setup and survives restarts; restore stays explicit', t => {
  const root=fixture(t); prepareRobotProfiles(root,{});
  const p=new RobotProfiles({root,active:'111',env:{}});
  const original=fs.readFileSync(path.join(profileDir(root,'111'),'config.json'));
  assert.equal(p.remove({appId:'111',confirmAppId:'111'}).switching,true);
  assert.throws(()=>p.save({appId:'222',appSecret:'S'}),/正在切换/);
  const setup=prepareRobotProfiles(root,{}); assert.equal(setup.id,'setup');
  const cfg=readJson(path.join(setup.dir,'config.json'));
  assert.equal(cfg.qqbot.enabled,false);assert.equal(cfg.qqbot.appId,'');assert.equal(cfg.qqbot.clientSecret,undefined);
  assert.deepEqual(cfg.allow,{private:[],groups:[]});assert.equal(cfg.persona,undefined);
  assert.deepEqual(fs.readFileSync(path.join(profileDir(root,'111'),'config.json')),original);
  const fresh=new RobotProfiles({root,active:'setup',env:{}});assert.equal(fresh.list().accounts.length,0);
  assert.equal(prepareRobotProfiles(root,{}).id,'setup');
  fresh.save({appId:'111'});assert.equal(fresh.list().active,'setup');
  fresh.select('111');assert.equal(prepareRobotProfiles(root,{}).id,'111');
  assert.equal(readJson(path.join(profileDir(root,'111'),'sessions','test.json')).message,'OLD_HISTORY');
});
test('delete validates typed identity, environment, stale process, symlinks and does not touch data on rejection', t => {
  const root=fixture(t);prepareRobotProfiles(root,{});const p=new RobotProfiles({root,active:'111',env:{}});
  p.save({appId:'222',appSecret:'SECRET_B'});
  const original=fs.readFileSync(path.join(root,'robot-profiles.json'));
  for(const body of [{appId:'111'}, {appId:'111',confirmAppId:'222'}, {appId:111,confirmAppId:111},
    {appId:'../111',confirmAppId:'../111'}, {appId:'setup',confirmAppId:'setup'}, {appId:'999',confirmAppId:'999'}]) assert.throws(()=>p.remove(body));
  assert.throws(()=>new RobotProfiles({root,active:'111',env:{QQBOT_APP_SECRET:'ENV'}}).remove({appId:'111',confirmAppId:'111'}),/环境变量/);
  assert.throws(()=>new RobotProfiles({root,active:'222',env:{}}).remove({appId:'111',confirmAppId:'111'}),/正在切换/);
  fs.symlinkSync(profileDir(root,'111'),path.join(root,'robots','setup'));
  assert.throws(()=>p.remove({appId:'111',confirmAppId:'111'}),/符号链接/);
  assert.deepEqual(fs.readFileSync(path.join(root,'robot-profiles.json')),original);
  assert.equal(readJson(path.join(profileDir(root,'111'),'config.json')).qqbot.clientSecret,'BOT_A_SECRET');
});
test('archived bot with broken identity or symbolic config is not silently recreated or restored', t => {
  const root=fixture(t);prepareRobotProfiles(root,{});const p=new RobotProfiles({root,active:'111',env:{}});
  p.save({appId:'222',appSecret:'S'});p.remove({appId:'222',confirmAppId:'222'});
  const dir=profileDir(root,'222');writeJson(path.join(dir,'qqbot','account.json'),{appId:'999'});
  assert.throws(()=>p.save({appId:'222',appSecret:'NEW'}),/身份/);
  fs.unlinkSync(path.join(dir,'config.json'));fs.symlinkSync(path.join(profileDir(root,'111'),'config.json'),path.join(dir,'config.json'));
  assert.throws(()=>p.save({appId:'222',appSecret:'NEW'}),/符号链接/);
  assert.equal(p.list().accounts.length,1);assert.equal(p.list().archivedAccounts.length,1);
  assert.equal(readJson(path.join(profileDir(root,'111'),'config.json')).qqbot.clientSecret,'BOT_A_SECRET');
});
