import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsentReplyReminder, unsentQueryReplyReminder } from '../src/reply-completion.js';

const input = { kind: 'group', trigger: [{ mid: 'CURRENT', atMe: true, self: false }], canSend: true,
  messages: [{ role: 'assistant', content: 'Internal planning only, not a user-facing reply.' }] };

test('direct group mention with zero tools gets a bounded reminder, not a copied draft', () => {
  const reminder = unsentReplyReminder(input);
  assert.match(reminder, /send_message/);
  assert.match(reminder, /不要发送或复述内部思考/);
  assert.doesNotMatch(reminder, /Internal planning|已查过|引用图片/);
  assert.equal(unsentReplyReminder({ ...input, alreadyReminded: true }), '');
});

const queryMessages = (name = 'web_search', args = { query: 'offline' }, id = 'QUERY') => [
  { role: 'assistant', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
  { role: 'tool', tool_call_id: id, name, content: 'Synthetic result' },
  ...input.messages
];
const queryInput = { ...input, messages: queryMessages() };

test('post-query reminder requires a completed relevant read-only result, never copies a draft', () => {
  for (const messages of [queryMessages(), queryMessages('web_fetch', { url: 'https://example.invalid' }),
    queryMessages('get_message_images', { messageId: 'CURRENT' }), queryMessages('get_message_detail', { messageId: 'CURRENT' }),
    [...queryMessages('get_message_images', { messageId: 'HISTORICAL' }), ...queryMessages()]]) {
    const reminder = unsentQueryReplyReminder({ ...input, messages });
    assert.match(reminder, /查询后发送检查/);
    assert.match(reminder, /send_message/);
    assert.match(reminder, /不要发送或复述内部思考/);
    assert.doesNotMatch(reminder, /Internal planning|Synthetic result/);
  }
  const errorMessages = queryMessages(); errorMessages[1].isError = true;
  assert.match(unsentQueryReplyReminder({ ...input, messages: errorMessages }), /查询失败、资料不足/);
});

test('post-query reminder needs fresh work after an earlier reminder and is independently bounded', () => {
  const earlierReminder = { role: 'user', content: 'Earlier reminder' };
  assert.ok(unsentQueryReplyReminder({ ...input, messages: [earlierReminder, ...queryMessages()], afterMessageIndex: 0 }));
  const messages = [...queryMessages(), earlierReminder, ...input.messages];
  assert.equal(unsentQueryReplyReminder({ ...input, messages, afterMessageIndex: 3 }), '');
  assert.equal(unsentQueryReplyReminder({ ...queryInput, alreadyReminded: true }), '');
});

test('query nudges exclude pending/mismatched results, unrelated message lookups and non-direct runs', () => {
  const query = queryMessages();
  for (const messages of [[], input.messages, [query[0], query[2]], [query[1], query[0], query[2]],
    [query[0], { ...query[1], tool_call_id: 'OTHER' }, query[2]],
    [query[0], { ...query[1], name: 'web_fetch' }, query[2]], [query[0], query[1]],
    queryMessages('get_message_images', { messageId: 'OTHER' }),
    [...query, { role: 'assistant', tool_calls: [{ id: 'PENDING', function: { name: 'web_search' } }] }, ...input.messages]]) {
    assert.equal(unsentQueryReplyReminder({ ...input, messages }), '');
  }
  for (const patch of [{ trigger: [] }, { trigger: [{ mid: 'CURRENT', atMe: false }] },
    { trigger: [{ mid: 'CURRENT', atMe: true, self: true }] }, { proactive: true },
    { canSend: false }, { sent: [{ type: 'text' }] }, { sent: [{ type: 'image' }] }]) {
    assert.equal(unsentQueryReplyReminder({ ...queryInput, ...patch }), '');
  }
  assert.ok(unsentQueryReplyReminder({ ...queryInput, kind: 'private', trigger: [{ mid: 'CURRENT' }] }));
});

test('neither reminder retries a send or unknown side-effecting tool, even after a current-message lookup', () => {
  for (const name of ['send_message', 'send_image', 'finish', 'skill__send', 'unrecognized_tool']) {
    const messages = [...queryMessages('get_message_images', { messageId: 'CURRENT' }), ...queryMessages(name)];
    assert.equal(unsentReplyReminder({ ...input, messages }), '', name);
    assert.equal(unsentQueryReplyReminder({ ...input, messages }), '', name);
  }
});

test('private messages also nudge on empty or reasoning-only responses without requiring @', () => {
  for (const content of ['', null]) {
    const reminder = unsentReplyReminder({ ...input, kind: 'private', trigger: [{ mid: 'PRIVATE', atMe: false }],
      messages: [{ role: 'assistant', content, reasoning_content: 'PRIVATE_REASONING_NEVER_PUBLISH' }] });
    assert.match(reminder, /send_message/);
    assert.doesNotMatch(reminder, /PRIVATE_REASONING_NEVER_PUBLISH/);
  }
});

test('zero-tool nudge excludes ordinary chatter, self messages, proactive runs and completed delivery', () => {
  for (const patch of [{ trigger: [{ mid: 'CURRENT', atMe: false }] }, { trigger: [{ mid: 'CURRENT' }] },
    { trigger: [{ mid: 'CURRENT', atMe: true, self: true }] }, { trigger: [] }, { trigger: [{ atMe: true }] },
    { proactive: true }, { canSend: false }, { sent: [{ type: 'text' }] }, { sent: [{ type: 'image' }] }]) {
    assert.equal(unsentReplyReminder({ ...input, ...patch }), '');
  }
});

test('no pre-response nudge or extra retry after explicit finish, unrelated lookup or pending tools', () => {
  const call = name => ({ role: 'assistant', tool_calls: [{ function: { name, arguments: '{"messageId":"OTHER"}' } }] });
  for (const messages of [[], [{ role: 'user', content: 'hello' }], [call('get_message_images')],
    [call('finish'), ...input.messages], [call('get_message_images'), ...input.messages],
    [call('send_message'), ...input.messages]]) {
    assert.equal(unsentReplyReminder({ ...input, messages }), '');
  }
});
