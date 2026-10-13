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

// Everything uses isolated files and a local model server; never contacts QQ or a paid model.
test('connection model management HTTP integration', { timeout: 60_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-models-'));
  const token = 'offline-model-management-token';
  let child, output = '', context, calls = [];
  const modelServer = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/denied/')) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: `bad key: ${req.headers.authorization}` } })); }
    if (req.url.startsWith('/redirect/')) { res.writeHead(307, { location: '/elsewhere/models' }); return res.end(); }
    if (req.url.startsWith('/html/')) return res.end('<html>wrong endpoint</html>');
    if (req.url.startsWith('/malformed/')) return res.end(JSON.stringify({ error: { message: 'wrong protocol' } }));
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }, { id: 'alpha' }, 'gamma', { id: {} }, { id: 'bad\nmodel' }] }));
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
  });
  modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
  const modelBase = `http://127.0.0.1:${modelServer.address().port}`;
  const portServer = net.createServer().listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(r => portServer.close(r));
  const initial = { qqbot: { appId: '111', clientSecret: 'FAKE_BOT_SECRET', enabled: true },
    api: { baseUrl: modelBase + '/a', model: 'alpha', apiKey: 'FAKE_KEY_A', provider: '', visionModel: 'keep-vision', videoModel: 'keep-video', temperature: 0.45 },
    providers: [{ id: 'b', displayName: 'B', baseURL: modelBase + '/b', models: ['beta'] },
      { id: 'free', baseURL: modelBase + '/free', models: ['gamma'] }],
    dshProviderKeys: { b: 'FAKE_KEY_B' }, extensions: { hotReload: false } };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(initial));
  t.after(async () => { if (child) { const end = once(child, 'exit'); child.kill('SIGKILL'); await end; }
    modelServer.closeAllConnections(); await new Promise(r => modelServer.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  async function boot() {
    child = fork(fileURLToPath(new URL('./helpers/docker-profiles-fixture.mjs', import.meta.url)), [], {
      env: { ...process.env, QQ_AGENT_DOCKER: '1', QQ_AGENT_CHANNEL: 'qqbot', QQ_AGENT_DATA_DIR: root,
        QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '', QQ_AGENT_CONSOLE_TOKEN: token, QQ_AGENT_INTERNAL_PORT: String(port), QQBOT_APP_ID: '', QQBOT_APP_SECRET: '', TEST_LLM_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', v => { output += v; }); child.stderr.on('data', v => { output += v; });
    await new Promise((resolve, reject) => { child.once('message', m => m.ready ? resolve() : reject(new Error(JSON.stringify(m)))); child.once('exit', code => reject(new Error(`startup ${code}: ${output}`))); });
  }
  const origin = `http://127.0.0.1:${port}`;
  const request = (route, data, headers = {}) => fetch(origin + route, { method: data === undefined ? 'GET' : 'POST', headers: {
    'content-type': 'application/json', 'x-console-token': token, ...(context ? { 'x-qq-profile-context': context } : {}), ...headers },
    ...(data === undefined ? {} : { body: typeof data === 'string' ? data : JSON.stringify(data) }) });
  async function api(route, data) { const res = await request(route, data); const result = await res.json(); assert.equal(res.status, 200, JSON.stringify(result)); return result; }
  const endpoint = action => '/api/connection/models' + (action ? '/' + action : '');
  const stored = () => JSON.parse(fs.readFileSync(path.join(root, 'shared-models.json')));
  const configBytes = () => fs.readFileSync(path.join(root, 'shared-models.json'), 'utf8');
  await boot(); context = (await api('/api/robots')).context;
  let aId;
  await t.test('catalog is read-only, shared, exposes legacy current and no keys', async () => {
    const before = configBytes(), catalog = await api(endpoint());
    assert.equal(catalog.shared, true); assert.equal(catalog.current.legacy, true); assert.equal(catalog.current.hasKey, true);
    assert.deepEqual(catalog.items.map(i => i.model), ['alpha', 'beta', 'gamma']);
    assert.ok(!JSON.stringify(catalog).includes('FAKE_KEY')); assert.equal(configBytes(), before);
  });
  await t.test('fetch sanitizes/deduplicates IDs and uses exact current/provider credentials', async () => {
    const before = configBytes();
    assert.deepEqual((await api(endpoint('fetch'), { baseUrl: modelBase + '/a/', useCurrent: true })).models, ['alpha', 'beta', 'gamma']);
    assert.equal(calls.at(-1).auth, 'Bearer FAKE_KEY_A');
    await api(endpoint('fetch'), { baseUrl: modelBase + '/b', providerId: 'b' }); assert.equal(calls.at(-1).auth, 'Bearer FAKE_KEY_B');
    await api(endpoint('fetch'), { baseUrl: modelBase + '/new' }); assert.equal(calls.at(-1).auth, undefined);
    await api(endpoint('fetch'), { baseUrl: modelBase + '/free', providerId: 'free' }); assert.equal(calls.at(-1).auth, undefined);
    assert.equal(configBytes(), before);
  });
  await t.test('mismatched endpoint rejects without forwarding keys; malformed inputs rejected', async () => {
    const count = calls.length;
    for (const data of [{ baseUrl: modelBase + '/new', providerId: 'b' }, { baseUrl: 'file:///tmp/models' },
      { baseUrl: 'https://user:pass@example.invalid/v1' }, { baseUrl: modelBase + '/v1?api_key=secret' },
      { baseUrl: modelBase + '/models' }, { baseUrl: modelBase, apiKey: {} }, [], 'not-json']) {
      assert.equal((await request(endpoint('fetch'), data)).status, 400);
    }
    assert.equal(calls.length, count);
    assert.equal((await request(endpoint('save'), { baseUrl: modelBase, model: 'x\ny' })).status, 400);
  });
  await t.test('tests use chosen model, report latency and do not mutate config', async () => {
    const before = configBytes();
    const { result } = await api(endpoint('test'), { baseUrl: modelBase + '/b', model: 'beta', providerId: 'b' });
    assert.equal(result.ok, true); assert.match(result.note, /pong/); assert.ok(result.latencyMs >= 0);
    assert.equal(result.scope, 'text-only'); assert.match(result.note, /未验证技能工具调用/);
    assert.equal(calls.at(-1).body.tools, undefined);
    assert.equal(calls.at(-1).body.model, 'beta'); assert.equal(calls.at(-1).body.stream, false);
    assert.equal(calls.at(-1).auth, 'Bearer FAKE_KEY_B'); assert.equal(configBytes(), before);
    assert.equal((await request(endpoint('test'), { baseUrl: modelBase })).status, 400);
  });
  await t.test('errors redact keys and reject HTTP 200 malformed chat responses and redirects', async () => {
    for (const action of ['fetch', 'test']) {
      const response = await request(endpoint(action), { baseUrl: modelBase + '/denied', model: 'x', apiKey: 'FAKE_KEY_SUBMITTED' });
      const text = await response.text(); assert.ok(!text.includes('FAKE_KEY_SUBMITTED')); assert.match(text, /REDACTED/);
      const start = calls.length;
      const redirect = await request(endpoint(action), { baseUrl: modelBase + '/redirect', model: 'x', apiKey: 'FAKE_KEY_SUBMITTED' });
      const result = await redirect.json(); assert.ok(result.ok === false || result.result.ok === false); assert.equal(calls.length, start + 1);
    }
    for (const dir of ['html', 'malformed']) {
      assert.equal((await api(endpoint('test'), { baseUrl: modelBase + '/' + dir, model: 'x' })).result.ok, false);
      assert.equal((await request(endpoint('fetch'), { baseUrl: modelBase + '/' + dir })).status, 502);
    }
  });
  await t.test('save-only adds multiple models without activation or duplicate models', async () => {
    const current = stored().api;
    for (const model of ['beta-extra', 'beta-extra', 'beta-last']) {
      const saved = await api(endpoint('save'), { baseUrl: modelBase + '/b', providerId: 'b', model });
      assert.equal(saved.activated, false); assert.equal(saved.current.model, 'alpha');
    }
    for (const [k, v] of Object.entries(current)) assert.deepEqual(stored().api[k], v);
    assert.deepEqual(stored().providers.find(p => p.id === 'b').models, ['beta', 'beta-extra', 'beta-last']);
    assert.equal(stored().dshProviderKeys.b, 'FAKE_KEY_B');
  });
  await t.test('activation preserves previous manual model and advanced settings; switching back restores key', async () => {
    const switched = await api(endpoint('select'), { providerId: 'b', model: 'beta-extra' });
    assert.equal(switched.current.model, 'beta-extra');
    assert.equal(stored().api.provider, 'b'); assert.equal(stored().api.apiKey, '');
    assert.equal(stored().api.visionModel, 'keep-vision'); assert.equal(stored().api.videoModel, 'keep-video'); assert.equal(stored().api.temperature, 0.45);
    aId = switched.items.find(i => i.model === 'alpha').providerId; assert.ok(aId); assert.equal(stored().dshProviderKeys[aId], 'FAKE_KEY_A');
    await api(endpoint('select'), { providerId: aId, model: 'alpha' });
    await api(endpoint('test'), { baseUrl: modelBase + '/a', providerId: aId, model: 'alpha' });
    assert.equal(calls.at(-1).auth, 'Bearer FAKE_KEY_A');
  });
  await t.test('activation of no-key/new provider never inherits old global key', async () => {
    await api(endpoint('select'), { providerId: 'free', model: 'gamma' });
    await api(endpoint('test'), { baseUrl: modelBase + '/free', providerId: 'free', model: 'gamma' });
    assert.equal(calls.at(-1).auth, undefined); assert.equal(stored().api.apiKey, '');
    const created = await api(endpoint('save'), { baseUrl: modelBase + '/c', apiKey: 'FAKE_KEY_C', model: 'charlie', activate: true });
    assert.equal(created.current.model, 'charlie'); assert.equal(stored().api.baseUrl, modelBase + '/c');
    assert.equal(stored().dshProviderKeys[created.saved.providerId], 'FAKE_KEY_C');
  });
  await t.test('invalid selections, unauthenticated, cross-origin and stale-context writes blocked', async () => {
    const before = configBytes();
    assert.equal((await request(endpoint('select'), { providerId: 'missing', model: 'x' })).status, 400);
    assert.equal((await request(endpoint('select'), { providerId: 'b', model: 'missing' })).status, 400);
    const body = { providerId: 'b', model: 'beta' };
    assert.equal((await request(endpoint('select'), body, { 'x-console-token': '' })).status, 401);
    assert.equal((await request(endpoint('select'), body, { origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await request(endpoint('select'), body, { 'x-qq-profile-context': 'stale' })).status, 409);
    assert.equal((await request(endpoint('save'), { payload: 'x'.repeat(17000) })).status, 413);
    assert.equal(configBytes(), before);
  });
  await t.test('shared catalog survives robot switch/restart and unrelated connection settings', async () => {
    await api('/api/robots/save', { appId: '222', appSecret: 'FAKE_BOT_B' });
    const before = configBytes();
    const ended = once(child, 'exit'); await api('/api/robots/switch', { appId: '222' }); await ended; child = null;
    await boot(); context = undefined; context = (await api('/api/robots')).context;
    assert.equal((await api(endpoint())).current.model, 'charlie'); assert.equal(configBytes(), before);
    await api('/api/config', { allow: { groups: ['GROUP_TEST'] } }); assert.equal(configBytes(), before);
    const catalog = await api(endpoint()); assert.ok(catalog.items.some(i => i.providerId === aId));
    const reply = once(child, 'message'); child.send({ id: 'snapshot', action: 'snapshot' });
    assert.deepEqual((await reply)[0].sent, []);
    for (const secret of ['FAKE_KEY_A', 'FAKE_KEY_B', 'FAKE_KEY_C', token]) assert.ok(!output.includes(secret));
  });
  await t.test('same-endpoint accounts require disambiguation; legacy current keeps its own key', async () => {
    const providers = stored().providers;
    await api('/api/config', { providers: [...providers,
      { id: 'duplicate-1', baseURL: modelBase + '/duplicate', models: ['one'] },
      { id: 'duplicate-2', baseURL: modelBase + '/duplicate', models: ['two'] }],
      dshProviderKeys: { 'duplicate-1': 'FAKE_DUP_1', 'duplicate-2': 'FAKE_DUP_2' },
      api: { provider: '', baseUrl: modelBase + '/duplicate', model: 'manual', apiKey: 'FAKE_CURRENT_DUP' } });
    assert.equal((await request(endpoint('fetch'), { baseUrl: modelBase + '/duplicate' })).status, 400);
    await api(endpoint('fetch'), { baseUrl: modelBase + '/duplicate', useCurrent: true });
    assert.equal(calls.at(-1).auth, 'Bearer FAKE_CURRENT_DUP');
    await api(endpoint('fetch'), { baseUrl: modelBase + '/duplicate', providerId: 'duplicate-2' });
    assert.equal(calls.at(-1).auth, 'Bearer FAKE_DUP_2');
    await api(endpoint('save'), { baseUrl: modelBase + '/duplicate', useCurrent: true, model: 'manual', activate: true });
    const current = stored().api;
    assert.notEqual(current.provider, 'duplicate-1'); assert.notEqual(current.provider, 'duplicate-2');
    assert.equal(stored().dshProviderKeys[current.provider], 'FAKE_CURRENT_DUP');
    assert.equal(stored().dshProviderKeys['duplicate-1'], 'FAKE_DUP_1');
  });
  await t.test('invalid legacy endpoint does not prevent configuring a valid saved model', async () => {
    await api('/api/config', { api: { provider: '', baseUrl: 'old-invalid-address', model: 'old' } });
    const result = await api(endpoint('select'), { providerId: 'b', model: 'beta' });
    assert.equal(result.current.model, 'beta'); assert.equal(result.current.baseUrl, modelBase + '/b');
  });

});
