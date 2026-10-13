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

test('real agent gives research its own bounded send reminder without publishing thoughts or retrying sends', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-query-reply-agent-'));
  const thought = 'INTERNAL_RESEARCH_THOUGHT_NEVER_PUBLISH';
  const requests = [];
  let child, output = '', current, step = 0;
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ id: current.id, body });
    const action = current.steps[step++];
    const call = (name, args, suffix = '') => ({ id: `CALL_${requests.length}_${suffix}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } });
    const calls = action === 'history' ? [call('get_message_images', { messageId: 'HISTORICAL_IMAGE' })]
      : action === 'lookup' ? [call('get_message_detail', { messageId: current.id })]
      : action === 'search' ? [call('web_search', { query: 'offline one' }, '1'), call('web_search', { query: 'offline two' }, '2')]
      : action === 'fetch' ? [call('web_fetch', { url: 'https://example.invalid' })]
      : action === 'query-error' ? [call('web_search', { query: 'FAIL' })]
      : action === 'send' ? [call('send_message', { messages: current.reply })]
      : action === 'send-error' ? [call('send_message', { messages: 'Do not send this.', replyToMessageId: 'WRONG_ANCHOR' })]
      : action === 'unknown' ? [call('unknown_skill__potential_send', {})]
      : action === 'finish' ? [call('finish', { summary: 'Explicit intentional silence.' })] : [];
    const message = calls.length ? { role: 'assistant', content: null, tool_calls: calls }
      : { role: 'assistant', content: thought };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  });
  t.after(async () => { child?.kill('SIGKILL'); model.closeAllConnections(); await new Promise(r => model.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const token = 'offline-query-reply-token';
  child = fork(fileURLToPath(new URL('./helpers/docker-http-fixture.mjs', import.meta.url)), [], {
    env: { ...process.env, QQ_AGENT_DOCKER: '1', QQ_AGENT_CHANNEL: 'qqbot', QQ_AGENT_DATA_DIR: dir,
      QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '', QQ_AGENT_CONSOLE_TOKEN: token, QQ_AGENT_INTERNAL_PORT: String(port),
      QQBOT_APP_ID: '', QQBOT_APP_SECRET: '', TEST_LLM_URL: `http://127.0.0.1:${model.address().port}/v1`,
      TEST_QUOTE_IMAGES: '1', TEST_QUERY_TOOLS: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const [ready] = await once(child, 'message'); assert.ok(ready.ready);
  let seq = 0;
  async function rpc(action, fields = {}) {
    const id = ++seq; const pending = once(child, 'message'); child.send({ action, id, ...fields });
    const [r] = await pending; assert.equal(r.id, id); assert.ok(r.ok, r.error); return r;
  }
  const cases = [
    { id: 'RESEARCH_AFTER_INITIAL', steps: ['thought', 'history', 'search', 'thought', 'send', 'thought'], phases: ['initial', 'query'], reply: 'A sourced final answer.' },
    { id: 'IGNORE_BOTH', steps: ['thought', 'history', 'search', 'thought', 'thought'], phases: ['initial', 'query'] },
    { id: 'NO_THIRD_NUDGE', steps: ['thought', 'history', 'search', 'thought', 'search', 'thought'], phases: ['initial', 'query'] },
    { id: 'QUERY_FIRST', steps: ['search', 'thought', 'send', 'thought'], phases: ['query'], reply: 'A researched answer.' },
    { id: 'PRIVATE_FETCH', group: false, steps: ['fetch', 'thought', 'send', 'thought'], phases: ['query'], reply: 'A private researched answer.' },
    { id: 'QUERY_FAILED', steps: ['query-error', 'thought', 'send', 'thought'], phases: ['query'], reply: 'The query failed; I do not know yet.' },
    { id: 'NO_NEW_QUERY', steps: ['lookup', 'thought', 'thought'], phases: ['initial'] },
    { id: 'FRESH_LOOKUP', steps: ['thought', 'lookup', 'thought', 'send', 'thought'], phases: ['initial', 'query'], reply: 'A message lookup answer.' },
    { id: 'NO_SEND_RETRY', steps: ['lookup', 'search', 'send-error', 'thought'], phases: [] },
    { id: 'UNKNOWN_EFFECTS', steps: ['search', 'unknown', 'thought'], phases: [] },
    { id: 'EXPLICIT_FINISH', steps: ['search', 'finish'], phases: [] },
    { id: 'ROUND_LIMIT', maxRounds: 4, steps: ['thought', 'history', 'search', 'thought'], phases: ['initial'] }
  ];
  let expectedSent = 0;
  for (const scenario of cases) {
    current = scenario; step = 0;
    if (scenario.maxRounds) {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST',
        headers: { 'x-console-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ api: { maxRounds: scenario.maxRounds } }) });
      assert.equal(r.status, 200);
    }
    await rpc('receive', { group: scenario.group !== false, messageId: scenario.id, content: '<@!bot> Please research this synthetic example and answer.' });
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
    assert.ok(session, output);
    assert.equal(session.status, scenario.reply ? 'done' : 'noreply', scenario.id);
    assert.deepEqual(session.messages.filter(m => m.protocolReminder).map(m => m.protocolReminderPhase), scenario.phases, scenario.id);
    assert.equal(Boolean(session.queryReplyReminderUsed), scenario.phases.includes('query'), scenario.id);
    const runRequests = requests.filter(r => r.id === scenario.id);
    assert.equal(runRequests.length, scenario.steps.length, scenario.id);
    const toolResults = runRequests.flatMap(r => r.body.messages).filter(m => m.role === 'tool');
    for (const m of toolResults.filter(m => ['web_search', 'web_fetch'].includes(m.name))) {
      assert.match(m.content, /^OFFLINE_QUERY_(RESULT|FAILED)$/, 'all queries use offline substitutes');
    }
    if (scenario.steps.includes('send-error')) {
      assert.equal(session.messages.filter(m => m.toolCall?.name === 'send_message').length, 1);
      assert.equal(session.messages.find(m => m.toolCall?.name === 'send_message').toolCall.isError, true);
    }
    if (scenario.id === 'QUERY_FAILED') assert.ok(toolResults.some(m => m.content === 'OFFLINE_QUERY_FAILED'));
    if (scenario.reply) expectedSent++;
    const snapshot = await rpc('snapshot');
    assert.equal(snapshot.sent.length, expectedSent, scenario.id);
    assert.ok(snapshot.sent.every(s => !s.content.includes(thought)), 'no internal drafts are published');
    if (scenario.reply) {
      assert.equal(snapshot.sent.at(-1).content, scenario.reply);
      assert.equal(snapshot.sent.at(-1).target.msgId, scenario.id, 'post-query reply keeps its original frozen target');
    }
  }
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0); child = null;
});
