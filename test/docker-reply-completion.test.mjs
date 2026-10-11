import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsentReplyReminder } from '../src/reply-completion.js';

const input = { kind: 'group', trigger: [{ mid: 'CURRENT', atMe: true, self: false }], canSend: true,
  messages: [{ role: 'assistant', content: 'Internal planning only, not a user-facing reply.' }] };

test('direct group mention with zero tools gets a bounded reminder, not a copied draft', () => {
  const reminder = unsentReplyReminder(input);
  assert.match(reminder, /send_message/);
  assert.match(reminder, /不要发送或复述内部思考/);
  assert.doesNotMatch(reminder, /Internal planning|已查过|引用图片/);
  assert.equal(unsentReplyReminder({ ...input, alreadyReminded: true }), '');
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
