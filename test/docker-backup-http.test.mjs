import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {runBackupJob} from '../src/profile-backup.js';

test('backup HTTP requires auth/context/confirmation and supports offline export-preview-restore across restarts', {timeout:45000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-backup-http-'));let child,context,output='';
 t.after(()=>{child?.kill('SIGKILL');fs.rmSync(root,{recursive:true,force:true});});
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({qqbot:{appId:'123456',clientSecret:'OFFLINE_ONLY',enabled:true},persona:{role:'before'},extensions:{hotReload:false},skills:{}}));
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const token='offline-backup-console-token',base=`http://127.0.0.1:${port}`;
 async function boot(){child=fork(fileURLToPath(new URL('./helpers/docker-profiles-fixture.mjs',import.meta.url)),[],{env:{...process.env,QQ_AGENT_DOCKER:'1',QQ_AGENT_CHANNEL:'qqbot',QQ_AGENT_DATA_DIR:root,QQ_AGENT_PROFILES_ROOT:'',QQ_AGENT_ACTIVE_ROBOT:'',QQ_AGENT_CONSOLE_TOKEN:token,QQ_AGENT_INTERNAL_PORT:String(port),QQBOT_APP_ID:'',QQBOT_APP_SECRET:''},stdio:['ignore','pipe','pipe','ipc']});child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);assert.ok((await once(child,'message'))[0].ready);context=(await fetch(base+'/api/robots',{headers:{'x-console-token':token}}).then(r=>r.json())).context;}
 const req=(url,body,extra={})=>fetch(base+url,{headers:{'x-console-token':token,'x-qq-profile-context':context,...extra},...(body===undefined?{}:{method:'POST',body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});
 await boot();assert.equal((await fetch(base+'/api/backups')).status,401);assert.equal((await fetch(base+'/backup.html',{redirect:'manual'})).status,302);
 const html=await (await req('/backup.html')).text();assert.ok(html.includes('name="qq-profile-context"'));assert.ok(html.includes('不加密'));
 assert.equal((await req('/api/backups/export',{confirmAppId:'123456'},{'x-qq-profile-context':'stale'})).status,409);
 assert.equal((await req('/api/backups/export',{confirmAppId:'654321'})).status,400);
 assert.equal((await req('/api/backups/upload',Buffer.from('not an archive'))).status,400);
 let exited=once(child,'exit');assert.equal((await req('/api/backups/export',{confirmAppId:'123456'})).status,202);assert.equal((await exited)[0],0);child=null;
 await runBackupJob(root,'123456');await boot();const state=await (await req('/api/backups')).json();assert.equal(state.status,'complete',output);
 const dl=await req('/api/backups/download/'+state.id);assert.equal(dl.status,200);assert.match(dl.headers.get('content-disposition'),/attachment/);const buf=Buffer.from(await dl.arrayBuffer());
 const result=await req('/api/backups/upload',buf);assert.equal(result.status,200);const preview=await result.json();assert.equal(preview.profileId,'123456');assert.ok(preview.files>0);assert.equal(preview.sharedModelsIncluded,false);
 assert.equal((await req('/api/backups/restore',{confirmAppId:'123456',previewId:preview.previewId})).status,400);
 exited=once(child,'exit');assert.equal((await req('/api/backups/restore',{confirmAppId:'123456',previewId:preview.previewId,confirmTrust:true})).status,202);assert.equal((await exited)[0],0);child=null;
 await runBackupJob(root,'123456');await boot();const restored=await (await req('/api/backups')).json();assert.equal(restored.status,'complete',JSON.stringify(restored));assert.ok(restored.rollbackId);assert.equal((await req('/api/backups/download/'+restored.rollbackId)).status,200);
 child.kill('SIGTERM');await once(child,'exit');child=null;
});
