import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

// No real credentials, QQ traffic, plugin activation or production configuration.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-tool-schema-'));
Object.assign(process.env, { QQ_AGENT_DATA_DIR: root, QQ_AGENT_PROFILES_ROOT: '',
  QQ_AGENT_ACTIVE_ROBOT: '', QQ_AGENT_DOCKER: '1', QQBOT_APP_ID: '', QQBOT_APP_SECRET: '' });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { registerTool, getTool, unregisterTool } = await import('../src/tool-registry.js');
const { toOpenAiTools } = await import('../src/tools.js');
const { chatCompletion } = await import('../src/llm.js');
const definition = parameters => ({ id: 'schema_fixture', name: 'Schema fixture', parameters,
  description: 'Offline schema test', execute: async () => ({ content: 'fixture' }) });

test('registry normalizes legacy empty, null and omitted argument schemas without mutation', () => {
  for (const parameters of [{}, null, undefined]) {
    const def = definition(parameters);
    registerTool(def);
    assert.deepEqual(getTool(def.id).parameters, { type: 'object', properties: {} });
    assert.equal(def.parameters, parameters);
    if (parameters) assert.deepEqual(parameters, {});
    unregisterTool(def.id);
  }
});

test('tool schema normalization preserves optional, nested, nullable and additional-property constraints', () => {
  const original = { description: 'Arguments', properties: {
    query: { type: 'string', enum: ['a', 'b'] },
    optional: { type: ['string', 'null'] },
    nested: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' } } } }
  }, required: ['query'], additionalProperties: false, $defs: { other: { type: 'string' } } };
  const before = structuredClone(original);
  registerTool(definition(original));
  assert.deepEqual(getTool('schema_fixture').parameters, { ...before, type: 'object' });
  assert.deepEqual(original, before);
  const [wire] = toOpenAiTools([getTool('schema_fixture')]);
  assert.deepEqual(wire.function.parameters, { ...before, type: 'object' });
  assert.equal(wire.function.strict, undefined);
  unregisterTool('schema_fixture');
});

test('invalid explicit root types or properties fail at registration instead of breaking all chats', () => {
  for (const parameters of [[], true, 'object', { type: 'array' }, { type: 'string' },
    { type: ['object', 'null'] }, { type: null }, { properties: [] }, { properties: null }]) {
    unregisterTool('schema_fixture');
    assert.throws(() => registerTool(definition(parameters)), /schema_fixture.*parameters/);
    assert.equal(getTool('schema_fixture'), null);
  }
});

test('serialization also normalizes unregistered definitions and keeps legacy function names', () => {
  for (const parameters of [{}, undefined, null, { type: 'object' }]) {
    const [wire] = toOpenAiTools([{ name: 'legacy_fixture', description: 'No arguments', parameters }]);
    assert.deepEqual(wire, { type: 'function', function: { name: 'legacy_fixture',
      description: 'No arguments', parameters: { type: 'object', properties: {} } } });
  }
  assert.throws(() => toOpenAiTools([definition({ type: 'array' })]), /schema_fixture.*parameters/);
});

async function captureSkill(relativePath, id) {
  const defs = [];
  const { setup } = await import(relativePath);
  setup({ capability: () => undefined, registerTool: def => defs.push({ ...def, id: `${id}__${def.id}` }) });
  return defs;
}

test('bundled emotion and both mood entrypoints explicitly declare object schemas', async () => {
  for (const [file, id] of [['../skills/emotion-skill/index.js', 'emotion-skill'],
    ['../skills/mood-skill/index.js', 'mood-skill'], ['../skills/mood-skill/mood-skill/index.js', 'mood-skill']]) {
    const defs = await captureSkill(file, id);
    assert.ok(defs.length);
    for (const def of defs) assert.equal(def.parameters.type, 'object', def.id);
    // Keeping the tools available must not silently turn on their optional providers.
    const status = defs.find(def => /__(mood_state|mood_status)$/.test(def.id));
    assert.equal((await status.execute({}, {})).isError, true);
  }
});

test('real chat pipeline sends corrected no-argument tools to a strict schema endpoint', { timeout: 15_000 }, async t => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    res.setHeader('content-type', 'application/json');
    const invalid = body.tools.find(tool => tool.function.parameters?.type !== 'object');
    if (invalid) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: `Invalid schema for function '${invalid.function.name}': schema must be a JSON Schema of type object` } }));
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'offline-call', type: 'function', function: { name: 'emotion-skill__mood_state', arguments: '{}' } }] } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const defs = await captureSkill('../skills/emotion-skill/index.js', 'emotion-skill');
  // Reproduce the reported 400 through the same client with the old wire schema.
  const invalidTools = [{ type: 'function', function: { name: 'emotion-skill__mood_state', parameters: {} } }];
  const args = { messages: [{ role: 'user', content: 'Read the fixture status.' }],
    overrides: { baseUrl, apiKey: '', model: 'offline-schema-model', timeoutMs: 5_000 }, maxTokens: 32 };
  await assert.rejects(chatCompletion({ ...args, tools: invalidTools }), /HTTP 400.*Invalid schema/);
  const result = await chatCompletion({ ...args, tools: toOpenAiTools(defs) });
  assert.equal(result.message.tool_calls[0].function.name, 'emotion-skill__mood_state');
  assert.equal(result.message.tool_calls[0].function.arguments, '{}');
  assert.equal(bodies.length, 2, 'no silent retries, tools removal or provider switch');
  assert.equal(bodies[1].tools.length, 3);
  assert.equal(result.degraded, false);
});

test('connection UI clearly labels the probe as basic text-only connectivity', () => {
  const html = fs.readFileSync(new URL('../ui/connection.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../ui/connection-models.js', import.meta.url), 'utf8');
  assert.match(html, /id="model-test"[^>]*>基础连接测试</);
  assert.match(html, /不验证技能工具调用/);
  assert.match(js, /基础连接测试成功/);
});
