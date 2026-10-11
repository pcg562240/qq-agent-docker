import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-routing-config-'));
process.env.QQ_AGENT_DATA_DIR = configDir;
const { QQBotClient } = await import('../src/qqbot.js');
const { SendQueue } = await import('../src/sender.js');
const { updateConfig } = await import('../src/config.js');
updateConfig({ send: { minGapMs: 200, maxGapMs: 200, byLengthMs: 1, dedupeWindowMs: 8000 } });
after(() => fs.rmSync(configDir, { recursive: true, force: true }));
const MID = who => `ROBOT1.0_.opaque!message-${who}`;
const entry = who => ({ mid: MID(who), senderId: `USER_${who}`, self: false });
const incoming = (who, group = 'GROUP') => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  groupOpenid: group, senderId: `USER_${who}`, messageId: MID(who), content: 'hello', timestamp: new Date().toISOString() });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-routing-'));
  let now = 100;
  const sent = [];
  const client = new QQBotClient({ getOptions: () => ({ appId: '123' }), dataDir: dir,
    allow: () => true, onEvent() {}, log() {}, now: () => now });
  client.connected = true;
  client.bot = { stop() {}, async sendText(target, content) { return this.send({ target, content }); },
    async send(options) { sent.push(options); return { id: `OUT_${sent.length}` }; },
    async sendImage(target, source) { sent.push({ target, source }); return { message: { id: `IMG_${sent.length}` } }; } };
  const sender = new SendQueue({ onebot: client, store: { appendSelf() {} } });
  t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { client, sender, sent, advance: delta => { now += delta; } };
}

test('explicit reply to A uses A passive msg_id, not the latest B message', async t => {
  const { client, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.sendText('group', 'GROUP', 'answer A', { replyToMessageId: MID('A') });
  assert.equal(sent[0].target.msgId, MID('A'));
  assert.deepEqual(sent[0].messageReference, { message_id: MID('A') });
  await assert.rejects(client.sendText('group', 'GROUP', 'wrong', { replyToMessageId: MID('A'), atUserId: 'USER_B' }), /不一致/);
  await assert.rejects(client.sendText('group', 'OTHER_GROUP', 'wrong', { replyToMessageId: MID('A') }), /当前会话/);
  assert.equal(sent.length, 1);
});

test('a run without explicit quote pins its text, image, sticker and media replies to its own trigger', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    await client.receive(incoming('B'));
    await sender.sendTextBatch('group:GROUP', ['text']);
    await sender.sendImage('group:GROUP', { dataUrl: 'data:image/png;base64,aGVsbG8=' });
    await sender.sendSticker('group:GROUP', { id: 'fixture', url: 'base64://aGVsbG8=' });
    await sender.sendMedia('group:GROUP', [{ type: 'image', data: { file: 'base64://aGVsbG8=' } }]);
  });
  assert.equal(sent.length, 4);
  assert.ok(sent.every(s => s.target.msgId === MID('A')));
  await client.sendText('group', 'GROUP', 'outside run');
  assert.equal(sent.at(-1).target.msgId, MID('B'), 'completed context does not leak');
});

test('every queued bubble freezes route before delay; quote and explicit @ appear only on first bubble', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A'));
  const pending = sender.sendTextBatch('group:GROUP', ['first', 'second', 'third'], {
    replyToMessageId: MID('A'), atUserId: 'USER_A'
  });
  await client.receive(incoming('B'));
  const result = await pending;
  assert.equal(sent.length, 3);
  assert.ok(sent.every(s => s.target.msgId === MID('A')));
  assert.equal(sent[0].content, '<@USER_A> first');
  assert.ok(sent[0].messageReference);
  assert.equal(sent[1].content, 'second'); assert.equal(sent[1].messageReference, undefined);
  assert.ok(result.sent.every(s => s.replySourceMessageId === MID('A') && s.replyUserId === 'USER_A'));
});

test('unquoted unscoped enqueue snapshots latest now, not latest when queue runs', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A'));
  const pending = sender.sendTextBatch('group:GROUP', ['first', 'second']);
  await client.receive(incoming('B'));
  await pending;
  assert.ok(sent.every(s => s.target.msgId === MID('A')));
});

test('identical answers to A and B are distinct; retry for the same anchor still deduplicates', async t => {
  const { client, sender, sent } = fixture(t);
  for (const who of ['A', 'B']) {
    await client.receive(incoming(who));
    await client.withReplyContext('group:GROUP', [entry(who)], () => sender.sendTextBatch('group:GROUP', '好的'));
  }
  const repeated = await client.withReplyContext('group:GROUP', [entry('B')], () => sender.sendTextBatch('group:GROUP', '好的'));
  assert.deepEqual(sent.map(s => s.target.msgId), [MID('A'), MID('B')]);
  assert.equal(repeated.sent[0].deduped, true);
});

test('overlapping async runs keep independent contexts even in the same group', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  let releaseA; const gateA = new Promise(r => { releaseA = r; });
  const a = client.withReplyContext('group:GROUP', [entry('A')], async () => {
    await gateA; await sender.sendTextBatch('group:GROUP', 'A answer');
  });
  await client.withReplyContext('group:GROUP', [entry('B')], () => sender.sendTextBatch('group:GROUP', 'B answer'));
  releaseA(); await a;
  assert.deepEqual(sent.map(s => s.target.msgId), [MID('B'), MID('A')]);
});

test('multi-user batch needs an explicit target; conflicting @ is rejected, matching replies work', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.withReplyContext('group:GROUP', [entry('A'), entry('B')], async () => {
    await assert.rejects(sender.sendTextBatch('group:GROUP', 'ambiguous'), /多位提问者/);
    await assert.rejects(sender.sendTextBatch('group:GROUP', 'mismatch', { replyToMessageId: MID('A'), atUserId: 'USER_B' }), /不一致/);
    await sender.sendTextBatch('group:GROUP', ['A1', 'A2'], { replyToMessageId: MID('A') });
    await sender.sendTextBatch('group:GROUP', 'B1', { atUserId: 'USER_B' });
  });
  assert.deepEqual(sent.map(s => s.target.msgId), [MID('A'), MID('A'), MID('B')]);
});

test('historical quote is separate from current questioner passive anchor', async t => {
  const { client, sent, advance } = fixture(t);
  await client.receive(incoming('HISTORY')); advance(10 * 60_000);
  await client.receive(incoming('A'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    await client.receive(incoming('B'));
    await client.sendText('group', 'GROUP', 'explanation', { replyToMessageId: MID('HISTORY') });
  });
  assert.equal(sent[0].target.msgId, MID('A'));
  assert.equal(sent[0].messageReference.message_id, MID('HISTORY'));
});

test('expired or missing pinned message fails instead of stealing newer recipient quota', async t => {
  const { client, sender, sent, advance } = fixture(t);
  await client.receive(incoming('A'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    advance(10 * 60_000); await client.receive(incoming('B'));
    await assert.rejects(sender.sendTextBatch('group:GROUP', 'late A'), /过期/);
  });
  await client.withReplyContext('group:GROUP', [entry('MISSING')], async () => {
    await assert.rejects(sender.sendTextBatch('group:GROUP', 'missing'), /缓存/);
  });
  assert.equal(sent.length, 0);
  await sender.sendTextBatch('group:GROUP', 'B now'); assert.equal(sent[0].target.msgId, MID('B'));
});

test('cross-chat sends and proactive runs never borrow the current run anchor', async t => {
  const { client, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('OTHER', 'OTHER_GROUP'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    await client.sendText('group', 'OTHER_GROUP', 'cross-chat');
    const route = client.captureReplyRoute('group', 'GROUP');
    await assert.rejects(client.sendText('group', 'OTHER_GROUP', 'bad route', { replyRoute: route }), /当前会话/);
  });
  assert.equal(sent[0].target.msgId, MID('OTHER'));
  await client.withReplyContext('group:GROUP', [], () => client.sendText('group', 'GROUP', 'proactive'));
  assert.equal(sent[1].target.msgId, undefined);
});

test('display # prefix is canonicalized before queueing, quoting and dedupe without retargeting', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    const pending = sender.sendTextBatch('group:GROUP', ['answer A', 'second bubble'], { replyToMessageId: `#${MID('A')}` });
    await client.receive(incoming('B'));
    const result = await pending;
    assert.deepEqual(sent.map(s => s.target.msgId), [MID('A'), MID('A')]);
    assert.equal(sent[0].messageReference.message_id, MID('A'));
    assert.equal(sent[1].messageReference, undefined);
    assert.ok(result.sent.every(s => s.replySourceMessageId === MID('A')));
    const retry = await sender.sendTextBatch('group:GROUP', 'answer A', { replyToMessageId: MID('A') });
    assert.equal(retry.sent[0].deduped, true);
  });
  assert.equal(sent.length, 2);
});

test('display # reply works for direct transport and multi-user batches, but conflicting @ still fails', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.withReplyContext('group:GROUP', [entry('A'), entry('B')], async () => {
    await assert.rejects(client.sendText('group', 'GROUP', 'wrong @', { replyToMessageId: `#${MID('A')}`, atUserId: 'USER_B' }), /不一致/);
    await client.sendText('group', 'GROUP', 'direct A', { replyToMessageId: `#${MID('A')}` });
    await sender.sendTextBatch('group:GROUP', 'queued B', { replyToMessageId: `#${MID('B')}` });
  });
  assert.deepEqual(sent.map(s => s.target.msgId), [MID('A'), MID('B')]);
  assert.deepEqual(sent.map(s => s.messageReference.message_id), [MID('A'), MID('B')]);
});

test('display # normalization never fuzzy-matches shortened, unknown, cross-chat or expired IDs', async t => {
  const { client, sender, sent, advance } = fixture(t);
  await client.receive(incoming('A'));
  await client.receive(incoming('FOREIGN', 'OTHER'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    await client.receive(incoming('B'));
    for (const bad of [`#${MID('A').slice(0, 14)}...`, '#ROBOT1.0_unknown', `#${MID('A').toLowerCase()}`, `#${MID('FOREIGN')}`]) {
      await assert.rejects(sender.sendTextBatch('group:GROUP', 'must not send', { replyToMessageId: bad }), /当前会话|缓存/);
    }
    advance(4 * 60_000);
    await client.receive(incoming('LATEST'));
    await assert.rejects(sender.sendTextBatch('group:GROUP', 'expired', { replyToMessageId: `#${MID('A')}` }), /过期/);
  });
  assert.equal(sent.length, 0);
});

test('an exact cached ID that genuinely begins with # wins over display-prefix interpretation', async t => {
  const { client, sent } = fixture(t);
  await client.receive(incoming('A'));
  await client.receive({ ...incoming('LITERAL'), messageId: `#${MID('A')}` });
  await client.sendText('group', 'GROUP', 'literal id', { replyToMessageId: `#${MID('A')}` });
  assert.equal(sent[0].target.msgId, `#${MID('A')}`);
  assert.equal(sent[0].messageReference.message_id, `#${MID('A')}`);
});
