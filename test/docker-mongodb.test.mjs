import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as yaml from 'js-yaml';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('optional Mongo overlay is authenticated, internal-only and separate from the app data volume', () => {
  const overlay = yaml.load(read('compose.mongodb.yaml'));
  const mongo = overlay.services.mongodb, app = overlay.services['qq-agent'];
  assert.equal(mongo.ports, undefined);
  assert.equal(mongo.network_mode, undefined);
  assert.deepEqual(mongo.networks, ['growth-db']);
  assert.equal(overlay.networks['growth-db'].internal, true);
  assert.deepEqual(app.networks, ['default', 'growth-db']);
  assert.equal(app.depends_on.mongodb.condition, 'service_healthy');
  assert.equal(app.environment, undefined, 'never give root credentials to the bot');
  assert.match(mongo.environment.MONGO_INITDB_ROOT_PASSWORD, /:\?/);
  assert.ok(mongo.command.includes('--auth'));
  assert.equal(mongo.user, '999:999');
  assert.equal(mongo.read_only, true);
  assert.deepEqual(mongo.cap_drop, ['ALL']);
  assert.deepEqual(mongo.volumes, ['qq-agent-mongodb-data:/data/db']);
  assert.match(mongo.healthcheck.test.at(-1), /\.auth\(/);
  for (const file of ['compose.yaml', 'compose.release.yaml']) {
    const base = yaml.load(read(file));
    assert.equal(base.services.mongodb, undefined, 'database opt-in, not auto-enabled');
    assert.deepEqual(base.services['qq-agent'].volumes, ['qq-agent-data:/data']);
  }
});

test('growth database operations preserve explicit model settings and document two-volume backups', () => {
  const memory = JSON.parse(read('plugins/memory-growth/plugin.json'));
  assert.equal(memory.settings.extractionEnabled, false);
  assert.equal(memory.settings.inject, false);
  assert.equal(memory.settings.autoApproveEnabled, false);
  const doc = read('docs/MONGODB.md');
  for (const required of ['readWrite', 'authSource=admin', 'mongodb:27017', 'mongodump', 'config.json', 'qq-agent-mongodb-data', 'extractionEnabled']) assert.ok(doc.includes(required), required);
});

test('MongoDB URI stays private in real HTTP config/settings and masked saves keep credentials', { timeout: 30000 }, async t => {
  const os = await import('node:os'), path = await import('node:path'), net = await import('node:net');
  const { fork } = await import('node:child_process'), { once } = await import('node:events');
  const { fileURLToPath } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-mongo-secret-'));
  let child;
  t.after(() => { child?.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r));
  const token = 'offline-mongo-fixture-token';
  child = fork(fileURLToPath(new URL('./helpers/docker-http-fixture.mjs', import.meta.url)), [], {
    env: { ...process.env, QQ_AGENT_DOCKER:'1', QQ_AGENT_CHANNEL:'qqbot', QQ_AGENT_DATA_DIR:dir,
      QQ_AGENT_PROFILES_ROOT:'', QQ_AGENT_ACTIVE_ROBOT:'', QQ_AGENT_CONSOLE_TOKEN:token,
      QQ_AGENT_INTERNAL_PORT:String(port), QQBOT_APP_ID:'', QQBOT_APP_SECRET:'' },
    stdio: ['ignore','ignore','ignore','ipc']
  });
  assert.ok((await once(child, 'message'))[0].ready);
  // Synthetic credentials only. Disabled plugins do not open sockets.
  const uri = 'mongodb://fixture:synthetic-mongo-pass@127.0.0.1:1/?authSource=admin';
  const patch = { skills: Object.fromEntries(['kb-growth','memory-growth'].map(id => [id, { enabled:false, mongoUri:uri, mongoDb:'fixture_'+id.replace('-','_') }])) };
  const pending = once(child, 'message'); child.send({ action:'set-config', id:1, patch });
  assert.ok((await pending)[0].ok);
  const req = async (url, body) => {
    const r = await fetch(`http://127.0.0.1:${port}` + url, { headers:{'x-console-token':token, 'content-type':'application/json'}, ...(body ? { method:'POST', body:JSON.stringify(body) } : {}) });
    assert.equal(r.status, 200); const text = await r.text();
    assert.ok(!text.includes('synthetic-mongo-pass')); assert.ok(!text.includes(uri)); return JSON.parse(text);
  };
  const c = await req('/api/config');
  for (const id of ['kb-growth','memory-growth']) {
    assert.equal(c.skills[id].mongoUri, undefined); assert.equal(c.skills[id].hasMongoUri, true);
    const saved = await req('/api/skills/'+id, {settings:{mongoUri:'******'}});
    assert.equal(saved.settings.mongoUri,'******');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'config.json'))).skills[id].mongoUri, uri);
  }
  child.kill('SIGTERM'); assert.equal((await once(child,'exit'))[0],0); child=null;
});
