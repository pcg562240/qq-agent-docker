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

test('quoted screenshot and missing quote complete through real ingest/tools/nudge/send pipeline', { timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-quote-agent-'));
  let child, output = '', current = null;
  const requests = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const model = http.createServer(async (req, res) => {
    if (req.url === '/quoted.png') { res.setHeader('content-type', 'image/png'); res.end(png); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ id: current.id, ...body });
    const tools = body.messages.filter(m => m.role === 'tool');
    const reminded = body.messages.some(m => typeof m.content === 'string' && m.content.startsWith('【发送检查，仅提醒一次】'));
    const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `CALL_${tools.length}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const sent = tools.some(m => m.name === 'send_message');
    const message = !tools.length ? call('get_message_images', { messageId: current.id })
      : sent ? call('finish', { summary: '测试已发送' })
      : reminded && !current.ignoreReminder ? call('send_message', { messages: current.reply })
      : { role: 'assistant', content: '没图没链接，啥也没有。直接说看不到。' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  });
  t.after(async () => { child?.kill('SIGKILL'); model.closeAllConnections(); await new Promise(r => model.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  child = fork(fileURLToPath(new URL('./helpers/docker-http-fixture.mjs', import.meta.url)), [], {
    env: { ...process.env, QQ_AGENT_DOCKER: '1', QQ_AGENT_CHANNEL: 'qqbot', QQ_AGENT_DATA_DIR: dir,
      QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '',
      QQ_AGENT_CONSOLE_TOKEN: 'offline-quote-console-token', QQ_AGENT_INTERNAL_PORT: String(port),
      QQBOT_APP_ID: '', QQBOT_APP_SECRET: '', TEST_LLM_URL: `http://127.0.0.1:${model.address().port}/v1`, TEST_QUOTE_IMAGES: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const [ready] = await once(child, 'message'); assert.ok(ready.ready);
  let seq = 0;
  async function rpc(action, fields = {}) {
    const id = ++seq; const promise = once(child, 'message'); child.send({ action, id, ...fields });
    const [r] = await promise; assert.equal(r.id, id); assert.ok(r.ok, r.error); return r;
  }
  const cases = [
    { id: 'QUOTE_IMAGE', quote: { attachments: [{ content_type: 'image/png', url: `http://127.0.0.1:${model.address().port}/quoted.png` }] }, reply: '已看到你引用的测试截图。' },
    { id: 'QUOTE_MISSING', quote: {}, reply: '我这边没有拿到引用图片，请重发原图或截图。' },
    { id: 'QUOTE_IGNORED_REMINDER', quote: {}, ignoreReminder: true }
  ];
  for (const [index, scenario] of cases.entries()) {
    current = scenario;
    await rpc('receive', { group: true, messageId: scenario.id, quote: scenario.quote, content: '<@!bot> 肥肥，这个是什么新闻' });
    const end = Date.now() + 12000;
    let session;
    while (Date.now() < end) {
      const files = fs.existsSync(path.join(dir, 'sessions')) ? fs.readdirSync(path.join(dir, 'sessions')) : [];
      for (const f of files.filter(f => f.endsWith('.json'))) {
        let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f))); } catch { continue; }
        if (s.trigger?.some(e => e.mid === scenario.id) && ['done', 'noreply', 'error'].includes(s.status)) session = s;
      }
      if (session) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(session, `Session did not finish: ${output}`);
    assert.equal(session.replyReminderUsed, true, output);
    assert.equal(session.messages.filter(m => m.protocolReminder).length, 1);
    assert.equal(session.status, scenario.ignoreReminder ? 'noreply' : 'done', output);
    const snapshot = await rpc('snapshot');
    assert.equal(snapshot.sent.length, Math.min(index + 1, 2));
    assert.ok(snapshot.sent.every(s => !s.content.includes('直接说看不到')), 'never publish reasoning as a reply');
    if (!scenario.ignoreReminder) assert.equal(snapshot.sent.at(-1).content, scenario.reply);
  }
  const first = requests.filter(r => r.id === 'QUOTE_IMAGE');
  assert.ok(first.some(r => r.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'))), 'quoted image must reach model as media parts');
  assert.ok(first.some(r => r.messages.some(m => typeof m.content === 'string' && m.content.includes('[引用 [图片]]'))));
  const last = requests.filter(r => r.id === 'QUOTE_IGNORED_REMINDER');
  assert.equal(last.length, 3, 'one lookup, one silent turn, one reminder; no infinite retries');
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'messages/group_GROUP_with-hyphen.json')));
  assert.equal(persisted.messages.find(m => m.mid === 'QUOTE_IMAGE').reply.media.length, 1);
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0); child = null;
});
