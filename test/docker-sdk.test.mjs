import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { QQBotClient } from '../src/qqbot.js';

test('real Tencent SDK talks to local token/gateway/REST fixtures', { timeout: 15_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-sdk-'));
  const requests = [];
  const events = [];
  let base, client, incomingResolve;
  const incoming = new Promise(resolve => { incomingResolve = resolve; });
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    requests.push({ url: req.url, body, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/app/getAppAccessToken') return res.end(JSON.stringify({ access_token: 'FAKE_TOKEN', expires_in: 7200 }));
    if (req.url === '/gateway') return res.end(JSON.stringify({ url: base.replace('http:', 'ws:') }));
    if (req.url.endsWith('/files')) return res.end(JSON.stringify({ file_info: 'FIXTURE_MEDIA', file_uuid: 'FIXTURE_UUID', ttl: 300 }));
    if (req.url.startsWith('/v2/users/') || req.url.startsWith('/v2/groups/')) return res.end(JSON.stringify({ id: 'SDK_REPLY_ID' }));
    res.writeHead(404); res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on('message', raw => {
      const packet = JSON.parse(raw);
      if (packet.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
      if (packet.op === 2) {
        assert.equal(packet.d.token, 'QQBot FAKE_TOKEN'); assert.equal(packet.d.intents, 1 << 25);
        socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture-session', user: { id: 'BOT' } } }));
        socket.send(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: {
          id: 'SDK_INBOUND_ID', author: { user_openid: 'USER_SDK' }, content: 'hello', timestamp: new Date().toISOString(),
        } }));
        socket.send(JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 3, d: {
          id: 'SDK_GROUP_ID', author: { member_openid: 'USER_SDK' }, group_openid: 'GROUP_SDK',
          content: '<@!BOT> group hello', timestamp: new Date().toISOString(),
        } }));
        socket.send(JSON.stringify({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 4, d: {
          id: 'SDK_GROUP_MENTION_ID', author: { member_openid: 'USER_SDK' }, group_openid: 'GROUP_SDK',
          mentions: [{id:'BOT',is_you:true,bot:true}], content: 'server-marked mention', timestamp: new Date().toISOString(),
        } }));
        socket.send(JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 5, d: {
          id: 'SDK_QUOTED_IMAGE_QUESTION', author: { member_openid: 'USER_SDK' }, group_openid: 'GROUP_SDK',
          content: '<@!BOT> 这是什么新闻？', timestamp: new Date().toISOString(), message_type: 103,
          message_scene: { ext: ['msg_idx=NEW_INDEX', 'ref_msg_idx=OLD_INDEX'] },
          msg_elements: [{ msg_idx: 'OLD_INDEX', content: '', attachments: [{ content_type: 'image/png', url: 'https://example.com/quoted.png' }] }]
        } }));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  class LocalSDK extends QQBot { constructor(options) { super({ ...options, baseUrl: base, tokenBaseUrl: base }); } }
  t.after(async () => {
    client?.close(); for (const socket of wss.clients) socket.terminate(); wss.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  client = new QQBotClient({ getOptions: () => ({ appId: '123', clientSecret: 'LOCAL_SECRET' }),
    dataDir: dir, Bot: LocalSDK, allow: () => true,
    onEvent: event => { events.push(event); if (events.length === 4) incomingResolve(events[0]); }, log() {} });
  await client.connect();
  const event = await incoming; assert.equal(event.user_id, 'USER_SDK');
  const result = await client.sendText('private', 'USER_SDK', 'reply 1');
  await client.sendText('private', 'USER_SDK', 'reply 2');
  assert.equal(result.message_id, 'SDK_REPLY_ID');
  assert.deepEqual(requests.find(r => r.url === '/app/getAppAccessToken').body, { appId: '123', clientSecret: 'LOCAL_SECRET' });
  const sends = requests.filter(r => r.url === '/v2/users/USER_SDK/messages');
  assert.equal(sends.length, 2); assert.equal(sends[0].auth, 'QQBot FAKE_TOKEN');
  assert.equal(sends[0].body.msg_id, 'SDK_INBOUND_ID');
  // SDK 1.0.4 generates protocol-range sequence numbers, not a monotonic counter.
  assert.ok(sends.every(r => Number.isInteger(r.body.msg_seq) && r.body.msg_seq >= 0 && r.body.msg_seq <= 65535));
  assert.equal(events[1].group_id, 'GROUP_SDK'); assert.equal(events[1].officialAtMe, true);
  assert.equal(events[2].group_id, 'GROUP_SDK'); assert.equal(events[2].officialAtMe, true);
  assert.equal(events[3].officialReply.refKey, 'OLD_INDEX');
  assert.equal(events[3].officialReply.media[0].url, 'https://example.com/quoted.png');
  assert.equal(events[3].officialReply.text, '[图片]');
  const image = await client.sendImage('group', 'GROUP_SDK', 'base64://aGVsbG8=');
  assert.equal(image.message_id, 'SDK_REPLY_ID');
  assert.equal(requests.find(r => r.url === '/v2/groups/GROUP_SDK/files').body.file_type, 1);
  const media = requests.find(r => r.url === '/v2/groups/GROUP_SDK/messages');
  assert.equal(media.body.msg_id, 'SDK_QUOTED_IMAGE_QUESTION'); assert.equal(media.body.media.file_info, 'FIXTURE_MEDIA');
  // The earlier trigger must win over the most recent message, in the real
  // SDK's wire body too: message_reference alone does not set passive msg_id.
  await client.sendText('group', 'GROUP_SDK', 'earlier answer', { replyToMessageId: 'SDK_GROUP_ID' });
  const quoted = requests.filter(r => r.url === '/v2/groups/GROUP_SDK/messages').at(-1);
  assert.equal(quoted.body.msg_id, 'SDK_GROUP_ID');
  assert.equal(quoted.body.message_reference.message_id, 'SDK_GROUP_ID');
  await client.withReplyContext('group:GROUP_SDK', [{ mid: 'SDK_GROUP_ID', senderId: 'USER_SDK' }], async () => {
    await client.sendText('group', 'GROUP_SDK', 'unquoted earlier answer');
    await client.sendImage('group', 'GROUP_SDK', 'base64://aGVsbG8=');
  });
  const tail = requests.filter(r => r.url === '/v2/groups/GROUP_SDK/messages').slice(-2);
  assert.ok(tail.every(r => r.body.msg_id === 'SDK_GROUP_ID'));
});
