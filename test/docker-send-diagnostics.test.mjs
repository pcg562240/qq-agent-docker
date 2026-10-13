import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QQTextSendDiagnostics, TEXT_SEND_DIAGNOSTIC_LIMIT } from '../src/qqbot-send-diagnostics.js';

const target = { scope: 'group', targetId: 'GROUP_PRIVATE', msgId: 'MESSAGE_PRIVATE' };
const body = { msg_type: 0, msg_id: target.msgId, msg_seq: 11, content: 'PRIVATE_BODY' };
const observeBody = (diagnostics, value = body) => diagnostics.observe('debug', `[qqbot:api] >>> Body: ${JSON.stringify(value)}`);

test('send diagnostics retain whitelisted metadata, never raw SDK logs or identities', async () => {
  const d = new QQTextSendDiagnostics();
  const result = { id: 'RETURNED_PRIVATE_ID' };
  assert.equal(await d.run(target, async () => {
    d.observe('debug', '[qqbot:api] >>> POST https://example.test/groups/GROUP_PRIVATE/messages');
    observeBody(d, { ...body, message_reference: { message_id: 'QUOTED_PRIVATE_ID' },
      authorization: 'QQBot SECRET', unexpected: 'SECRET' });
    d.observe('info', '[qqbot:api] <<< Status: 200 OK | TraceId: PRIVATE_TRACE');
    d.observe('debug', '[qqbot:api] <<< Body: {"id":"RETURNED_PRIVATE_ID","secret":"SECRET"}');
    return result;
  }), result);
  const [entry] = d.list();
  assert.deepEqual(Object.keys(entry).sort(), ['sequence', 'startedAt', 'scope', 'outcome', 'wireObserved',
    'requestBodyCount', 'httpStatus', 'msgType', 'hasMsgId', 'anchorMatches', 'hasReference',
    'hasMarkdown', 'contentLength', 'leadingMention', 'sequenceInRange', 'hasReturnedId', 'finishedAt'].sort());
  assert.equal(entry.wireObserved, true); assert.equal(entry.anchorMatches, true);
  assert.equal(entry.httpStatus, 200); assert.equal(entry.hasReference, true);
  assert.equal(entry.hasMarkdown, false); assert.equal(entry.leadingMention, 'none');
  assert.equal(entry.outcome, 'returned'); assert.equal(entry.hasReturnedId, true);
  assert.equal(entry.contentLength, body.content.length); assert.equal(entry.sequenceInRange, true);
  assert.doesNotMatch(JSON.stringify(d.list()), /PRIVATE|SECRET|authorization|example\.test/);
});

test('overlapping sends keep their own wire anchor, status and result', async () => {
  const d = new QQTextSendDiagnostics();
  let release; const wait = new Promise(resolve => { release = resolve; });
  const first = d.run(target, async () => {
    observeBody(d); await wait;
    d.observe('info', '[qqbot:api] <<< Status: 200 OK');
    return { id: 'A' };
  });
  await d.run({ scope: 'c2c', msgId: 'B' }, async () => {
    observeBody(d, { ...body, msg_id: 'NOT_B', markdown: { content: 'SECRET_MARKDOWN' } });
    d.observe('info', '[qqbot:api] <<< Status: 202 Accepted'); return {};
  });
  release(); await first;
  const [second, earlier] = d.list();
  assert.equal(earlier.httpStatus, 200); assert.equal(earlier.anchorMatches, true);
  assert.equal(earlier.hasReturnedId, true);
  assert.equal(second.httpStatus, 202); assert.equal(second.anchorMatches, false);
  assert.equal(second.scope, 'c2c'); assert.equal(second.hasMarkdown, true);
  assert.equal(second.hasReturnedId, false);
});

test('malformed, oversized, unrelated and late logs cannot break sends or claim wire success', async () => {
  const d = new QQTextSendDiagnostics(); let late;
  observeBody(d); // Not inside a text send.
  await d.run(target, async () => {
    d.observe('debug', '[qqbot:api] >>> Body: {');
    d.observe('debug', '[qqbot:api] >>> Body: ' + 'x'.repeat(128 * 1024));
    d.observe('debug', null);
    observeBody(d, { access_token: 'SECRET' });
    d.observe('info', '[qqbot:api] <<< Status: 200 OK');
    late = new Promise(resolve => setImmediate(() => { observeBody(d); resolve(); }));
    return { id: 'FAKE_SDK_RESULT' };
  });
  await late;
  const [entry] = d.list();
  assert.equal(entry.outcome, 'returned'); assert.equal(entry.wireObserved, false);
  assert.equal(entry.httpStatus, null); assert.equal(entry.requestBodyCount, 0);
});

test('diagnostics preserve the original error and never retain error strings or retry sends', async () => {
  const d = new QQTextSendDiagnostics(); let calls = 0;
  const failure = Object.assign(new Error('SECRET URL ID BODY'), { httpStatus: 403, bizCode: 304036 });
  await assert.rejects(d.run(target, async () => {
    calls++; observeBody(d); d.observe('info', '[qqbot:api] <<< Status: 403 Forbidden'); throw failure;
  }), error => error === failure);
  assert.equal(calls, 1);
  const [entry] = d.list();
  assert.equal(entry.outcome, 'error'); assert.equal(entry.errorHttpStatus, 403);
  assert.equal(entry.errorCode, 304036); assert.equal(entry.httpStatus, 403);
  assert.doesNotMatch(JSON.stringify(entry), /SECRET|URL|BODY|PRIVATE/);
});

test('diagnostic ring is bounded, copied on read and isolated per client', async () => {
  const d = new QQTextSendDiagnostics();
  for (let i = 0; i < TEXT_SEND_DIAGNOSTIC_LIMIT + 3; i++) await d.run(target, async () => ({}));
  assert.equal(d.list().length, TEXT_SEND_DIAGNOSTIC_LIMIT);
  assert.equal(d.list().at(-1).sequence, 4);
  d.list()[0].outcome = 'modified';
  assert.equal(d.list()[0].outcome, 'returned');
  assert.deepEqual(new QQTextSendDiagnostics().list(), []);
});

test('metadata distinguishes mention markup and active sends without exposing tag IDs', async () => {
  const d = new QQTextSendDiagnostics();
  for (const [prefix, expected] of [['<@PRIVATE_ID>', 'legacy'], ['<qqbot-at-user id="PRIVATE_ID" />', 'native'], ['', 'none']]) {
    await d.run({ scope: 'group' }, async () => {
      observeBody(d, { msg_type: 0, content: prefix + ' PRIVATE_BODY', msg_seq: 65536 });
      return {};
    });
    const [entry] = d.list();
    assert.equal(entry.leadingMention, expected); assert.equal(entry.hasMsgId, false);
    assert.equal(entry.anchorMatches, true); assert.equal(entry.sequenceInRange, false);
    assert.doesNotMatch(JSON.stringify(entry), /PRIVATE/);
  }
});
