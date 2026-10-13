import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));

test('ordinary group messages survive, do not wake tier 1, enter the next prompt, and cannot steal a queued reply', {timeout:45000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-all-group-'));
  const requests=[], errors=[]; let child, output='',blocked=false;
  const entered=deferred(),release=deferred();
  const model=http.createServer(async(req,res)=>{
    try {
      let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);
      const prompt=body.messages.find(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('【未读信息】以下'))?.content||'';
      const unread=prompt.split('【未读信息】以下').at(-1).split('【直接召唤】')[0].split('【新加入成员】')[0].split('【当前时间】')[0];
      const mid=['QUESTION_A','QUESTION_C','TIER4','KEYWORD','PRIVATE'].find(x=>unread.includes('#'+x));
      assert.ok(mid,'only actual triggers reach model');
      if(mid==='QUESTION_A'&&!blocked){blocked=true;entered.resolve();await release.promise;}
      const done=body.messages.some(m=>m.role==='tool'&&m.name==='send_message');
      const name=done?'finish':'send_message';
      const args=done?{summary:'offline complete'}:{messages:'synthetic answer '+mid,replyToMessageId:mid};
      res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'CALL_'+mid+'_'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
    }catch(e){errors.push(e.message);res.writeHead(500);res.end('{}')}
  });
  t.after(async()=>{release.resolve();child?.kill('SIGKILL');model.closeAllConnections();await new Promise(r=>model.close(r));fs.rmSync(dir,{recursive:true,force:true})});
  model.listen(0,'127.0.0.1');await once(model,'listening');
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  child=fork(fileURLToPath(new URL('./helpers/docker-http-fixture.mjs',import.meta.url)),[],{env:{...process.env,QQ_AGENT_DOCKER:'1',QQ_AGENT_CHANNEL:'qqbot',QQ_AGENT_DATA_DIR:dir,QQ_AGENT_PROFILES_ROOT:'',QQ_AGENT_ACTIVE_ROBOT:'',QQ_AGENT_CONSOLE_TOKEN:'offline-group-fixture-token',QQ_AGENT_INTERNAL_PORT:String(port),QQBOT_APP_ID:'',QQBOT_APP_SECRET:'',TEST_LLM_URL:`http://127.0.0.1:${model.address().port}/v1`,TEST_QUOTE_IMAGES:'1'},stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);assert.ok((await once(child,'message'))[0].ready);
  const version=await fetch(`http://127.0.0.1:${port}/api/version`,{headers:{'x-console-token':'offline-group-fixture-token'}}).then(r=>r.json());
  assert.equal(version.version,'0.4.0');assert.equal(version.dockerVersion,JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).dockerVersion);
  let seq=0;const rpc=async(action,fields={})=>{const id=++seq,p=once(child,'message');child.send({action,id,...fields});const [r]=await p;assert.equal(r.id,id);assert.ok(r.ok,r.error);return r};
  const receive=(mid,content,extra={})=>rpc('receive',{group:true,mentionMode:'ordinary',senderId:'USER_BACKGROUND',messageId:mid,content,...extra});
  const archive=()=>JSON.parse(fs.readFileSync(path.join(dir,'messages/group_GROUP_with-hyphen.json'))).messages;
  const idle=async()=>{for(let i=0;i<200;i++){const statuses=fs.existsSync(path.join(dir,'sessions'))?fs.readdirSync(path.join(dir,'sessions')).filter(f=>f.endsWith('.json')).flatMap(f=>{try{return [JSON.parse(fs.readFileSync(path.join(dir,'sessions',f))).status]}catch{return []}}):[];if(!statuses.some(s=>['running','waiting'].includes(s)))return;await pause(30)}assert.fail('agent did not settle: '+output)};
  await rpc('set-config',{patch:{blocklist:{'GROUP_with-hyphen':['BLOCKED']},chatActive:{enabled:false},store:{contextSliderPos:5,unifiedTier:true,peakSchedule:{enabled:false}}}});
  await receive('BLOCKED_MID','BLOCKED_CONTENT',{senderId:'BLOCKED'});
  await receive('UNLISTED_MID','UNLISTED_CONTENT',{groupId:'OTHER_GROUP'});
  await receive('BACKGROUND','ordinary shared context');
  await receive('BACKGROUND','ordinary shared context'); // duplicate stays single
  await receive('OTHER_MENTION','<@!OTHER> someone else',{senderId:'USER_OTHER'});
  await pause(150);assert.equal(requests.length,0);assert.equal((await rpc('snapshot')).sent.length,0);
  assert.equal(archive().length,2);assert.ok(archive().every(m=>m.atMe===false&&m.read));
  assert.ok(!fs.existsSync(path.join(dir,'messages/group_OTHER_GROUP.json')));
  assert.ok(!JSON.stringify(archive()).includes('BLOCKED_CONTENT'));
  await receive('QUESTION_A','<@!bot> please answer A',{senderId:'USER_A',mentionMode:'inline'});
  await entered.promise;
  await receive('DURING_A','ordinary chatter arriving during A');
  release.resolve();await idle();await pause(100);await idle();
  assert.equal((await rpc('snapshot')).sent.length,1,output);
  assert.equal((await rpc('snapshot')).sent[0].target.msgId,'QUESTION_A');
  const firstPrompt=JSON.stringify(requests[0].messages);assert.match(firstPrompt,/ordinary shared context/);
  assert.ok(!firstPrompt.includes('BLOCKED_CONTENT'));assert.ok(!firstPrompt.includes('UNLISTED_CONTENT'));
  const before=requests.length;await receive('AFTER_A','ordinary chatter after A');await pause(150);assert.equal(requests.length,before);
  await receive('QUESTION_C','<@!bot> please answer C',{senderId:'USER_C',mentionMode:'inline'});await idle();
  assert.match(JSON.stringify(requests[before].messages),/ordinary chatter arriving during A/);
  assert.match(JSON.stringify(requests[before].messages),/ordinary chatter after A/);
  assert.match(JSON.stringify(requests[before].messages),/回复对象.*USER_A/);
  // Switching the upstream sliders really works; no hidden requireMention gate.
  await rpc('set-config',{patch:{qqbot:{requireMention:true},store:{contextSliderPos:15,keywords:['KEYWORD_TRIGGER']}}});
  await receive('KEYWORD','KEYWORD_TRIGGER');await idle();
  await rpc('set-config',{patch:{store:{contextSliderPos:95}}});
  await receive('TIER4','ordinary full-response message');await idle();
  await rpc('set-config',{patch:{store:{contextSliderPos:5}}});
  await rpc('receive',{messageId:'PRIVATE',content:'private without a mention'});await idle();
  const sent=(await rpc('snapshot')).sent;
  assert.deepEqual(sent.map(s=>s.target.msgId),['QUESTION_A','QUESTION_C','KEYWORD','TIER4','PRIVATE'],output);
  assert.ok(sent.every(s=>!s.markdown));assert.deepEqual(errors,[]);
  assert.equal(archive().filter(m=>m.mid==='BACKGROUND').length,1);
  assert.ok(archive().filter(m=>!m.self).every(m=>m.read));
  child.kill('SIGTERM');const [code]=await once(child,'exit');assert.equal(code,0);child=null;
});
