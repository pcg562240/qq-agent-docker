import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { qqMessageQuote } from '../src/qqbot-quotes.js';
import { resolveIncomingQuote, messageImageReferences, quoteForDetail } from '../src/message-quotes.js';
import { unsentReplyReminder } from '../src/reply-completion.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-quote-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.QQ_AGENT_PROFILES_ROOT = '';
process.env.QQ_AGENT_ACTIVE_ROBOT = '';
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { QQBotClient, normalizeQQMessage } = await import('../src/qqbot.js');
const { ChatStore } = await import('../src/store.js');
const { buildTriggerBlock, buildUserPrompt } = await import('../src/prompt.js');
const { buildToolDefs } = await import('../src/tools.js');
const { updateConfig } = await import('../src/config.js');
const img = { content_type: 'image/png', url: 'https://example.com/quoted.png' };
const incoming = (more = {}) => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid: 'GROUP',
  senderId: 'USER', messageId: 'OPAQUE.QQ_MESSAGE-1', content: '<@!BOT> 肥肥，这个是什么新闻', timestamp: new Date().toISOString(),
  msgType: 103, refMsgIdx: 'REFERENCE_INDEX', msgElements: [{ msg_idx: 'REFERENCE_INDEX', attachments: [img] }], ...more });

test('image-only quotation becomes reply media without masquerading as a current attachment', () => {
  const e = normalizeQQMessage(incoming(), { selfId: 'BOT' });
  assert.equal(e.officialAtMe, true);
  assert.equal(e.officialReply.text, '[图片]');
  assert.deepEqual(e.officialReply.media, [{ kind: 'image', url: img.url }]);
  assert.equal(e.officialReply.messageId, null, 'reference index is not a QQ message ID');
  assert.equal(e.message.filter(s => s.type === 'image').length, 0);
});
test('current attachment and quoted attachment remain distinct', () => {
  const e = normalizeQQMessage(incoming({ attachments: [{ ...img, url: 'https://example.com/current.png' }] }));
  assert.equal(e.message.find(s => s.type === 'image').data.url, 'https://example.com/current.png');
  assert.equal(e.officialReply.media[0].url, img.url);
});
test('quote fallback permits an unindexed element, not an explicitly different reference', () => {
  assert.equal(qqMessageQuote(incoming({ msgElements: [{ attachments: [img] }] })).media.length, 1);
  assert.equal(qqMessageQuote(incoming({ msgElements: [{ msg_idx: 'OTHER', attachments: [img] }] })).unavailable, true);
  assert.equal(qqMessageQuote(incoming({ refMsgIdx: '', msgType: 0 })), null);
});
test('text-only and unavailable quotations are distinguishable', () => {
  const q = qqMessageQuote(incoming({ msgElements: [{ msg_idx: 'REFERENCE_INDEX', content: '新闻标题' }] }));
  assert.equal(q.text, '新闻标题'); assert.equal(q.media.length, 0); assert.equal(q.unavailable, false);
  assert.equal(qqMessageQuote(incoming({ msgElements: [] })).unavailable, true);
});
test('quote ref cache is scoped to group and cannot leak another chat attachment', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-quote-client-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const events = [];
  const client = new QQBotClient({ getOptions: () => ({ requireMention: false }), dataDir, allow: () => true,
    onEvent: e => events.push(e), log() {} });
  await client.receive(incoming({ msgType: 0, refMsgIdx: '', msgElements: [], msgIdx: 'REFERENCE_INDEX', messageId: 'ORIGINAL', attachments: [img] }));
  await client.receive(incoming({ messageId: 'FOLLOWUP', msgElements: [] }));
  assert.equal(events.at(-1).officialReply.messageId, 'ORIGINAL');
  assert.equal(events.at(-1).officialReply.media[0].url, img.url);
  await client.receive(incoming({ groupOpenid: 'OTHER_GROUP', messageId: 'CROSS_CHAT', msgElements: [] }));
  assert.equal(events.at(-1).officialReply.unavailable, true);
  assert.deepEqual(events.at(-1).officialReply.media, []);
  client.close();
});
test('non-allowlisted events do not enter quote/body caches', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-quote-denied-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const client = new QQBotClient({ getOptions: () => ({}), dataDir, allow: () => false, onEvent: () => assert.fail(), log() {} });
  await client.receive(incoming({ msgIdx: 'UNAUTHORIZED' }));
  assert.equal(client.messages.size, 0); assert.equal(client.referenceIndex.size, 0);
  const disk = fs.readFileSync(path.join(dataDir, 'qqbot/peers.json'), 'utf8');
  assert.ok(!disk.includes(img.url)); client.close();
});
test('official quote survives ingestion, disk persistence, detail and trigger prompt', async () => {
  const e = normalizeQQMessage(incoming(), { selfId: 'BOT' });
  const reply = await resolveIncomingQuote(e);
  const store = new ChatStore();
  const entry = store.appendIncoming('group:QUOTE_STORE', { mid: e.message_id, senderId: 'USER', senderName: '测试群友',
    text: e.raw_message, reply, media: [], atMe: true });
  const reloaded = new ChatStore().findByMid('group:QUOTE_STORE', e.message_id);
  assert.deepEqual(reloaded.reply, reply);
  const ctx = { kind: 'group', chatKey: 'group:QUOTE_STORE', chatId: 'QUOTE_STORE', triggerEntries: [entry],
    selfNickname: 'BOT', store, memory: { formatForPrompt: () => '' }, stickerEntries: [], contextLimit: 10 };
  const prompt = buildTriggerBlock([entry], ctx);
  assert.match(prompt, /引用.*图片/); assert.match(prompt, /@我/); assert.match(prompt, /OPAQUE.QQ_MESSAGE-1/);
  assert.match(buildUserPrompt(ctx), /引用图片提问/);
  assert.equal(messageImageReferences(reloaded).length, 1);
  assert.equal(quoteForDetail(reply).imageCount, 1);
  assert.equal(JSON.stringify(quoteForDetail(reply)).includes(img.url), false, 'detail need not leak signed image URLs');
});
test('OneBot quotes use local chat store and preserve image; foreign group fallback rejected', async () => {
  const event = { message: [{ type: 'reply', data: { id: '-123' } }] };
  const reply = await resolveIncomingQuote(event, { findByMid: () => ({ senderName: '群友', text: '[图片]', media: [{ kind: 'image', url: img.url }] }) });
  assert.equal(reply.messageId, '-123'); assert.equal(reply.media.length, 1);
  const wrong = await resolveIncomingQuote(event, { kind: 'group', chatId: 'GROUP', getMsg: async () => ({ group_id: 'OTHER', message: [{ type: 'image', data: { url: img.url } }] }) });
  assert.equal(wrong.unavailable, true); assert.deepEqual(wrong.media, []);
});
test('image resolver deduplicates and follows only one scoped cached reply', () => {
  const media = [{ kind: 'image', url: img.url }];
  const entry = { media, reply: { messageId: 'OLD', media } };
  assert.equal(messageImageReferences(entry, () => ({ media, reply: { media: [{ kind: 'image', url: 'https://example.com/deeper' }] } })).length, 1);
});
test('real image tool fetches quoted image through existing image path', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'image/png'); res.end(png); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  updateConfig({ security: { allowPrivateImageHosts: true } });
  const entry = { mid: 'QQ.STRING_ID', text: '这是什么新闻', media: [], reply: { text: '[图片]', media: [{ kind: 'image', url: `http://127.0.0.1:${server.address().port}/image.png` }] } };
  const defs = buildToolDefs();
  const ctx = { chatKey: 'group:TEST', store: { findByMid: () => entry } };
  const result = await defs.find(t => t.id === 'get_message_images').execute(ctx, { messageId: entry.mid });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
  assert.match(result.content.find(p => p.type === 'text').text, /引用的图片/);
  const detail = await defs.find(t => t.id === 'get_message_detail').execute(ctx, { messageId: entry.mid });
  assert.match(JSON.stringify(detail), /imageCount/);
});
test('missing quoted image tool asks for resend rather than pretending there was no quote', async () => {
  const entry = { media: [], reply: { unavailable: true, media: [] } };
  const result = await buildToolDefs().find(t => t.id === 'get_message_images').execute({ chatKey: 'group:TEST', store: { findByMid: () => entry } }, { messageId: 'ID' });
  assert.match(JSON.stringify(result), /引用.*重发原图/);
});

const reminderInput = { trigger: [{ mid: 'CURRENT', atMe: true }], kind: 'group', canSend: true,
  messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'get_message_images', arguments: '{"messageId":"CURRENT"}' } }] },
    { role: 'tool', content: 'No quoted image available.' }, { role: 'assistant', content: 'Plan: ask for the original image.' }] };
test('lookup followed by planning-only ending gets one bounded protocol reminder', () => {
  assert.match(unsentReplyReminder(reminderInput), /send_message/);
  assert.match(unsentReplyReminder(reminderInput), /不要发送或复述内部思考/);
  assert.equal(unsentReplyReminder({ ...reminderInput, alreadyReminded: true }), '');
});
test('nudge is suppressed for ordinary group chatter, prior messages, sent replies and disabled send', () => {
  for (const patch of [{ trigger: [{ mid: 'CURRENT', atMe: false }] }, { proactive: true }, { canSend: false },
    { sent: [{ type: 'image' }] }, { trigger: [{ mid: 'OTHER', atMe: true }] }, { messages: [] }]) {
    assert.equal(unsentReplyReminder({ ...reminderInput, ...patch }), '');
  }
});
