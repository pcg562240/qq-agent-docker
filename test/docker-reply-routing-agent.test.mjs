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
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('real agent replies to A while B arrives during inference, then drains B with its own anchor', { timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-routing-agent-'));
  let child, output = '', scenario, blocked = false;
  const observed = [];
  const model = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const prompt = body.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('【本次唤醒】以下'))?.content || '';
      const trigger = prompt.split('【本次唤醒】以下').at(-1).split('【此刻状态】')[0];
      const who = trigger.includes(scenario.a) ? 'A' : trigger.includes(scenario.b) ? 'B' : null;
      assert.ok(who, 'model should receive the triggering opaque message id');
      const mid = who === 'A' ? scenario.a : scenario.b;
      const tools = body.messages.filter(m => m.role === 'tool');
      if (who === 'A' && !tools.length && !blocked) {
        blocked = true; scenario.entered.resolve(); await scenario.release.promise;
      }
      const args = { messages: [`${mid}:one`, `${mid}:two`], ...(scenario.quote ? { replyToMessageId: scenario.quote === 'display-hash' ? `#${mid}` : mid } : {}) };
      const name = tools.some(m => m.name === 'send_message') ? 'finish' : 'send_message';
      const message = { role: 'assistant', content: null, tool_calls: [{ id: `CALL_${who}_${name}`, type: 'function',
        function: { name, arguments: JSON.stringify(name === 'finish' ? { summary: 'done' } : args) } }] };
      observed.push({ mid, name });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  t.after(async () => { scenario?.release.resolve(); child?.kill('SIGKILL'); model.closeAllConnections(); await new Promise(r => model.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  child = fork(fileURLToPath(new URL('./helpers/docker-http-fixture.mjs', import.meta.url)), [], {
    env: { ...process.env, QQ_AGENT_DOCKER: '1', QQ_AGENT_CHANNEL: 'qqbot', QQ_AGENT_DATA_DIR: dir,
      QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '', QQ_AGENT_CONSOLE_TOKEN: 'offline-routing-token',
      QQ_AGENT_INTERNAL_PORT: String(port), QQBOT_APP_ID: '', QQBOT_APP_SECRET: '',
      TEST_LLM_URL: `http://127.0.0.1:${model.address().port}/v1`, TEST_QUOTE_IMAGES: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const [ready] = await once(child, 'message'); assert.ok(ready.ready);
  let seq = 0;
  async function rpc(action, fields = {}) {
    const id = ++seq; const pending = once(child, 'message'); child.send({ action, id, ...fields });
    const [r] = await pending; assert.equal(r.id, id); assert.ok(r.ok, r.error); return r;
  }
  for (const [i, quote] of [true, false, 'display-hash'].entries()) {
    scenario = { a: `ROBOT1.0_.A!${i}`, b: `ROBOT1.0_.B!${i}`, quote, entered: deferred(), release: deferred() }; blocked = false;
    await rpc('receive', { group: true, senderId: 'USER_A', messageId: scenario.a, content: '<@!bot> question A' });
    await scenario.entered.promise;
    // Guaranteed overlap: A's model HTTP response is still withheld here.
    await rpc('receive', { group: true, senderId: 'USER_B', messageId: scenario.b, content: '<@!bot> question B' });
    scenario.release.resolve();
    const end = Date.now() + 12000;
    let done = [];
    while (Date.now() < end) {
      const files = fs.readdirSync(path.join(dir, 'sessions')).filter(f => f.endsWith('.json'));
      done = files.flatMap(f => { try { return [JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f)))]; } catch { return []; } })
        .filter(s => s.trigger?.some(m => [scenario.a, scenario.b].includes(m.mid)) && ['done', 'noreply', 'error'].includes(s.status));
      if (done.length === 2) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(done.length, 2, output);
    assert.ok(done.every(s => s.status === 'done'), output);
    for (const s of done) {
      assert.equal(s.trigger.length, 1);
      assert.ok(s.sent.every(m => m.replySourceMessageId === s.trigger[0].mid && m.replyUserId === s.trigger[0].senderId));
    }
    const sent = (await rpc('snapshot')).sent.slice(i * 4);
    assert.equal(sent.length, 4, output);
    assert.deepEqual(sent.map(s => s.target.msgId), [scenario.a, scenario.a, scenario.b, scenario.b]);
    assert.equal(sent[0].content, `${scenario.a}:one`);
    assert.equal(sent[1].content, `${scenario.a}:two`);
    assert.equal(sent[0].messageReference?.message_id, quote ? scenario.a : undefined);
    assert.equal(sent[1].messageReference, undefined);
  }
  assert.equal(observed.filter(r => r.name === 'send_message').length, 6);
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0); child = null;
});
