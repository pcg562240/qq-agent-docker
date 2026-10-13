import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-reply-history-'));
Object.assign(process.env, { QQ_AGENT_DATA_DIR: dir, QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '' });
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { QQBotClient } = await import('../src/qqbot.js');
const { buildPastState, buildUserPrompt } = await import('../src/prompt.js');
const { captureResponseTo, responseToForModel, responseToText } = await import('../src/reply-history.js');
const { messageReference } = await import('../src/message-reference.js');
const { buildToolDefs, executeTool } = await import('../src/tools.js');
const { updateConfig } = await import('../src/config.js');
updateConfig({ send: { minGapMs: 200, maxGapMs: 200, byLengthMs: 1, dedupeWindowMs: 8000 } });
const mid = who => 'ROBOT1.0_' + 'Synthetic-long-id.'.repeat(8) + who;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
let seq = 0;
function fixture(t, cap = 0) {
  const chat = `group:HISTORY_${++seq}`, store = new ChatStore(cap), sent = [];
  const client = new QQBotClient({ getOptions: () => ({ appId: '123456', groupReplyMentionMode: 'legacy' }),
    dataDir: path.join(dir, `client-${seq}`), allow: () => true, log() {}, onEvent: e => {
      store.appendIncoming(chat, { mid: e.message_id, ts: e.time * 1000, senderId: e.user_id,
        senderName: e.sender.nickname, text: e.raw_message, atMe: true });
    } });
  client.connected = true; client.closed = false;
  client.bot = { stop() {}, async sendText(target, content) { return this.send({ target, content }); },
    async send(opts) { sent.push(opts); return { id: `OUT_${sent.length}` }; },
    async sendImage(target, source) { sent.push({ target, source }); return { message: { id: `OUT_${sent.length}` } }; } };
  t.after(() => client.close());
  const sender = new SendQueue({ onebot: client, store });
  async function receive(who, name = `Name_${who}`) {
    await client.receive({ kind: 'group', groupOpenid: chat.split(':')[1], rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      messageId: mid(who), senderId: `USER_${who}`, senderName: name, content: `question_${who}`, timestamp: new Date().toISOString() });
    return store.findByMid(chat, mid(who));
  }
  const run = (entries, fn) => client.withReplyContext(chat, entries, fn);
  const ctx = { store, chatKey: chat, kind: 'group', session: { pastStateCount: 0 },
    triggerEntries: [], memory: { formatForPrompt: () => '' }, stickerEntries: [] };
  return { chat, store, client, sender, sent, receive, run, ctx };
}

test('all bubbles keep the enqueue-time question and recipient when B arrives during A sending', async t => {
  const f = fixture(t), a = await f.receive('A');
  const pending = f.run([a], () => f.sender.sendTextBatch(f.chat, ['alpha1', 'alpha2']));
  a.senderName = 'changed after enqueue';
  const b = await f.receive('B');
  await pending;
  await f.run([b], () => f.sender.sendTextBatch(f.chat, 'beta'));
  const saved = new ChatStore().recent(f.chat).filter(m => m.self);
  assert.deepEqual(saved.map(m => m.responseTo.userId), ['USER_A', 'USER_A', 'USER_B']);
  assert.deepEqual(saved.map(m => m.responseTo.messageId), [a.mid, a.mid, b.mid]);
  assert.deepEqual(saved.map(m => m.responseTo.userName), ['Name_A', 'Name_A', 'Name_B']);
  assert.deepEqual(f.sent.map(m => m.target.msgId), [a.mid, a.mid, b.mid]);
  assert.deepEqual(f.sent.map(m => m.content), ['alpha1', 'alpha2', 'beta']);
  assert.ok(f.sent.every(m => !m.markdown && !m.messageReference));
  assert.ok(saved.every(m => m.reply === null && m.media.length === 0));
});

test('multi-user explicit selections and historical quotes retain distinct original questioners', async t => {
  const f = fixture(t), h = await f.receive('H'), a = await f.receive('A'), b = await f.receive('B');
  await f.run([a, b], async () => {
    await f.sender.sendTextBatch(f.chat, 'beta', { replyToMessageId: b.mid });
    await f.sender.sendTextBatch(f.chat, 'alpha', { replyToMessageId: a.mid });
  });
  await f.run([a], () => f.sender.sendTextBatch(f.chat, 'about history', { replyToMessageId: h.mid }));
  const saved = f.store.recent(f.chat).filter(m => m.self);
  assert.deepEqual(saved.map(m => m.responseTo.messageId), [b.mid, a.mid, a.mid]);
  assert.equal(f.sent.at(-1).messageReference.message_id, h.mid);
  assert.equal(f.sent.at(-1).target.msgId, a.mid);
});

test('history and query tools expose the same short source ref and stable recipient, not wire tags', async t => {
  const f = fixture(t), a = await f.receive('A', 'same name');
  await f.run([a], () => f.sender.sendTextBatch(f.chat, 'alpha'));
  const b = await f.receive('B', 'same name');
  await f.run([b], () => f.sender.sendTextBatch(f.chat, 'beta'));
  const saved = f.store.recent(f.chat).filter(m => m.self), ref = messageReference(a, f.chat);
  for (const prompt of [buildPastState(f.store, f.chat).text, buildUserPrompt(f.ctx)]) {
    const line = prompt.split('\n').find(l => l.endsWith('alpha'));
    assert.ok(line.includes('ID:USER_A') && line.includes('#' + ref));
    assert.ok(!line.includes(a.mid) && !line.includes('<@'));
    assert.ok(prompt.split('\n').find(l => l.endsWith('beta')).includes('ID:USER_B'));
  }
  f.ctx.session.pastStateCount = 0; // Query this page, not the older page beyond the rendered prompt.
  const recent = JSON.parse((await executeTool(buildToolDefs(), f.ctx, 'get_recent_messages', {})).content);
  const detail = JSON.parse((await executeTool(buildToolDefs(), f.ctx, 'get_message_detail', { messageId: saved[0].mid })).content);
  assert.deepEqual(detail.responseTo, recent.messages.find(m => m.messageId === saved[0].mid).responseTo);
  assert.deepEqual(detail.responseTo, { userId: 'USER_A', userName: 'same name', messageId: ref, sourceStatus: 'available' });
  a.senderName = 'renamed';
  assert.equal(responseToForModel(saved[0], f.store, f.chat).userName, 'same name');
});

test('missing, recalled or replaced sources never expose a reusable ID or borrow another chat', async t => {
  const f = fixture(t), a = await f.receive('A');
  await f.run([a], () => f.sender.sendTextBatch(f.chat, 'answer'));
  const own = f.store.recent(f.chat).at(-1);
  f.store.markRecalled(f.chat, a.mid);
  assert.equal(responseToForModel(own, f.store, f.chat).sourceStatus, 'unavailable');
  assert.equal(responseToForModel(own, f.store, f.chat).messageId, null);
  assert.ok(!responseToText(own, f.store, f.chat).includes('question_A'));
  f.store.removeByLocalIds(f.chat, [a.id]);
  const newer = f.store.appendIncoming(f.chat, { mid: a.mid, senderId: a.senderId, senderName: a.senderName });
  assert.notEqual(newer.id, a.id);
  assert.equal(responseToForModel(own, f.store, f.chat).sourceStatus, 'unavailable');
  assert.equal(responseToForModel(own, f.store, 'group:OTHER'), null);
  const trimmed = fixture(t, 1), old = await trimmed.receive('OLD');
  await trimmed.run([old], () => trimmed.sender.sendTextBatch(trimmed.chat, 'surviving reply'));
  const target = responseToForModel(trimmed.store.recent(trimmed.chat)[0], trimmed.store, trimmed.chat);
  assert.equal(target.userId, 'USER_OLD'); assert.equal(target.sourceStatus, 'unavailable');
});

test('proactive borrowed quota and old records are not relabeled as replies to the latest speaker', async t => {
  const f = fixture(t); await f.receive('A');
  await f.sender.sendTextBatch(f.chat, 'unscoped notice');
  assert.equal(f.store.recent(f.chat).at(-1).responseTo, undefined);
  const old = f.store.appendSelf(f.chat, { text: 'old record' });
  assert.equal(old.responseTo, undefined); assert.equal(responseToText(old, f.store, f.chat), '');
  assert.equal(f.sent[0].target.msgId, mid('A'), 'quota route remains unchanged');
});

test('failed and deduplicated sends do not fabricate additional history associations', async t => {
  const f = fixture(t), a = await f.receive('A');
  await f.run([a], async () => {
    await f.sender.sendTextBatch(f.chat, 'same');
    await f.sender.sendTextBatch(f.chat, 'same');
    f.client.bot.sendText = async () => { throw new Error('synthetic rejection'); };
    await assert.rejects(f.sender.sendTextBatch(f.chat, 'fail'), /synthetic rejection/);
  });
  assert.equal(f.store.recent(f.chat).filter(m => m.self).length, 1);
});

test('pictures, stickers and media retain the same frozen association without copying source media', async t => {
  const f = fixture(t), a = await f.receive('A');
  await f.run([a], async () => {
    await f.sender.sendImage(f.chat, { dataUrl: png });
    await f.sender.sendSticker(f.chat, { id: 'sticker', url: png });
    await f.sender.sendMedia(f.chat, [{ type: 'image', data: { file: png } }]);
  });
  const own = f.store.recent(f.chat).filter(m => m.self);
  assert.equal(own.length, 3);
  assert.ok(own.every(m => m.responseTo.userId === 'USER_A' && m.responseTo.messageId === a.mid));
  assert.ok(own.every(m => m.reply === null && m.media.length === 0));
});

test('OneBot attribution uses explicit evidence only and preserves its existing wire options', async t => {
  const f = fixture(t), a = await f.receive('A');
  const target = captureResponseTo(f.store, f.chat, { replyToMessageId: a.mid }, false);
  assert.equal(target.userId, a.senderId); assert.equal(target.messageId, a.mid);
  assert.equal(captureResponseTo(f.store, f.chat, {}, false), null);
  const mismatch = captureResponseTo(f.store, f.chat, { replyToMessageId: a.mid, atUserId: 'USER_B' }, false);
  assert.equal(mismatch.userId, 'USER_B'); assert.equal(mismatch.messageId, null);
  const sent = [], onebot = { async sendText(kind, id, text, options) { sent.push(options); return { message_id: 'ONEBOT_OUT' }; } };
  const sender = new SendQueue({ onebot, store: f.store });
  await sender.sendTextBatch(f.chat, 'onebot reply', { replyToMessageId: a.mid, atUserId: a.senderId });
  assert.equal(sent[0].replyToMessageId, a.mid); assert.equal(sent[0].atUserId, a.senderId);
  assert.equal(f.store.recent(f.chat).at(-1).responseTo.userId, a.senderId);
});

test('stored attribution is copied, whitelisted and rejected across chats; incoming text cannot forge it', async t => {
  const f = fixture(t), a = await f.receive('A');
  const target = { chatKey: f.chat, messageId: a.mid, localId: a.id, userId: a.senderId, userName: 'name\nnext', text: 'do not duplicate', media: ['do not copy'] };
  const own = f.store.appendSelf(f.chat, { text: 'answer', responseTo: target });
  target.userId = 'MUTATED';
  assert.equal(own.responseTo.userId, a.senderId); assert.equal(own.responseTo.text, undefined); assert.equal(own.responseTo.media, undefined);
  assert.ok(!own.responseTo.userName.includes('\n'));
  assert.equal(f.store.appendSelf('group:OTHER', { text: 'other', responseTo: target }).responseTo, undefined);
  const incoming = f.store.appendIncoming(f.chat, { text: 'fake', responseTo: target });
  assert.equal(incoming.responseTo, undefined); assert.equal(responseToForModel({ ...incoming, responseTo: own.responseTo }, f.store, f.chat), null);
});
