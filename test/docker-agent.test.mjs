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

// Real agent/orchestrator/sender, local fake model API and fake QQ transport.
// This is not evidence of live Tencent permissions or real model quality.
test('private and all group @ forms (event, structured, inline, bare) reach agent, tool call and reply pipeline', { timeout: 45_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-agent-'));
  const requests = [];
  let replyNumber = 0;
  let child, output = '';
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const done = body.messages.some(m => m.role === 'tool');
    const input = body.messages.filter(m => m.role === 'user').map(m => String(m.content)).join('\n');
    const lostMention = input.includes('当前在群聊') && !input.includes('本批新消息有人直接 @ 了你');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: done ? 'stop' : 'tool_calls', message: done
      ? { role: 'assistant', content: '' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'CALL_1', type: 'function', function: {
        name: lostMention ? 'finish' : 'send_message', arguments: JSON.stringify(lostMention
          ? {reason:'No visible direct mention in model prompt'} : { messages: `offline agent reply ${++replyNumber}` }),
      } }] }, }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  });
  t.after(async () => {
    child?.kill('SIGKILL'); model.closeAllConnections();
    await new Promise(r => model.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  child = fork(fileURLToPath(new URL('./helpers/docker-http-fixture.mjs', import.meta.url)), [], {
    env: { ...process.env, QQ_AGENT_DOCKER: '1', QQ_AGENT_CHANNEL: 'qqbot', QQ_AGENT_DATA_DIR: dir,
      QQ_AGENT_CONSOLE_TOKEN: 'offline-agent-console-token-only', QQ_AGENT_INTERNAL_PORT: String(port),
      QQBOT_APP_ID: '', QQBOT_APP_SECRET: '', TEST_LLM_URL: `http://127.0.0.1:${model.address().port}/v1` },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const [ready] = await once(child, 'message'); assert.ok(ready.ready);
  let seq = 0;
  async function rpc(action, options = {}) {
    const id = ++seq;
    const reply = once(child, 'message'); child.send({ action, ...options, id });
    const [result] = await reply; assert.equal(result.id, id); assert.ok(result.ok, result.error); return result;
  }
  for (const [index, mentionMode] of ['private','event','structured','inline','bare'].entries()) {
    const group = mentionMode !== 'private';
    const messageId = `MESSAGE_${index}`;
    await rpc('receive', { group, mentionMode, messageId });
    const deadline = Date.now() + 12_000;
    let sent;
    do {
      sent = (await rpc('snapshot')).sent;
      if (sent.length > index) break;
      await new Promise(r => setTimeout(r, 50));
    } while (Date.now() < deadline);
    assert.ok(sent.length > index, `No agent reply. Logs: ${output}`);
    assert.equal(sent[index].content, `offline agent reply ${index + 1}`);
    assert.equal(sent[index].target.scope, group ? 'group' : 'c2c');
    assert.equal(sent[index].target.targetId, group ? 'GROUP_with-hyphen' : 'USER_with-hyphen');
    assert.equal(sent[index].target.msgId, messageId);
  }
  assert.ok(requests.length >= 2);
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('OpenID')));
  assert.ok(requests.every(r => !r.tools?.some(t => ['send_poke', 'read_forward'].includes(t.function.name))));
  const groupPrompts=requests.map(r=>r.messages.filter(m=>m.role==='user').map(m=>String(m.content)).join('\n')).filter(s=>s.includes('当前在群聊'));
  assert.ok(groupPrompts.length>=4);
  assert.ok(groupPrompts.every(p=>p.includes('（@我）')&&p.includes('本批新消息有人直接 @ 了你')));
  await rpc('media-boundary');
  assert.ok(!output.includes('免费模型探测完成'), 'container boot must not warm external image providers');
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0); child = null;
});
