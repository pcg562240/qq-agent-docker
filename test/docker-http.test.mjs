import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('headless HTTP authentication, OpenID routing, ingress, persistence and shutdown', { timeout: 45_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-http-'));
  const token = 'testP4ss_9'; // Synthetic 10-character chosen password; never a real credential.
  let child, output = '';
  t.after(() => { child?.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  async function boot() {
    child = fork(fileURLToPath(new URL('./helpers/docker-http-fixture.mjs', import.meta.url)), [], {
      env: { ...process.env, QQ_AGENT_DOCKER: '1', QQ_AGENT_CHANNEL: 'qqbot', QQ_AGENT_DATA_DIR: dir,
        QQ_AGENT_ALLOWED_HOSTS: `192.168.100.25:${port}`,
        QQ_AGENT_CONSOLE_TOKEN: token, QQ_AGENT_INTERNAL_PORT: String(port), QQBOT_APP_ID: '', QQBOT_APP_SECRET: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    await new Promise((resolve, reject) => {
      child.once('message', m => m.ready ? resolve() : reject(new Error(JSON.stringify(m))));
      child.once('exit', code => reject(new Error(`startup exited ${code}: ${output}`)));
    });
  }
  await boot();
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  assert.equal((await request('/healthz')).status, 200);
  // Public same-origin favicon works on the password screen and every UI page.
  for(const [url,type,signature] of [['/favicon.ico?v=20261011','image/x-icon','00000100'],['/favicon.png?v=20261011','image/png','89504e47']]) {
    const r=await request(url);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),type);
    assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,4).toString('hex'),signature);
  }
  assert.ok((await (await request('/login.html')).text()).includes('href="/favicon.ico?v=20261011"'));

  assert.equal((await request('/api/config')).status, 401);
  assert.equal((await request('/')).status, 302);
  const bad = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) });
  assert.equal(bad.status, 401);
  const login = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' };
  assert.equal((await request('/api/config', { headers: { ...headers, origin: 'https://attacker.invalid' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/config', { headers: { ...headers, host: 'attacker.invalid' } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  // Node fetch rewrites Host on some versions; use raw HTTP for LAN authorities.
  function lanRequest(url, method = 'GET', body, extra = {}) {
    return new Promise((resolve, reject) => {
      const host = `192.168.100.25:${port}`;
      const r = http.request(base + url, { method, headers: { host, origin: `http://${host}`, 'content-type': 'application/json', ...extra } }, res => {
        let text = ''; res.on('data', x => { text += x; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      r.on('error', reject); r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  assert.equal((await lanRequest('/api/config')).status, 401);
  const lanLogin = await lanRequest('/auth/login', 'POST', { token });
  assert.equal(lanLogin.status, 200);
  const lanCookie = lanLogin.headers['set-cookie'][0].split(';')[0];
  assert.equal((await lanRequest('/api/status', 'GET', undefined, { cookie: lanCookie })).status, 200);
  const stream = await new Promise((resolve, reject) => {
    const host = `192.168.100.25:${port}`;
    const r = http.get(base + '/api/events', {
      headers: { host, cookie: lanCookie, referer: `http://${host}/`, accept: 'text/event-stream' },
    }, res => {
      res.once('data', () => {
        resolve({ status: res.statusCode, type: res.headers['content-type'] });
        res.destroy(); r.destroy();
      });
    });
    r.setTimeout(5000, () => r.destroy(new Error('LAN event stream timed out')));
    r.on('error', reject);
  });
  assert.equal(stream.status, 200); assert.match(stream.type, /text\/event-stream/);
  assert.equal((await lanRequest('/api/events', 'GET', undefined, { cookie: lanCookie, origin: 'http://evil.test' })).status, 403);
  assert.equal((await lanRequest('/auth/login', 'POST', { token }, { origin: 'http://evil.test' })).status, 403);
  assert.equal((await lanRequest('/auth/logout', 'POST', {}, { cookie: lanCookie, origin: 'http://evil.test' })).status, 403);
  assert.equal((await lanRequest('/auth/logout', 'POST', {}, { cookie: lanCookie })).status, 200);
  const cfg = await (await request('/api/config', { headers })).json();
  assert.equal(cfg.qqbot.clientSecret, undefined); assert.equal(cfg.qqbot.hasClientSecret, true);
  assert.equal(cfg.server.token, undefined);
  // QR endpoints inherit LAN authentication/origin policy and save only on confirmation.
  assert.equal((await lanRequest('/api/qq/login/start', 'POST', {})).status, 401);
  assert.equal((await lanRequest('/api/qq/login/start', 'POST', {}, {cookie:lanCookie,origin:'http://evil.test'})).status,403);
  const qrStart = await lanRequest('/api/qq/login/start', 'POST', {}, {cookie:lanCookie});
  assert.equal(qrStart.status,200); assert.equal(qrStart.headers['cache-control'],'no-store');
  const qrId = JSON.parse(qrStart.text).id;
  const beforeQr = fs.readFileSync(path.join(dir,'config.json'),'utf8');
  child.send({id:'qr',action:'qr-authorize'}); const [qrReply] = await once(child,'message'); assert.equal(qrReply.ok,true);
  const qrReady = await lanRequest('/api/qq/login/status','POST',{id:qrId},{cookie:lanCookie});
  assert.equal(JSON.parse(qrReady.text).status,'authorized'); assert.ok(!qrReady.text.includes('QR_FIXTURE_SECRET'));
  assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),beforeQr);
  const wrong = await lanRequest('/api/qq/login/confirm','POST',{id:qrId,appId:'999'},{cookie:lanCookie});
  assert.equal(wrong.status,400); assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),beforeQr);
  const confirmBody = {id:qrId,appId:'123456',allowScanUser:true};
  assert.equal((await lanRequest('/api/qq/login/confirm','POST',confirmBody,{cookie:lanCookie,origin:'http://evil.test'})).status,403);
  const identityFile = path.join(dir,'qqbot','account.json');
  const originalIdentity = fs.readFileSync(identityFile,'utf8');
  for (const identity of [{appId:'999'},{}]) {
    fs.writeFileSync(identityFile,JSON.stringify(identity));
    assert.equal((await lanRequest('/api/qq/login/confirm','POST',confirmBody,{cookie:lanCookie})).status,409);
    assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),beforeQr);
  }
  fs.writeFileSync(identityFile,originalIdentity);
  const applied = await lanRequest('/api/qq/login/confirm','POST',confirmBody,{cookie:lanCookie});
  assert.equal(applied.status,200); assert.ok(!applied.text.includes('QR_FIXTURE_SECRET'));
  const qrConfig = JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
  assert.equal(qrConfig.qqbot.clientSecret,'QR_FIXTURE_SECRET'); assert.equal(qrConfig.qqbot.authSource,'qr');
  assert.ok(qrConfig.allow.private.includes('SCAN_user-1')); assert.ok(qrConfig.allow.private.includes('USER_with-hyphen'));
  assert.equal((await lanRequest('/api/qq/login/confirm','POST',confirmBody,{cookie:lanCookie})).status,409);
  assert.equal((await request('/connection.html', { headers })).status, 200);
  assert.equal((await request('/api/snowluma/start', { method: 'POST', headers, body: '{}' })).status, 409);
  const ready = await (await request('/api/integration', { headers })).json();
  assert.equal(ready.type, 'qqbot'); assert.equal(ready.connected, true);
  child.send({ id: 1, action: 'receive' });
  const [reply] = await once(child, 'message'); assert.equal(reply.ok, true);
  const messagesPath = '/api/chats/private_USER_with-hyphen/messages';
  let messages = await (await request(messagesPath, { headers })).json();
  assert.equal(messages.messages[0].mid, 'MID_with-hyphen');
  const send = await request('/api/chats/private_USER_with-hyphen/test-send', {
    method: 'POST', headers, body: JSON.stringify({ text: 'offline reply' }),
  });
  assert.equal(send.status, 200); assert.equal((await send.json()).messageId, 'SENT_STRING_ID');
  const patch = await request('/api/config', { method: 'POST', headers, body: JSON.stringify({ persona: { botName: 'Docker test' } }) });
  assert.equal(patch.status, 200);
  const persisted = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!persisted.includes(token), 'environment console password must not be written into config');
  child.kill('SIGTERM'); const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0);
  await boot();
  const chats = await (await request('/api/chats', { headers })).json();
  assert.ok(chats.chats.some(chat => chat.key === 'private:USER_with-hyphen'));
  messages = await (await request(messagesPath, { headers })).json();
  assert.equal(messages.messages[0].mid, 'MID_with-hyphen');
  const cfg2 = await (await request('/api/config', { headers })).json(); assert.equal(cfg2.persona.botName, 'Docker test');
  assert.equal(cfg2.qqbot.authSource,'qr'); assert.equal(cfg2.qqbot.clientSecret,undefined); assert.equal(cfg2.qqbot.hasClientSecret,true);
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0); child = null;
  assert.ok(!output.includes('FIXTURE_SECRET'), 'logs must not contain app secret');
  assert.ok(!output.includes('QR_FIXTURE_SECRET'), 'logs must not contain QR app secret');
});
