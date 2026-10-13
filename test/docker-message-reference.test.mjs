import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { messageReference, resolveMessageReference, normalizeToolMessageReferences } from '../src/message-reference.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-message-ref-'));
Object.assign(process.env, { QQ_AGENT_DATA_DIR: dir, QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '' });
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { ChatStore } = await import('../src/store.js');
const { buildToolDefs, executeTool } = await import('../src/tools.js');
const { buildTriggerBlock, buildPastState, buildUserPrompt } = await import('../src/prompt.js');
const { updateConfig } = await import('../src/config.js');
const { unsentReplyReminder, unsentQueryReplyReminder } = await import('../src/reply-completion.js');
const { referenceUrl } = await import('../skills/chatgpt2api-image/runtime.js');
const { resolveReference } = await import('../examples/skills/comfy-draw/lib/qwen21-runtime.js');
const MID = n => `ROBOT1.0_${'Synthetic.Qq-Id_'.repeat(8)}${n}.suffix!!`;
let seq = 0;
function fixture() {
  const store = new ChatStore(), chatKey = `group:REF_${++seq}`;
  const entry = store.appendIncoming(chatKey, { mid: MID('A'), senderId: 'USER_A', senderName: 'fixture',
    text: 'synthetic image request', atMe: true, media: [{ kind: 'image', url: 'https://example.com/fixture.png' }] });
  const ctx = { store, chatKey, kind: 'group', triggerEntries: [entry], session: { trigger: [entry], sent: [] },
    memory: { formatForPrompt: () => '' }, stickerEntries: [] };
  return { ...ctx, ctx, entry, ref: messageReference(entry, chatKey) };
}

test('short references are deterministic, chat-bound and survive reload and later arrivals', () => {
  const f = fixture();
  assert.match(f.ref, /^m1-[a-f0-9]{10}$/);
  assert.notEqual(f.ref, messageReference(f.entry, 'group:OTHER'));
  f.store.appendIncoming(f.chatKey, { mid: MID('B'), text: 'later' });
  const fresh = new ChatStore();
  assert.equal(resolveMessageReference(fresh, f.chatKey, f.ref), f.entry.mid);
  assert.equal(resolveMessageReference(fresh, f.chatKey, '#' + f.ref), f.entry.mid);
  assert.equal(fresh.findByMid(f.chatKey, f.ref), null, 'raw protocol lookup stays exact');
  assert.equal(fresh.findByMid(f.chatKey, f.entry.mid).mid, f.entry.mid);
});

test('cross-chat handles, changed checksums, trimmed and recalled records never resolve', () => {
  const f = fixture();
  f.store.appendIncoming('group:OTHER', { mid: f.entry.mid, text: 'same local number in another chat' });
  assert.throws(() => resolveMessageReference(f.store, 'group:OTHER', f.ref), /失效/);
  const changed = f.ref.slice(0, -1) + (f.ref.endsWith('0') ? '1' : '0');
  assert.throws(() => resolveMessageReference(f.store, f.chatKey, changed), /失效/);
  f.store.markRecalled(f.chatKey, f.entry.mid);
  assert.throws(() => resolveMessageReference(f.store, f.chatKey, f.ref), /失效/);
  const capped = new ChatStore(1), chat = 'group:TRIM';
  const old = capped.appendIncoming(chat, { mid: MID('old') });
  capped.appendIncoming(chat, { mid: MID('new') });
  assert.throws(() => resolveMessageReference(capped, chat, messageReference(old, chat)), /失效/);
  const reset = fixture();
  reset.store.clearChat(reset.chatKey);
  const replacement = reset.store.appendIncoming(reset.chatKey, { mid: MID('replacement') });
  assert.throws(() => resolveMessageReference(reset.store, reset.chatKey, reset.ref), /失效/);
  // An imported/replaced archive can reuse a sequence, even though clearChat
  // currently keeps it increasing. The checksum must still reject another ID.
  const replacedArchive = { findByLocalId: () => ({ ...replacement, id: reset.entry.id }) };
  assert.throws(() => resolveMessageReference(replacedArchive, reset.chatKey, reset.ref), /失效/);
});

test('short and numeric raw IDs stay compatible; corrupted long IDs are never fuzzy-repaired', () => {
  const f = fixture();
  for (const mid of [-123, 'short-opaque']) {
    const entry = f.store.appendIncoming(f.chatKey, { mid });
    assert.equal(messageReference(entry, f.chatKey), String(mid));
    assert.equal(String(resolveMessageReference(f.store, f.chatKey, '#' + mid)), String(mid));
  }
  const truncated = f.entry.mid.slice(0, 86);
  assert.equal(resolveMessageReference(f.store, f.chatKey, truncated), truncated);
  assert.equal(f.store.findByMid(f.chatKey, truncated), null);
});

test('prompt, recent messages and detail use the same reference without changing disk IDs', async () => {
  const f = fixture(), defs = buildToolDefs();
  for (const prompt of [buildTriggerBlock([f.entry], f.ctx), buildPastState(f.store, f.chatKey).text, buildUserPrompt(f.ctx)]) {
    assert.ok(prompt.includes('#' + f.ref));
    assert.ok(!prompt.includes(f.entry.mid));
  }
  const recent = await executeTool(defs, f.ctx, 'get_recent_messages', '{}');
  assert.equal(JSON.parse(recent.content).messages[0].messageId, f.ref);
  const detail = await executeTool(defs, f.ctx, 'get_message_detail', JSON.stringify({ messageId: '#' + f.ref }));
  assert.equal(JSON.parse(detail.content).messageId, f.ref);
  assert.equal(new ChatStore().findByMid(f.chatKey, f.entry.mid).mid, f.entry.mid);
});

test('only explicit message fields are normalized; edit references and masks work without mutating arguments', () => {
  const f = fixture();
  const args = { messageId: f.ref, message_id: f.ref, replyToMessageId: '#' + f.ref,
    atUserId: f.ref, messages: f.ref, source_job_id: f.ref, url: f.ref,
    references: [{ message_id: f.ref, image_index: 1 }], mask: { message_id: f.ref, image_index: 1 } };
  const copy = structuredClone(args), out = normalizeToolMessageReferences(args, f.ctx);
  assert.deepEqual(args, copy);
  for (const key of ['messageId', 'message_id', 'replyToMessageId']) assert.equal(out[key], f.entry.mid);
  for (const key of ['atUserId', 'messages', 'source_job_id', 'url']) assert.equal(out[key], f.ref);
  assert.equal(referenceUrl(f.ctx, out.references[0]), f.entry.media[0].url);
  assert.equal(referenceUrl(f.ctx, out.mask), f.entry.media[0].url);
  assert.equal(resolveReference(f.ctx, out.message_id), f.entry.media[0].url);
});

test('bad references reject before any sending/drawing tool executes, never borrow the latest image', async () => {
  const f = fixture(); let calls = 0;
  const defs = [{ id: 'draw', name: 'draw', execute() { calls++; return { content: 'unexpected' }; } }];
  for (const args of [{ messageId: 'm999-0000000000' }, { references: [{ message_id: 'm999-0000000000' }] },
    { mask: { message_id: 'm999-0000000000' } }, { replyToMessageId: 'm999-0000000000' }]) {
    assert.equal((await executeTool(defs, f.ctx, 'draw', args)).isError, true);
  }
  assert.equal(calls, 0);
});

test('truncated model ID produces short retry hints instead of another list of long IDs', async () => {
  const f = fixture();
  const r = await executeTool(buildToolDefs(), f.ctx, 'get_message_images', { messageId: f.entry.mid.slice(0, 86) });
  assert.equal(r.isError, true);
  assert.ok(r.content.includes(f.ref));
  assert.ok(!r.content.includes(f.entry.mid));
});

test('image lookup via a short reference downloads only its own and quoted images', async t => {
  const f = fixture(), hits = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const server = http.createServer((req, res) => { hits.push(req.url); res.setHeader('content-type', 'image/png'); res.end(png); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  updateConfig({ security: { allowPrivateImageHosts: true } });
  f.entry.media = [{ kind: 'image', url: base + '/own.png' }];
  f.entry.reply = { media: [{ kind: 'image', url: base + '/quote.png' }] };
  f.store.appendIncoming(f.chatKey, { mid: MID('later'), media: [{ kind: 'image', url: base + '/wrong.png' }] });
  const result = await executeTool(buildToolDefs(), f.ctx, 'get_message_images', { messageId: f.ref });
  assert.equal(result.content.filter(p => p.type === 'image_url').length, 2);
  assert.deepEqual(hits, ['/own.png', '/quote.png']);
  assert.ok(result.content[0].text.includes(f.ref));
  assert.ok(!result.content[0].text.includes(f.entry.mid));
});

test('initial and post-query visible reply reminders recognize short handles only for this trigger/chat', () => {
  const f = fixture();
  const base = { trigger: [f.entry], kind: 'group', chatKey: f.chatKey, canSend: true,
    messages: [{ role: 'assistant', tool_calls: [{ id: 'q', function: { name: 'get_message_images', arguments: JSON.stringify({ messageId: '#' + f.ref }) } }] },
      { role: 'tool', name: 'get_message_images', tool_call_id: 'q', content: 'fixture' }, { role: 'assistant', content: '' }] };
  assert.match(unsentReplyReminder(base), /send_message/);
  assert.match(unsentQueryReplyReminder(base), /send_message/);
  assert.equal(unsentReplyReminder({ ...base, chatKey: 'group:OTHER' }), '');
  assert.equal(unsentQueryReplyReminder({ ...base, sent: [{ type: 'text' }] }), '');
});

// Keep old extension syntax intact; new handles remove the ambiguity for new prompts.
test('drawing #local-number references are not reinterpreted as coincident numeric protocol IDs', () => {
  const f = fixture();
  f.store.appendIncoming(f.chatKey, { mid: 1, media: [{ kind: 'image', url: 'https://example.com/other.png' }] });
  const out = normalizeToolMessageReferences({ message_id: '#1', references: [{ message_id: '#1' }], mask: { message_id: '#1' } }, f.ctx);
  assert.equal(out.message_id, '#1');
  assert.equal(out.references[0].message_id, '#1');
  assert.equal(out.mask.message_id, '#1');
  assert.equal(resolveReference(f.ctx, out.message_id), f.entry.media[0].url);
});
