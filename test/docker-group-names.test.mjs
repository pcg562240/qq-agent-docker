import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { GroupNames } from '../src/group-names.js';
import { QQIngressJournal, INGRESS_LIMIT } from '../src/qqbot-ingress.js';

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-group-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
test('console group aliases persist, clear and remain isolated per robot without changing platform names', t => {
  const dir = temp(t), a = new GroupNames(path.join(dir, 'a')), b = new GroupNames(path.join(dir, 'b'));
  assert.equal(fs.existsSync(a.file), false, 'read-only startup does not create an empty file');
  assert.equal(a.describe('GROUP', 'GROUP').name, '');
  assert.deepEqual(a.describe('GROUP', 'Platform name'), { name: 'Platform name', groupAlias: '', nameSource: 'platform' });
  a.set('GROUP', ' My group ');
  assert.equal(a.describe('GROUP', 'Platform name').name, 'My group');
  assert.equal(new GroupNames(path.join(dir, 'a')).describe('GROUP').name, 'My group');
  assert.equal(b.describe('GROUP').name, '');
  a.set('GROUP', ''); assert.equal(a.describe('GROUP', 'Platform name').name, 'Platform name');
  assert.equal(a.describe('GROUP', 'GROUP').name, '');
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
});
test('group alias inputs reject traversal, oversized and multiline names without changing stored values', t => {
  const names = new GroupNames(temp(t)); names.set('GROUP', 'Original');
  const before = fs.readFileSync(names.file, 'utf8');
  for (const [id, name] of [['../bad', 'x'], ['', 'x'], [123, 'x'], ['GROUP', null], ['GROUP', 'x'.repeat(81)], ['GROUP', 'x\ny']]) {
    assert.throws(() => names.set(id, name), { status: 400, expose: true });
  }
  assert.equal(fs.readFileSync(names.file, 'utf8'), before);
  names.set('__proto__', '<script>name</script>');
  assert.equal(names.describe('__proto__').name, '<script>name</script>', 'literal text, no object prototype key mutation');
});
test('ingress journal is bounded, persistent, scoped and never stores message content or author IDs', t => {
  const dir = temp(t), journal = new QQIngressJournal(dir);
  for (let i = 0; i < INGRESS_LIMIT + 3; i++) journal.record({ kind: 'group', id: i % 2 ? 'GROUP_A' : 'GROUP_B',
    messageId: 'PRIVATE_MESSAGE_ID_' + i, eventType: 'GROUP_MESSAGE_CREATE', atMe: false, messageAt: i, receivedAt: i,
    reason: 'not_mentioned', content: 'PRIVATE_BODY', senderId: 'PRIVATE_AUTHOR', token: 'PRIVATE_TOKEN' });
  const text = fs.readFileSync(journal.file, 'utf8');
  assert.doesNotMatch(text, /PRIVATE_/);
  assert.equal(JSON.parse(text).length, INGRESS_LIMIT);
  const restored = new QQIngressJournal(dir), entries = restored.list('group', 'GROUP_A');
  assert.equal(entries.length, 50); assert.ok(entries.every(e => e.id === 'GROUP_A'));
  assert.ok(entries[0].receivedAt > entries[1].receivedAt);
  assert.deepEqual(restored.list('group', 'UNKNOWN'), []);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['kind', 'id', 'ref', 'eventType', 'atMe', 'messageAt', 'receivedAt', 'reason'].sort());
  entries[0].reason = 'changed'; assert.equal(restored.list('group', 'GROUP_A')[0].reason, 'not_mentioned');
  const extra = { ...restored.entries[0], body: 'PRIVATE_BODY' };
  fs.writeFileSync(journal.file, JSON.stringify([extra, null, { reason: 'forwarded', body: 'PRIVATE_BODY' }]));
  const sanitized = new QQIngressJournal(dir);
  assert.equal(sanitized.entries.length, 1); assert.doesNotMatch(JSON.stringify(sanitized.entries), /PRIVATE_BODY/);
});
test('failed diagnostic disk writes do not prevent receipt', t => {
  const dir = temp(t); fs.writeFileSync(path.join(dir, 'not-a-dir'), 'file');
  const journal = new QQIngressJournal(path.join(dir, 'not-a-dir'));
  journal.record({ kind: 'group', id: 'GROUP', messageId: 'MID', eventType: 'GROUP_AT_MESSAGE_CREATE',
    atMe: true, messageAt: 1, receivedAt: 2, reason: 'forwarded' });
  assert.equal(journal.list('group', 'GROUP').length, 1);
});

const code = fs.readFileSync(new URL('../ui/app/06-settings-render.js', import.meta.url), 'utf8');
const namesCode = code.slice(code.indexOf('function chatNameOf('), code.indexOf('function clampInt('));
test('group UI shows aliases with original OpenID, does not duplicate ID, and saves only a local alias', async () => {
  const requests = [], state = { chats: [{ key: 'group:GROUP', groupAlias: 'Old', chatName: 'Old' }], activeInst: { self: true } };
  const context = vm.createContext({ state, window: { askGroupAlias: async () => 'New name' }, alert: () => assert.fail('unexpected error'),
    api: async (url, options) => { requests.push({ url, options }); return { chats: [] }; },
    renderChatList() {}, renderSessionList() {}, $: () => null, lastDetailFp: '', loadSessionDetail() {} });
  vm.runInContext(namesCode, context);
  assert.equal(context.formatChatTitle('group:GROUP', 'GROUP'), '群 GROUP');
  assert.equal(context.formatChatTitle('group:GROUP', 'My group'), 'My group（GROUP）');
  await context.editGroupAlias('group:GROUP');
  assert.deepEqual(JSON.parse(requests[0].options.body), { groupId: 'GROUP', name: 'New name' });
  assert.equal(requests[0].url, '/api/group-names');
  requests.length = 0; context.window.askGroupAlias = async () => null;
  await context.editGroupAlias('group:GROUP'); assert.equal(requests.length, 0);
  context.window.askGroupAlias = async () => { state.activeInst = { id: 'other-instance' }; return 'stale'; };
  await context.editGroupAlias('group:GROUP'); assert.equal(requests.length, 0);
});
test('late group-name responses cannot replace another instance view', async () => {
  let resolve; const state = { chats: [], activeInst: { id: 'A' } };
  const context = vm.createContext({ state, api: () => new Promise(r => { resolve = r; }),
    renderChatList: () => assert.fail('stale render'), renderSessionList() {} });
  vm.runInContext(namesCode, context);
  const pending = context.refreshChatNames(); state.activeInst = { id: 'B' }; resolve({ chats: [{ key: 'A_SECRET' }] });
  await pending; assert.deepEqual(state.chats, []);
});
