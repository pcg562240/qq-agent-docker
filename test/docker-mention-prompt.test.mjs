import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-mention-prompt-'));
process.env.QQ_AGENT_DATA_DIR=dir;process.env.QQ_AGENT_PROFILES_ROOT='';process.env.QQ_AGENT_ACTIVE_ROBOT='';
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const {buildTriggerBlock,buildUserPrompt}=await import('../src/prompt.js');
const entry={id:1,mid:'MID',senderId:'USER',senderName:'Tester',text:'群聊测试123',ts:Date.now(),self:false,atMe:true};
const ctx={kind:'group',chatKey:'group:GROUP',chatId:'GROUP',selfNickname:'BOT',triggerEntries:[entry],
  store:{recent:()=>[]},memory:{formatForPrompt:()=>''},stickerEntries:[],recentCount:1,contextLimit:20};
test('official atMe survives stripped text in the LLM trigger labels and direct-call guidance',()=>{
  assert.match(buildTriggerBlock([entry],ctx),/（@我）/);
  assert.match(buildUserPrompt(ctx),/本批新消息有人直接 @ 了你/);
  assert.match(buildUserPrompt(ctx),/复制 # 后的完整 ID，# 只是展示标记，不属于参数/);
  assert.match(buildUserPrompt(ctx),/不要用省略号缩短、改写或自己编/);
  assert.match(buildUserPrompt(ctx),/get_message_images.*不含展示前缀 #/);
});
test('explicit false is authoritative; non-mention and historical entries do not become current summons',()=>{
  assert.doesNotMatch(buildTriggerBlock([{...entry,text:'@BOT 引用别人的话',atMe:false}],ctx),/（@我/);
  assert.doesNotMatch(buildUserPrompt({...ctx,triggerEntries:[{...entry,atMe:false}]}),/本批新消息有人直接 @ 了你/);
  assert.doesNotMatch(buildUserPrompt({...ctx,triggerEntries:[],store:{recent:()=>[{...entry,read:true}]}}),/本批新消息有人直接 @ 了你/);
});
test('legacy OneBot nickname mention still renders when no authoritative boolean is present',()=>{
  assert.match(buildTriggerBlock([{...entry,text:'@BOT 你好',atMe:null}],ctx),/（@我/);
});
