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
  assert.match(buildUserPrompt(ctx),/不要自行拼接 <@用户ID>、<@!用户ID>/);
  assert.match(buildUserPrompt(ctx),/官方 QQ 群回复对象由原提问消息绑定/);
});
test('explicit false is authoritative; non-mention and historical entries do not become current summons',()=>{
  assert.doesNotMatch(buildTriggerBlock([{...entry,text:'@BOT 引用别人的话',atMe:false}],ctx),/（@我/);
  assert.doesNotMatch(buildUserPrompt({...ctx,triggerEntries:[{...entry,atMe:false}]}),/本批新消息有人直接 @ 了你/);
  assert.doesNotMatch(buildUserPrompt({...ctx,triggerEntries:[],store:{recent:()=>[{...entry,read:true}]}}),/本批新消息有人直接 @ 了你/);
});
test('legacy OneBot nickname mention still renders when no authoritative boolean is present',()=>{
  assert.match(buildTriggerBlock([{...entry,text:'@BOT 你好',atMe:null}],ctx),/（@我/);
});

test('per-bot legacy rollback restores historical mention guidance and tool descriptions only for QQ',async()=>{
  const {getConfig,setRuntimeConfig}=await import('../src/config.js');
  const {buildSystemPrompt}=await import('../src/prompt.js');
  const {buildToolDefs,toOpenAiTools}=await import('../src/tools.js');
  const before=getConfig();
  const beforeChannel=process.env.QQ_AGENT_CHANNEL;
  try {
    process.env.QQ_AGENT_CHANNEL='qqbot';
    setRuntimeConfig({...before,channel:{type:'qqbot'},qqbot:{...before.qqbot,groupReplyMentionMode:'legacy'}});
    assert.match(buildSystemPrompt(),/需要直接叫某人时用 atUserId/);
    assert.doesNotMatch(buildSystemPrompt(),/不要在回复正文里自行拼接/);
    assert.doesNotMatch(buildUserPrompt(ctx),/回复正文只写内容，不要自行拼接/);
    assert.match(buildUserPrompt(ctx),/多人同时提问时分别调用/);
    const send=buildToolDefs().find(t=>t.id==='send_message');
    assert.equal(send.parameters.properties.messages.description,'要发送的内容：字符串=一条；数组=分多条');
    assert.equal(send.parameters.properties.atUserId.description,'要 @ 的群成员 QQ 号或官方 OpenID（原样填写，必须对应提问者，可选）');
    assert.equal(toOpenAiTools([send])[0].function.parameters.type,'object');
    process.env.QQ_AGENT_CHANNEL='onebot'; // Container env overrides raw config, just as in production.
    setRuntimeConfig({...before,channel:{type:'onebot'},qqbot:{...before.qqbot,groupReplyMentionMode:'legacy'}});
    assert.match(buildSystemPrompt(),/不要在回复正文里自行拼接/);
    assert.match(buildToolDefs().find(t=>t.id==='send_message').parameters.properties.messages.description,/不要自行拼接/);
  } finally {
    if(beforeChannel===undefined)delete process.env.QQ_AGENT_CHANNEL;else process.env.QQ_AGENT_CHANNEL=beforeChannel;
    setRuntimeConfig(before);buildToolDefs();
  }
});
