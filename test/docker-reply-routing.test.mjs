import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-routing-config-'));
process.env.QQ_AGENT_DATA_DIR = configDir;
const { QQBotClient } = await import('../src/qqbot.js');
const { SendQueue } = await import('../src/sender.js');
const { updateConfig } = await import('../src/config.js');
updateConfig({ send: { minGapMs: 200, maxGapMs: 200, byLengthMs: 1, dedupeWindowMs: 8000 } });
after(() => fs.rmSync(configDir, { recursive: true, force: true }));
const AT = who => `<qqbot-at-user id="USER_${who}" /> `;
const MID = who => `ROBOT1.0_.opaque!message-${who}`;
const entry = who => ({ mid: MID(who), senderId: `USER_${who}`, self: false });
const incoming = (who, group = 'GROUP') => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  groupOpenid: group, senderId: `USER_${who}`, messageId: MID(who), content: 'hello', timestamp: new Date().toISOString() });
const wireText = sent => sent.markdown?.content ?? sent.content;
function fixture(t, mode = 'markdown') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-routing-'));
  let now = 100;
  const sent = [];
  const client = new QQBotClient({ getOptions: () => ({ appId: '123', groupReplyMentionMode: mode }), dataDir: dir,
    allow: () => true, onEvent() {}, log() {}, now: () => now });
  client.connected = true;
  client.bot = { stop() {}, async sendText(target, content) { return this.send({ target, content }); },
    async send(options) { sent.push(options); return { id: `OUT_${sent.length}` }; },
    async sendImage(target, source) { sent.push({ target, source }); return { message: { id: `IMG_${sent.length}` } }; } };
  const sender = new SendQueue({ onebot: client, store: { appendSelf() {} } });
  t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { client, sender, sent, advance: delta => { now += delta; } };
}

test('legacy compatibility removes raw prefixes before sending/history, keeps quote and A binding', async t => {
  const { client, sender, sent } = fixture(t, 'legacy');
  await client.receive(incoming('A'));
  const pending = client.withReplyContext('group:GROUP', [entry('A')], () =>
    sender.sendTextBatch('group:GROUP', ['<@!USER_A> first', 'second'], { atUserId: 'USER_A', replyToMessageId: `#${MID('A')}` }));
  await client.receive(incoming('B'));
  const result = await pending;
  assert.deepEqual(sent.map(wireText), ['first', 'second']);
  assert.ok(sent.every(s => s.target.msgId === MID('A') && s.markdown === undefined));
  assert.equal(sent[0].messageReference.message_id, MID('A'));
  assert.equal(sent[1].messageReference, undefined);
  assert.deepEqual(result.sent.map(s => s.text), ['first', 'second']);
  assert.ok(result.sent.every(s => s.replySourceMessageId === MID('A') && s.replyUserId === 'USER_A'));
  assert.equal(client.status().groupReplyMentionMode, 'legacy');
});

test('legacy reported regression: explicit at and quote never inject an OpenID into clean text', async t => {
  const { client, sender, sent } = fixture(t, 'legacy');
  const history = []; sender.store.appendSelf = (_key, row) => history.push(row.text);
  await client.receive(incoming('A'));
  const pending = client.withReplyContext('group:GROUP', [entry('A')], () =>
    sender.sendTextBatch('group:GROUP', ['synthetic avatar reply'], { atUserId: 'USER_A', replyToMessageId: MID('A') }));
  await client.receive(incoming('B')); await pending;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'synthetic avatar reply');
  assert.equal(sent[0].messageReference.message_id, MID('A'));
  assert.equal(sent[0].target.msgId, MID('A'));
  assert.equal(sent[0].markdown, undefined); assert.notEqual(sent[0].msgType, 2);
  assert.deepEqual(history, ['synthetic avatar reply']);
});

test('legacy compatibility validates duplicate leading tags against pinned member, not group or newer speaker', async t => {
  const { client, sender, sent } = fixture(t, 'legacy');
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    await sender.sendTextBatch('group:GROUP', ['<@USER_A> <qqbot-at-user id="USER_A" /> first', '<@!USER_A> second']);
    for (const body of ['<@USER_B> wrong', '<@GROUP> wrong', '<qqbot-at-user id="UNKNOWN" /> wrong']) {
      await assert.rejects(sender.sendTextBatch('group:GROUP', [body]), /已绑定回复目标不一致/);
    }
    await assert.rejects(sender.sendTextBatch('group:GROUP', ['<@USER_A> ']), /消息内容为空/);
  });
  assert.deepEqual(sent.map(wireText), ['first', 'second']);
  assert.ok(sent.every(s => s.target.msgId === MID('A') && s.markdown === undefined));
});

test('legacy rollback uses historical helper without automatic mention when atUserId is absent', async t => {
  const { client, sender, sent } = fixture(t, 'legacy');
  let helperCalls = 0;
  const helper = client.bot.sendText.bind(client.bot);
  client.bot.sendText = (...args) => { helperCalls++; return helper(...args); };
  await client.receive(incoming('A'));
  await client.withReplyContext('group:GROUP', [entry('A')], () => sender.sendTextBatch('group:GROUP', ['first', 'second']));
  assert.deepEqual(sent.map(wireText), ['first', 'second']); assert.equal(helperCalls, 2);
  assert.ok(sent.every(s => s.target.msgId === MID('A') && s.markdown === undefined));
  await client.withReplyContext('group:GROUP', [], () => client.sendText('group', 'GROUP', 'proactive'));
  assert.equal(sent[2].target.msgId, undefined);
  await client.sendText('private', 'USER_A', '<@USER_A> literal');
  assert.equal(sent[3].content, '<@USER_A> literal');
});

test('legacy rollback retains ambiguity, conflict, cross-chat and expiry checks', async t => {
  const { client, sent, advance } = fixture(t, 'legacy');
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.withReplyContext('group:GROUP', [entry('A'), entry('B')], async () => {
    await assert.rejects(client.sendText('group', 'GROUP', 'ambiguous'), /多位提问者/);
    await assert.rejects(client.sendText('group', 'GROUP', 'wrong', { atUserId: 'USER_B', replyToMessageId: MID('A') }), /不一致/);
  });
  await assert.rejects(client.sendText('group', 'OTHER_GROUP', 'wrong group', { replyToMessageId: MID('A') }), /当前会话/);
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    advance(5 * 60_000); await client.receive(incoming('B'));
    await assert.rejects(client.sendText('group', 'GROUP', 'expired', { atUserId: 'USER_A' }), /过期/);
  });
  assert.deepEqual(sent, []);
});

test('legacy rollback never tries Markdown or retries a rejected plain message', async t => {
  const { client } = fixture(t, 'legacy');
  await client.receive(incoming('A'));
  const failure = new ApiError('fixture denial', 403, '/v2/groups/GROUP/messages', 304036);
  let calls = 0;
  client.bot.send = async options => { calls++; assert.equal(options.markdown, undefined); throw failure; };
  await assert.rejects(client.sendText('group', 'GROUP', 'answer', { atUserId: 'USER_A' }), e => e === failure);
  assert.equal(calls, 1); assert.equal(client.mentionMarkdownDisabled.size, 0);
});

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

test('every queued bubble freezes route before delay; native @ uses the same recipient only on the first bubble', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A'));
  const pending = sender.sendTextBatch('group:GROUP', ['first', 'second', 'third'], {
    replyToMessageId: MID('A'), atUserId: 'USER_A'
  });
  await client.receive(incoming('B'));
  const result = await pending;
  assert.equal(sent.length, 3);
  assert.ok(sent.every(s => s.target.msgId === MID('A')));
  assert.equal(wireText(sent[0]), AT('A') + 'first');
  assert.ok(sent[0].messageReference);
  assert.equal(wireText(sent[1]), 'second'); assert.equal(sent[1].messageReference, undefined);
  assert.ok(result.sent.every(s => s.replySourceMessageId === MID('A') && s.replyUserId === 'USER_A'));
});

test('atUserId alone selects a matching anchor and emits current QQ native mention syntax', async t => {
  const { client, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.sendText('group', 'GROUP', 'reply to A', { atUserId: 'USER_A' });
  assert.equal(sent[0].target.msgId, MID('A'));
  assert.equal(wireText(sent[0]), AT('A') + 'reply to A');
  assert.equal(sent[0].messageReference, undefined);
});

test('redundant model-written leading tags are removed before queue, dedupe and history', async t => {
  const { client, sender, sent } = fixture(t);
  const history = [];
  sender.store.appendSelf = (_chat, message) => history.push(message.text);
  await client.receive(incoming('A'));
  const options = { replyToMessageId: MID('A'), atUserId: 'USER_A' };
  const pending = sender.sendTextBatch('group:GROUP', ['<@USER_A> first', '<@!USER_A> second'], options);
  await client.receive(incoming('B'));
  const result = await pending;
  assert.deepEqual(sent.map(wireText), [AT('A') + 'first', 'second']);
  assert.ok(sent.every(s => s.target.msgId === MID('A')));
  assert.deepEqual(result.sent.map(s => s.text), ['first', 'second']);
  assert.deepEqual(history, ['first', 'second']);
  const repeated = await sender.sendTextBatch('group:GROUP', 'first', options);
  assert.equal(repeated.sent[0].deduped, true);
  assert.equal(sent.length, 2);
});

test('body tags never redirect a pinned recipient or create a proactive target', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    for (const prefix of ['<@USER_B>', '<@!UNKNOWN>', '<@USER_A> <@USER_B>']) {
      await assert.rejects(sender.sendTextBatch('group:GROUP', `${prefix} wrong`), /正文.*@.*回复目标/);
    }
    await assert.rejects(client.sendText('group', 'GROUP', '<@USER_B> direct wrong'), /正文.*@.*回复目标/);
    await assert.rejects(sender.sendTextBatch('group:GROUP', '<@USER_A>'), /消息内容为空/);
    await client.sendText('group', 'GROUP', '<@!USER_A> <@USER_A> direct ok');
  });
  await client.withReplyContext('group:GROUP', [], async () => {
    await assert.rejects(client.sendText('group', 'GROUP', '<@USER_A> proactive'), /正文.*@.*回复目标/);
  });
  assert.deepEqual(sent.map(wireText), [AT('A') + 'direct ok']);
  assert.equal(sent[0].target.msgId, MID('A'));
});

test('private text, inline explanations and ordinary nickname text remain intact', async t => {
  const { client, sent } = fixture(t);
  await client.receive(incoming('A'));
  await client.sendText('private', 'USER_A', '<@USER_A> literal example');
  await client.sendText('group', 'GROUP', '格式例子 <@USER_A> 不是真正的 @');
  await client.sendText('group', 'GROUP', '@阿白 你好');
  assert.deepEqual(sent.map(wireText), ['<@USER_A> literal example', '格式例子 <@USER_A> 不是真正的 @', '@阿白 你好']);
});

test('OneBot still emits its native at and reply segments', async () => {
  const { OneBotClient } = await import('../src/onebot.js');
  const onebot = Object.create(OneBotClient.prototype);
  const sent = [];
  onebot.sendSegments = async (kind, id, segments) => { sent.push({ kind, id, segments }); return { message_id: 'OUT' }; };
  const sender = new SendQueue({ onebot, store: { appendSelf() {} } });
  await sender.sendTextBatch('group:123', 'hello', { atUserId: '456', replyToMessageId: '-789' });
  assert.deepEqual(sent[0].segments, [
    { type: 'reply', data: { id: '-789' } }, { type: 'at', data: { qq: '456' } }, { type: 'text', data: { text: 'hello' } }
  ]);
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
  assert.deepEqual(sent.map(wireText), [AT('B') + 'B answer', AT('A') + 'A answer']);
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
  assert.equal(wireText(sent[0]), AT('A') + 'explanation');
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


test('implicit trigger reply gets one native mention; proactive and cross-chat fallback do not ping', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    await sender.sendTextBatch('group:GROUP', ['answer', 'continuation']);
    await client.receive(incoming('OTHER', 'OTHER_GROUP'));
    await client.sendText('group', 'OTHER_GROUP', 'scheduled cross-chat');
  });
  await client.withReplyContext('group:GROUP', [], () => sender.sendTextBatch('group:GROUP', 'proactive'));
  await client.sendText('group', 'GROUP', 'unscoped');
  assert.deepEqual(sent.map(wireText), [AT('A') + 'answer', 'continuation', 'scheduled cross-chat', 'proactive', 'unscoped']);
  assert.deepEqual(sent.slice(0, 2).map(s => s.target.msgId), [MID('A'), MID('A')]);
});

test('model native prefixes normalize once, and cannot substitute group IDs or another user', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A')); await client.receive(incoming('B'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    for (const id of ['USER_B', 'GROUP']) {
      await assert.rejects(sender.sendTextBatch('group:GROUP', `<qqbot-at-user id="${id}" /> wrong`), /正文.*@.*回复目标/);
    }
    await assert.rejects(sender.sendTextBatch('group:GROUP', AT('A')), /消息内容为空/);
    await sender.sendTextBatch('group:GROUP', [`${AT('A')}<@USER_A> hello`, `<qqbot-at-user id='USER_A'/> next`]);
  });
  assert.deepEqual(sent.map(wireText), [AT('A') + 'hello', 'next']);
  assert.equal(sent[0].target.targetId, 'GROUP');
  assert.equal(sent[0].target.msgId, MID('A'));
});


test('default/off group replies never inject mention markup into msg_type=0', async t => {
  const { client, sender, sent } = fixture(t, undefined);
  client.getOptions = () => ({ appId: '123' });
  await client.receive(incoming('A'));
  await client.withReplyContext('group:GROUP', [entry('A')], () => sender.sendTextBatch('group:GROUP', [AT('A') + 'first', 'next']));
  assert.deepEqual(sent.map(wireText), ['first', 'next']);
  assert.ok(sent.every(s => s.msgType === 0 && !s.markdown && s.target.msgId === MID('A')));
});

test('turning Markdown off restores plain replies without losing pinned target or quote', async t => {
  const { client, sender, sent } = fixture(t);
  let mode = 'markdown';
  client.getOptions = () => ({ appId: '123', groupReplyMentionMode: mode });
  await client.receive(incoming('A'));
  await client.withReplyContext('group:GROUP', [entry('A')], async () => {
    await sender.sendTextBatch('group:GROUP', 'before');
    const options = { replyToMessageId: MID('A') };
    options.replyRoute = client.captureReplyRoute('group', 'GROUP', options);
    await client.receive(incoming('B'));
    mode = 'off';
    await sender.sendTextBatch('group:GROUP', [AT('A') + 'plain first', 'plain next'], options);
  });
  assert.equal(sent[0].msgType, 2);
  assert.deepEqual(sent.slice(1).map(wireText), ['plain first', 'plain next']);
  assert.ok(sent.slice(1).every(s => s.msgType === 0 && s.markdown === undefined));
  assert.ok(sent.every(s => s.target.msgId === MID('A')));
  assert.deepEqual(sent[1].messageReference, { message_id: MID('A') });
  assert.equal(client.status().groupReplyMentionMode, 'off');
});

test('Markdown mention occupies only markdown.content; private text behavior is untouched', async t => {
  const { client, sender, sent } = fixture(t);
  await client.receive(incoming('A'));
  await sender.sendTextBatch('group:GROUP', ['first <qqbot-at-user id="USER_B" />', 'next'], { atUserId: 'USER_A' });
  assert.equal(sent[0].msgType, 2); assert.equal(sent[0].content, undefined);
  assert.equal(sent[0].markdown.content, AT('A') + 'first &lt;qqbot-at-user id="USER_B" /&gt;');
  assert.equal(sent[1].msgType, 0); assert.equal(sent[1].markdown, undefined);
  await client.sendText('private', 'USER_A', 'private');
  assert.equal(sent.at(-1).content, 'private'); assert.equal(sent.at(-1).markdown, undefined);
});

test('explicit Markdown permission rejection falls back once without tags, route drift or repeat attempts', async t => {
  const { client, sent } = fixture(t);
  await client.receive(incoming('A'));
  const attempts = [], logs = [];
  client.log = (...args) => logs.push(args.join(' '));
  const send = client.bot.send.bind(client.bot);
  client.bot.send = async options => {
    attempts.push(options);
    if (options.markdown) {
      await client.receive(incoming('B'));
      throw new ApiError('denied', 403, '/v2/groups/GROUP/messages', 304036, 'No Markdown permission');
    }
    return send(options);
  };
  await client.sendText('group', 'GROUP', 'A first', { atUserId: 'USER_A', replyToMessageId: MID('A') });
  await client.sendText('group', 'GROUP', 'A second', { atUserId: 'USER_A' });
  assert.equal(attempts.length, 3); assert.equal(attempts.filter(s => s.markdown).length, 1);
  assert.ok(attempts.every(s => s.target.msgId === MID('A')));
  assert.deepEqual(sent.map(wireText), ['A first', 'A second']);
  assert.deepEqual(sent[0].messageReference, { message_id: MID('A') });
  assert.equal(logs.length, 1); assert.match(logs[0], /304036/); assert.doesNotMatch(logs[0], /A first|USER_A/);
});

test('ambiguous sends and unrelated rejections never retry as plain text', async t => {
  const { client } = fixture(t);
  await client.receive(incoming('A'));
  for (const error of [new ApiError('timeout', 0, '/v2/groups/GROUP/messages'),
    new ApiError('server error', 500, '/v2/groups/GROUP/messages', 304036),
    new ApiError('rate limit', 429, '/v2/groups/GROUP/messages', 40034100),
    new ApiError('expired', 400, '/v2/groups/GROUP/messages', 304103), new Error('304036 not structured')]) {
    let attempts = 0;
    client.bot.send = async () => { attempts++; throw error; };
    await assert.rejects(client.sendText('group', 'GROUP', 'answer', { atUserId: 'USER_A' }), e => e === error);
    assert.equal(attempts, 1); assert.equal(client.mentionMarkdownDisabled.size, 0);
  }
});
