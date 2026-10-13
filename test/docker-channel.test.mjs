import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBotClient, normalizeQQMessage } from '../src/qqbot.js';
import { dockerEnvironment } from '../src/docker-env.js';
import { consoleAuthorized, tokenEqual } from '../src/console-auth.js';

class FakeBot {
  constructor(options) { this.options = options; this.events = new Map(); this.sent = []; }
  on(name, fn) { this.events.set(name, fn); }
  start() { this.events.get('ready')?.({ user: { id: 'BOT', username: 'test' } }); return new Promise(r => { this.finish = r; }); }
  stop() { this.finish?.(); }
  async sendText(target, content) { this.sent.push({ target, content }); return { id: 'OUT_message-1' }; }
  async send(options) { this.sent.push(options); return { id: 'OUT_quote-1' }; }
  async sendImage(target, source) { this.sent.push({ target, source }); return { message: { id: 'OUT_image-1' } }; }
}
const incoming = overrides => ({ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'USER_AB-cd',
  messageId: 'message_ID-abc', content: 'hello', timestamp: new Date().toISOString(), ...overrides });
async function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-channel-test-'));
  let options = { appId: '123456', clientSecret: 'SECRET_TEST_ONLY', requireMention: true };
  const events = [];
  const client = new QQBotClient({ getOptions: () => options, dataDir: dir,
    Bot: FakeBot, allow: () => true, onEvent: event => events.push(event), log() {}, ...overrides });
  t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); await new Promise(r => setImmediate(r));
  return { client, events, dir, options, setOptions: x => { options = x; } };
}

test('QQ C2C OpenIDs and message IDs remain opaque strings', () => {
  const e = normalizeQQMessage(incoming({ attachments: [{ content_type: 'image/png', url: 'https://example.com/image.png' }] }));
  assert.equal(e.user_id, 'USER_AB-cd'); assert.equal(e.message_id, 'message_ID-abc');
  assert.equal(e.message[1].type, 'image'); assert.equal(e.message_type, 'private');
});
test('group @event is authoritative; guild messages are outside MVP', () => {
  const e = normalizeQQMessage(incoming({ kind: 'group', groupOpenid: 'GROUP_X-y', rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: '<@!BOT> hello' }));
  assert.equal(e.officialAtMe, true); assert.equal(e.raw_message, 'hello');
  assert.equal(normalizeQQMessage(incoming({ kind: 'guild' })), null);
  assert.throws(() => normalizeQQMessage(incoming({ senderId: '../../secret' })));
});
test('unconfigured channel does not start any SDK/network connection', async t => {
  const { client } = await fixture(t, { getOptions: () => ({}) });
  assert.equal(client.bot, null); assert.equal(client.status().configured, false);
});
test('ingress deduplicates and restores its dedup ledger after restart', async t => {
  const { client, events, dir, options } = await fixture(t);
  await client.receive(incoming()); await client.receive(incoming());
  assert.equal(events.length, 1);
  const restored = new QQBotClient({ getOptions: () => options, dataDir: dir, onEvent: () => assert.fail('replayed'), allow: () => true });
  await restored.receive(incoming()); restored.close();
});
test('failed ingress is retryable rather than incorrectly marked delivered', async t => {
  let calls = 0;
  const { client } = await fixture(t, { onEvent: () => { if (++calls === 1) throw new Error('temporary'); } });
  await assert.rejects(client.receive(incoming()), /temporary/);
  await client.receive(incoming()); assert.equal(calls, 2);
});
test('non-allowlisted peers are discoverable but body and send permission are denied', async t => {
  const { client, events, dir } = await fixture(t, { allow: () => false });
  await client.receive(incoming({ content: 'PRIVATE_BODY' }));
  assert.equal(events.length, 0); assert.equal(client.messages.size, 0);
  assert.equal(client.status().peers.length, 1);
  assert.ok(!fs.readFileSync(path.join(dir, 'qqbot', 'peers.json'), 'utf8').includes('PRIVATE_BODY'));
  await assert.rejects(client.sendText('private', 'USER_AB-cd', 'no'), /白名单/);
});
test('ordinary group reception ignores the retired mention filter without granting platform capabilities', async t => {
  const { client, events, options } = await fixture(t);
  const msg = incoming({ kind: 'group', groupOpenid: 'GROUP_X-y', rawEventType: 'GROUP_MESSAGE_CREATE' });
  await client.receive(msg); assert.equal(events.length, 1);
  assert.equal(events[0].officialAtMe, false);
  options.requireMention = false; await client.receive(msg); assert.equal(events.length, 1);
  await client.receive({ ...msg, messageId: 'NEXT' }); assert.equal(events.length, 2);
});
test('ingress diagnostics retain separate filtered, forwarded, duplicate, blocked and error results without bodies', async t => {
  let mode = 'forwarded';
  const { client, events } = await fixture(t, { onEvent: event => {
    if (mode === 'error') throw new Error('fixture error');
    events.push(event); return { ingress: mode };
  } });
  const base = { kind: 'group', groupOpenid: 'GROUP_X-y', content: 'PRIVATE_DIAGNOSTIC_BODY', senderId: 'PRIVATE_AUTHOR' };
  await client.receive(incoming({ ...base, rawEventType: 'GROUP_MESSAGE_CREATE', messageId: 'FILTERED' }));
  const mentioned = incoming({ ...base, rawEventType: 'GROUP_AT_MESSAGE_CREATE', messageId: 'MENTIONED' });
  await client.receive(mentioned); await client.receive(mentioned);
  mode = 'blocked_sender'; await client.receive({ ...mentioned, messageId: 'BLOCKED' });
  mode = 'error'; await assert.rejects(client.receive({ ...mentioned, messageId: 'ERROR' }));
  assert.deepEqual(client.ingress.list('group', 'GROUP_X-y').map(e => e.reason), ['error', 'blocked_sender', 'duplicate', 'forwarded', 'forwarded']);
  assert.doesNotMatch(JSON.stringify(client.ingress.entries), /PRIVATE_/);
});
test('ordinary group event with structured is_you mention enters the channel and preserves @ tier signal', async t => {
  const { client, events } = await fixture(t);
  await client.receive(incoming({kind:'group',groupOpenid:'GROUP_X-y',rawEventType:'GROUP_MESSAGE_CREATE',
    mentions:[{id:'BOT',is_you:true,bot:true}],content:'hello without inline mention'}));
  assert.equal(events.length,1); assert.equal(events[0].officialAtMe,true);
  assert.equal(client.status().peers[0].lastIngress,'forwarded');
});
test('inline mentions must match this bot; other bots and @all are not self mentions', async t => {
  const { client, events } = await fixture(t);
  const msg={kind:'group',groupOpenid:'GROUP_X-y',rawEventType:'GROUP_MESSAGE_CREATE'};
  for(const [i,body] of [
    {content:'<@!OTHER> hello',mentions:[{id:'OTHER',bot:true}]},
    {content:'@everyone hello',mentions:[{scope:'all'}]},
    {content:'<@!1234567> prefix collision'},
    {content:'hello',mentions:[{is_you:'true'}]},
    {content:'ordinary message'},
  ].entries()) await client.receive(incoming({...msg,...body,messageId:'NO-'+i}));
  assert.equal(events.length,5); assert.ok(events.every(e => e.officialAtMe === false));
  assert.equal(client.status().peers[0].lastIngress,'forwarded');
  for(const [i,content] of ['<@!BOT> hello','hello <@123456>','<@OTHER> <@!BOT> hello'].entries()) {
    await client.receive(incoming({...msg,content,messageId:'YES-'+i}));
    assert.equal(events.at(-1).officialAtMe,true);
  }
  assert.equal(events.length,8); assert.match(events[7].raw_message,/^<@OTHER>/,'do not strip a leading mention of someone else');
});
test('mention-only messages have a neutral trigger; diagnostics contain no body or secret', async t => {
  const { client, events, dir }=await fixture(t);
  await client.receive(incoming({kind:'group',groupOpenid:'GROUP_X-y',rawEventType:'GROUP_AT_MESSAGE_CREATE',content:'<@!BOT>   '}));
  assert.ok(events[0].message.some(s=>s.type==='text'&&s.data.text.trim()));
  await client.receive(incoming({kind:'group',groupOpenid:'GROUP_X-y',rawEventType:'GROUP_MESSAGE_CREATE',content:'PRIVATE_GROUP_BODY',messageId:'SKIP'}));
  const peer=client.status().peers.find(x=>x.kind==='group');assert.equal(peer.lastAtMe,false);assert.equal(peer.lastEventType,'GROUP_MESSAGE_CREATE');
  assert.ok(peer.lastSeenAt>0);assert.equal(peer.lastIngress,'forwarded');
  const persisted=fs.readFileSync(path.join(dir,'qqbot','peers.json'),'utf8');assert.ok(!persisted.includes('PRIVATE_GROUP_BODY'));assert.ok(!persisted.includes('SECRET_TEST_ONLY'));
});
test('text reply keeps passive anchor and distinguishes quote reference', async t => {
  const { client } = await fixture(t);
  await client.receive(incoming());
  const sent = await client.sendText('private', 'USER_AB-cd', 'reply');
  assert.equal(sent.message_id, 'OUT_message-1');
  assert.deepEqual(client.bot.sent[0].target, { scope: 'c2c', targetId: 'USER_AB-cd', msgId: 'message_ID-abc' });
  await client.sendText('private', 'USER_AB-cd', 'quote', { replyToMessageId: 'message_ID-abc' });
  assert.deepEqual(client.bot.sent[1].messageReference, { message_id: 'message_ID-abc' });
  await assert.rejects(client.sendText('private', 'ANOTHER', 'quote', { replyToMessageId: 'message_ID-abc' }), /当前会话/);
});
test('whale-memes media cache is allowed, but state, symlinks and other bot files stay blocked', async t => {
  const { client, dir } = await fixture(t);
  const cache=path.join(dir,'whale-memes','tmp'); fs.mkdirSync(cache,{recursive:true});
  const state=path.join(dir,'whale-memes','state.json'); fs.writeFileSync(state,'PRIVATE_STATE');
  const png=path.join(cache,'picture.png');fs.writeFileSync(png,'IMAGE_FIXTURE');
  assert.equal((await client.imageSource(png)).buffer.toString(),'IMAGE_FIXTURE');
  await assert.rejects(client.imageSource(state),/媒体目录/);
  fs.symlinkSync(state,path.join(cache,'alias.png'));
  await assert.rejects(client.imageSource(path.join(cache,'alias.png')),/媒体目录/);
  const other=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-other-bot-'));
  t.after(()=>fs.rmSync(other,{recursive:true,force:true}));
  fs.mkdirSync(path.join(other,'whale-memes','tmp'),{recursive:true});
  const otherImage=path.join(other,'whale-memes','tmp','other.png');fs.writeFileSync(otherImage,'OTHER_IMAGE');
  await assert.rejects(client.imageSource(otherImage),/媒体目录/);
  fs.symlinkSync(path.dirname(otherImage),path.join(cache,'other'));
  await assert.rejects(client.imageSource(path.join(cache,'other','other.png')),/媒体目录/);
});
test('expired reply anchor is not attached to proactive send', async t => {
  let now = 0;
  const { client } = await fixture(t, { now: () => now });
  await client.receive(incoming()); now = 10 * 60_000;
  await client.sendText('private', 'USER_AB-cd', 'reminder');
  assert.equal(client.bot.sent[0].target.msgId, undefined);
});
test('image path cannot read config/secrets and image messages retain string IDs', async t => {
  const { client, dir } = await fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), 'SECRET');
  fs.mkdirSync(path.join(dir, 'media'));
  fs.symlinkSync(path.join(dir, 'config.json'), path.join(dir, 'media', 'fake.png'));
  await assert.rejects(client.imageSource(path.join(dir, 'media', 'fake.png')), /媒体目录/);
  fs.mkdirSync(path.join(dir, 'sticker-images'));
  const sticker = path.join(dir, 'sticker-images', 'image-with-hyphen.png');
  fs.writeFileSync(sticker, 'TEST_IMAGE_BYTES');
  assert.equal((await client.imageSource(sticker)).buffer.toString(), 'TEST_IMAGE_BYTES');
  const result = await client.sendImage('private', 'USER_AB-cd', 'base64://aGVsbG8=');
  assert.equal(result.message_id, 'OUT_image-1');
});
test('unsupported mixed media fails before partially sending', async t => {
  const { client } = await fixture(t);
  await assert.rejects(client.sendSegments('private', 'USER_AB-cd', [
    { type: 'text', data: { text: 'hello' } }, { type: 'record', data: { file: 'secret' } },
  ]));
  assert.equal(client.bot.sent.length, 0);
});
test('changing AppID requires a new data volume; secrets are redacted', async t => {
  const { client, setOptions } = await fixture(t);
  assert.equal(client.redact('failed SECRET_TEST_ONLY'), 'failed [REDACTED]');
  setOptions({ appId: '999', clientSecret: 'DIFFERENT' });
  await client.reconnect(); assert.equal(client.connected, false);
  assert.match(client.lastConnectError, /数据卷/);
});
test('generation guard ignores events from an old connection', async t => {
  const { client, events } = await fixture(t);
  const old = client.bot; await client.reconnect(); await new Promise(r => setImmediate(r));
  await old.events.get('message')({}, incoming()); assert.equal(events.length, 0);
});
test('environment overlay is immutable and disables desktop startup', () => {
  const base = { server: { token: 'saved' }, qqbot: { appId: '1' }, snowluma: { autoLaunch: true } };
  const out = dockerEnvironment(base, { QQ_AGENT_DOCKER: '1', QQ_AGENT_CONSOLE_TOKEN: 'environment-secret', QQBOT_APP_SECRET: 'sdk-secret' });
  assert.equal(out.server.host, '0.0.0.0'); assert.equal(out.snowluma.autoLaunch, false);
  assert.equal(base.server.token, 'saved'); assert.equal(base.qqbot.clientSecret, undefined);
});
test('console authenticates correct cookie/header and rejects bad token', () => {
  const req = { url: '/api/config', headers: { cookie: 'other=1; qq_agent_console=secret' } };
  assert.ok(consoleAuthorized(req, 'secret'));
  assert.equal(consoleAuthorized(req, 'wrong'), false);
  assert.equal(tokenEqual('', ''), false);
});

test('QQ IP-whitelist diagnostic survives SDK retry exhaustion and clears on ready', async t => {
  const { client } = await fixture(t);
  client.setStatus(false, 'Connection failed: API Error [/gateway]: 接口访问源IP不在白名单');
  assert.match(client.status().hint, /公网出口 IP/);
  client.setStatus(false, 'Max reconnect attempts reached or aborted');
  assert.match(client.status().error, /接口访问源IP不在白名单/);
  client.setStatus(true);
  assert.equal(client.status().hint, ''); assert.equal(client.status().error, '');
});
