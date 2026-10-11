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

test('zero-tool direct messages nudge once through real agent without publishing reasoning or exceeding round budget', { timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-direct-reply-agent-'));
  let child, output = '', current;
  const requests = [];
  const thought = 'INTERNAL_PLANNING_NOT_FOR_QQ';
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ id: current.id, body });
    const reminded = body.messages.some(m => typeof m.content === 'string' && m.content.startsWith('【发送检查，仅提醒一次】'));
    const sent = body.messages.some(m => m.role === 'tool' && m.name === 'send_message');
    const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `CALL_${requests.length}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] });
    const message = current.explicitFinish ? call('finish', { summary: 'No reply needed in this test.' })
      : !sent && (current.sendFirst || (reminded && !current.ignoreReminder)) ? call('send_message', { messages: current.reply })
      : { role: 'assistant', content: current.empty ? '' : current.reasoningOnly ? null : thought,
        ...(current.reasoningOnly ? { reasoning_content: thought } : {}) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  });
  t.after(async () => { child?.kill('SIGKILL'); model.closeAllConnections(); await new Promise(r => model.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const token = 'offline-direct-reply-token';
  child = fork(fileURLToPath(new URL('./helpers/docker-http-fixture.mjs', import.meta.url)), [], {
    env: { ...process.env, QQ_AGENT_DOCKER: '1', QQ_AGENT_CHANNEL: 'qqbot', QQ_AGENT_DATA_DIR: dir,
      QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '', QQ_AGENT_CONSOLE_TOKEN: token, QQ_AGENT_INTERNAL_PORT: String(port),
      QQBOT_APP_ID: '', QQBOT_APP_SECRET: '', TEST_LLM_URL: `http://127.0.0.1:${model.address().port}/v1`, TEST_QUOTE_IMAGES: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const [ready] = await once(child, 'message'); assert.ok(ready.ready);
  let seq = 0;
  async function rpc(action, fields = {}) {
    const id = ++seq; const pending = once(child, 'message'); child.send({ action, id, ...fields });
    const [r] = await pending; assert.equal(r.id, id); assert.ok(r.ok, r.error); return r;
  }
  const cases = [
    { id: 'DIRECT_GROUP', group: true, reply: 'A natural reply.', calls: 3, reminder: true },
    { id: 'DIRECT_PRIVATE', group: false, reasoningOnly: true, reply: 'A private reply.', calls: 3, reminder: true },
    { id: 'DIRECT_EMPTY', group: true, empty: true, reply: 'An actual visible reply.', calls: 3, reminder: true },
    { id: 'DIRECT_IGNORES', group: true, ignoreReminder: true, calls: 2, reminder: true },
    { id: 'DIRECT_FINISH', group: true, explicitFinish: true, calls: 1, reminder: false },
    { id: 'DIRECT_SENT', group: true, sendFirst: true, reply: 'Already sent once.', calls: 2, reminder: false },
    { id: 'DIRECT_LIMIT', group: true, maxRounds: 1, calls: 1, reminder: false }
  ];
  let expectedSent = 0;
  for (const scenario of cases) {
    current = scenario;
    if (scenario.maxRounds) {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST',
        headers: { 'x-console-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ api: { maxRounds: scenario.maxRounds } }) });
      assert.equal(r.status, 200);
    }
    await rpc('receive', { group: scenario.group, messageId: scenario.id, content: scenario.group ? '<@!bot> Please respond to this test.' : 'Please respond privately.' });
    const end = Date.now() + 12000;
    let session;
    while (Date.now() < end) {
      for (const f of fs.readdirSync(path.join(dir, 'sessions')).filter(f => f.endsWith('.json'))) {
        let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f))); } catch { continue; }
        if (s.trigger?.some(e => e.mid === scenario.id) && ['done', 'noreply', 'error'].includes(s.status)) session = s;
      }
      if (session) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(session, output);
    assert.equal(Boolean(session.replyReminderUsed), scenario.reminder, `${scenario.id}: ${output}`);
    assert.equal(session.messages.filter(m => m.protocolReminder).length, scenario.reminder ? 1 : 0);
    assert.equal(requests.filter(r => r.id === scenario.id).length, scenario.calls);
    assert.equal(session.status, scenario.reply ? 'done' : 'noreply');
    if (scenario.reply) expectedSent++;
    const snapshot = await rpc('snapshot');
    assert.equal(snapshot.sent.length, expectedSent);
    assert.ok(snapshot.sent.every(s => !s.content.includes(thought)), 'do not publish either content or reasoning drafts');
    if (scenario.reply) {
      assert.equal(snapshot.sent.at(-1).content, scenario.reply);
      assert.equal(snapshot.sent.at(-1).target.msgId, scenario.id, 'reminder retains original reply anchor');
    }
  }
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0); child = null;
});
