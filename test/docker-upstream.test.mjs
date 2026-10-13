import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-official-core-'));
Object.assign(process.env, { QQ_AGENT_DATA_DIR: data, QQ_AGENT_DOCKER: '1',
  QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '', QQBOT_APP_ID: '', QQBOT_APP_SECRET: '' });
const { chatCompletion } = await import('../src/llm.js');
const { skillManager } = await import('../src/skills/manager.js');
const { segmentsToText } = await import('../src/onebot.js');
const { ChatStore } = await import('../src/store.js');
const { resolveContextTier } = await import('../src/prompt.js');
const { logger } = await import('../src/logger.js');
const { skillSettingsPatch } = await import('../src/skills/settings-patch.js');
logger.mirrorConsole = false;
after(() => { logger.flush(); fs.rmSync(data, { recursive: true, force: true }); });
const api = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', thinkingMode: 'on' };
const messages = [{ role: 'user', content: 'synthetic fixture only' }];

test('official core builds thinking parameters without installing an extension or sending a request', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('buildOnly must not fetch'); });
  const { body } = await chatCompletion({ messages, overrides: api, buildOnly: true });
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.temperature, undefined);
  const off = await chatCompletion({ messages, overrides: api, skillContext: { thinkingMode: 'off' }, buildOnly: true });
  assert.deepEqual(off.body.thinking, { type: 'disabled' });
  assert.equal(off.body.temperature, 0.8);
});

test('an active legacy thinking adapter retains request ownership without core parameter injection', async t => {
  const original = skillManager.getCapabilityProviders.bind(skillManager);
  t.mock.method(skillManager, 'getCapabilityProviders', (cap, ctx) => cap === 'llm.request-params'
    ? [{ skillId: 'thinking-adapters', fn: ({ body }) => ({ body: { ...body, enable_thinking: false } }) }]
    : original(cap, ctx));
  const { body } = await chatCompletion({ messages, overrides: api, buildOnly: true });
  assert.equal(body.enable_thinking, false);
  assert.equal(body.thinking, undefined);
  assert.equal(body.temperature, 0.8);
});

test('official reasoning extraction works without plugins and does not double-count legacy usage', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'answer', reasoning_content: 'private reasoning' } }],
    usage: { prompt_tokens: 10, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 5 } }
  }), { headers: { 'content-type': 'application/json' } }));
  const first = await chatCompletion({ messages, overrides: api });
  assert.equal(first.reasoning, 'private reasoning');
  assert.equal(first.extraUsage.reasoningTokens, 5);
  t.mock.method(skillManager, 'getUsageTransforms', () => [() => ({ reasoningTokens: 5 })]);
  const second = await chatCompletion({ messages, overrides: api });
  assert.equal(second.extraUsage.reasoningTokens, 5);
  assert.equal(second.message.content, 'answer');
});

test('official thinking fallback strips rejected parameters once and restores sampling temperature', async t => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return sent.length === 1
      ? new Response('unsupported parameter: thinking', { status: 400 })
      : Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} });
  });
  const result = await chatCompletion({ messages, overrides: api, temperature: 0.3 });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].thinking, undefined);
  assert.equal(sent[1].temperature, 0.3);
  assert.equal(result.message.content, 'ok');
});

test('ordinary bad requests are not retried by thinking fallback', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unknown model', { status: 400 }); });
  await assert.rejects(chatCompletion({ messages, overrides: api }), /HTTP 400/);
  assert.equal(calls, 1);
});

test('official OneBot mention collector preserves identities, while same-name mentions do not wake', async () => {
  const marks = [];
  const text = await segmentsToText([{ type: 'at', data: { qq: 'other' } },
    { type: 'text', data: { text: ' hello' } }], { resolveAtName: () => '小鱼', onAt: m => marks.push(m) });
  assert.equal(marks[0].qq, 'other');
  const store = new ChatStore();
  const entry = store.appendIncoming('group:GROUP_fixture', { mid: 'opaque-fixture', ts: Date.now(),
    senderId: 'USER_fixture', senderName: 'fixture', text, atMe: false, atNames: marks.map(m => m.text) });
  assert.deepEqual(entry.atNames, [marks[0].text]);
  const result = resolveContextTier({ triggerEntries: [entry], botName: '小鱼', selfNickname: '小鱼',
    selfId: 'bot', cfg: { contextTier: 2, keywords: ['鱼'] } });
  assert.equal(result.shouldRespond, false);
  assert.equal(store.markEntryRead('group:GROUP_fixture', entry.id), true);
  assert.equal(store.getChatMeta('group:GROUP_fixture').unread, 0);
});

test('official batched logging flushes on demand and does not lose the last message', () => {
  logger.info('migration-fixture', 'synthetic flush sentinel');
  logger.flush();
  const logs = fs.readdirSync(path.join(data, 'logs'));
  assert.ok(logs.some(name => fs.readFileSync(path.join(data, 'logs', name), 'utf8').includes('synthetic flush sentinel')));
  assert.equal(logger.pendingDisk, '');
});

test('masked extension secrets round-trip without loss, including stable-ID account reorder', () => {
  const current = { cookie: 'fixture-cookie', accounts: [
    { id: 'a', baseUrl: 'https://a.invalid/v1', key: 'fixture-a' },
    { id: 'b', baseUrl: 'https://b.invalid/v1', key: 'fixture-b' }
  ] };
  const input = { cookie: '******', accounts: [
    { id: 'b', baseUrl: 'https://b.invalid/v1', key: '******' },
    { id: 'a', baseUrl: 'https://a.invalid/v1', key: '******' }
  ], unknown: 'ignored' };
  const before = structuredClone(current);
  const result = skillSettingsPatch(input, current, {}, { cookie: '', accounts: [] });
  assert.equal(Object.hasOwn(result, 'cookie'), false);
  assert.equal(Object.hasOwn(result, 'unknown'), false);
  assert.deepEqual(result.accounts.map(a => a.key), ['fixture-b', 'fixture-a']);
  assert.deepEqual(current, before);
  assert.equal(input.accounts[0].key, '******');
});

test('masked account secrets do not move to another endpoint or an ambiguous account', () => {
  const current = { accounts: [{ id: 'a', baseUrl: 'https://a.invalid/v1', key: 'fixture-a' }] };
  const defaults = { accounts: [] };
  const result = skillSettingsPatch({ accounts: [{ id: 'a', baseUrl: 'https://b.invalid/v1', key: '******' }] }, current, {}, defaults);
  assert.equal(result.accounts[0].key, '');
  assert.throws(() => skillSettingsPatch({ accounts: [{ id: 'unknown', key: '******' }] }, current, {}, defaults), /账号身份不明确/);
});

test('upstream integration retains the existing explicit image send/search opt-in', async t => {
  const { buildToolDefs } = await import('../src/tools.js');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('disabled tools must not fetch'); });
  const defs = buildToolDefs();
  for (const id of ['send_image', 'search_images']) {
    const result = await defs.find(d => d.id === id).execute({}, { url: 'https://example.invalid/image.png', query: 'fixture' });
    assert.match(JSON.stringify(result), /未开启/);
  }
});
