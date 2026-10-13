import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {exportProfile,inspectArchive,queueBackup,runBackupJob,backupState,backupDownload,backupUploadPath,previewBackup,assertPrivateDatabases} from '../src/profile-backup.js';
const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof v==='string'?v:JSON.stringify(v));};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-backup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const profile=path.join(root,'robots','123456');write(path.join(profile,'config.json'),{qqbot:{appId:'123456',clientSecret:'SYNTHETIC_ONLY'},persona:{role:'鲸鱼'},skills:{}});write(path.join(profile,'messages','group_A.json'),{messages:[{text:'synthetic 中文',mid:'MID'}]});write(path.join(profile,'extensions/skills/demo/index.js'),'export function setup() {}');write(path.join(root,'robots/654321/config.json'),{qqbot:{appId:'654321'},skills:{}});write(path.join(root,'shared-models.json'),{model:'UNCHANGED'});return {root,profile};}

test('current-profile archive preserves files, hashes and code as data; excludes compatibility links and shared models',async t=>{
 const {root,profile}=fixture(t);fs.symlinkSync('/absent/runtime',path.join(profile,'extensions/src'));write(path.join(profile,'instance.lock'),'old');
 const file=path.join(root,'backup.gz');await exportProfile(root,'123456',file);const result=await inspectArchive(file,'123456',path.join(root,'preview'));
 assert.equal(result.files,3);assert.equal(result.sharedModelsIncluded,false);assert.equal(result.documents,0);
 assert.equal(fs.readFileSync(path.join(root,'preview/profile/messages/group_A.json'),'utf8'),fs.readFileSync(path.join(profile,'messages/group_A.json'),'utf8'));
 assert.ok(!gunzipSync(fs.readFileSync(file)).includes('UNCHANGED'));
 await assert.rejects(inspectArchive(file,'654321',path.join(root,'wrong')),/AppID/);
});

test('archive validation rejects traversal, duplicate paths, mismatched hashes, truncation and identity conflicts',async t=>{
 const {root}=fixture(t),file=path.join(root,'base.gz');await exportProfile(root,'123456',file);
 const good=gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map(JSON.parse);
 const variants=[];for(const name of ['../outside','/absolute','a/../b','C:/x','a\\b']){const r=structuredClone(good);r[1].name=name;variants.push(r);}
 {const r=structuredClone(good);r.splice(2,0,r[1]);variants.push(r);}
 {const r=structuredClone(good);r[1].sha256='bad';variants.push(r);}
 variants.push(good.slice(0,-1));variants.push([...good,{type:'end'}]);
 for(let i=0;i<variants.length;i++){const f=path.join(root,`bad${i}.gz`);fs.writeFileSync(f,gzipSync(variants[i].map(JSON.stringify).join('\n')+'\n'));await assert.rejects(inspectArchive(f,'123456',path.join(root,'invalid'+i)));assert.ok(!fs.existsSync(path.join(root,'invalid'+i)));}
 assert.ok(!fs.existsSync(path.join(root,'outside')));
});

test('restore is previewed, automatically backed up, same-profile only and leaves other bots/shared models untouched',async t=>{
 const {root,profile}=fixture(t);const other=fs.readFileSync(path.join(root,'robots/654321/config.json')),shared=fs.readFileSync(path.join(root,'shared-models.json'));
 queueBackup(root,'123456','export');await runBackupJob(root,'123456');const state=backupState(root,'123456');assert.equal(state.status,'complete');
 const upload=crypto.randomUUID();fs.copyFileSync(backupDownload(root,'123456',state.id),backupUploadPath(root,'123456',upload));const info=await previewBackup(root,'123456',upload);assert.equal(info.files,3);
 write(path.join(profile,'messages/group_A.json'),'new state');queueBackup(root,'123456','restore',upload);await runBackupJob(root,'123456');const restored=backupState(root,'123456');assert.equal(restored.status,'complete');assert.ok(restored.rollbackId);
 assert.match(fs.readFileSync(path.join(profile,'messages/group_A.json'),'utf8'),/synthetic/);assert.deepEqual(fs.readFileSync(path.join(root,'robots/654321/config.json')),other);assert.deepEqual(fs.readFileSync(path.join(root,'shared-models.json')),shared);
 const rollbackStage=path.join(root,'rollback-inspect');await inspectArchive(backupDownload(root,'123456',restored.rollbackId),'123456',rollbackStage);assert.equal(fs.readFileSync(path.join(rollbackStage,'profile/messages/group_A.json'),'utf8'),'new state');
});

test('restore failure after file switch rolls back original files and retains a private recovery archive',async t=>{
 const {root,profile}=fixture(t),upload=crypto.randomUUID();await exportProfile(root,'123456',backupUploadPath(root,'123456',upload));await previewBackup(root,'123456',upload);
 write(path.join(profile,'messages/group_A.json'),'must survive');queueBackup(root,'123456','restore',upload);
 await runBackupJob(root,'123456',{hook(stage){if(stage==='after-files')throw Error('simulated crash');}});
 assert.equal(backupState(root,'123456').status,'failed');assert.equal(fs.readFileSync(path.join(profile,'messages/group_A.json'),'utf8'),'must survive');
});

test('shared databases and unexpected links fail closed rather than crossing profile boundaries',async t=>{
 const {root,profile}=fixture(t);const config={skills:{'kb-growth':{enabled:true,mongoUri:'mongodb://one:synthetic@db:27017',mongoDb:'shared'}}};write(path.join(root,'robots/654321/config.json'),config);assert.throws(()=>assertPrivateDatabases(root,'123456',config),/共享/);
 fs.symlinkSync('/tmp',path.join(profile,'unexpected'));await assert.rejects(exportProfile(root,'123456',path.join(root,'symlink.gz')),/符号链接/);assert.ok(!fs.existsSync(path.join(root,'symlink.gz')));
});

test('restore clears stale QQ sessions and waiting runs, but preserves current DB destinations',async t=>{
 const {root,profile}=fixture(t);write(path.join(profile,'qqbot/session.json'),{session:'old'});write(path.join(profile,'sessions/a.json'),{status:'waiting',trigger:'synthetic'});
 const upload=crypto.randomUUID();await exportProfile(root,'123456',backupUploadPath(root,'123456',upload));await previewBackup(root,'123456',upload);queueBackup(root,'123456','restore',upload);await runBackupJob(root,'123456');
 assert.equal(backupState(root,'123456').status,'complete');assert.ok(!fs.existsSync(path.join(profile,'qqbot/session.json')));assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'sessions/a.json'))).status,'aborted');
});

test('restarted restoring job rolls back before missing profile identity can be validated',async t=>{
 const {root,profile}=fixture(t),id=crypto.randomUUID(),rollbackId=crypto.randomUUID();
 const rollbackFile=path.join(root,'backups/123456',rollbackId+'.qqab.gz');await exportProfile(root,'123456',rollbackFile);
 fs.renameSync(profile,path.join(root,'backups/123456',id+'.old-profile'));
 write(path.join(root,'backups/123456/job.json'),{id,rollbackId,profileId:'123456',type:'restore',status:'restoring',targets:[]});
 await runBackupJob(root,'123456');assert.equal(backupState(root,'123456').status,'failed');assert.ok(fs.existsSync(path.join(profile,'config.json')));
 const source=fs.readFileSync(new URL('../src/docker-server.js',import.meta.url),'utf8');assert.ok(source.indexOf('runBackupJob(process.env.QQ_AGENT_DATA_DIR')<source.indexOf('prepareRobotProfiles(process.env.QQ_AGENT_DATA_DIR'));
});

test('pre-backup failure does not touch data and rollback failure blocks startup for retry',async t=>{
 const {root,profile}=fixture(t),upload=crypto.randomUUID();await exportProfile(root,'123456',backupUploadPath(root,'123456',upload));await previewBackup(root,'123456',upload);write(path.join(profile,'messages/group_A.json'),'keep');queueBackup(root,'123456','restore',upload);
 await runBackupJob(root,'123456',{exporter:async()=>{throw Error('disk failure');}});assert.equal(backupState(root,'123456').status,'failed');assert.equal(fs.readFileSync(path.join(profile,'messages/group_A.json'),'utf8'),'keep');
 queueBackup(root,'123456','restore',upload);
 await assert.rejects(runBackupJob(root,'123456',{restoreDb:async()=>{throw Error('database unavailable');}}),/停止启动/);
 assert.equal(backupState(root,'123456').status,'rolling-back');await runBackupJob(root,'123456');assert.equal(backupState(root,'123456').status,'failed');
});
