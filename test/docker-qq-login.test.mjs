import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QQQrLogin, qqQrConfigPatch } from '../src/qqbot-login.js';

const tick = () => new Promise(r => setImmediate(r));
const url = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=LOCAL_FIXTURE&source=qq-agent&_wv=2';
const credential = { appId: '123456', appSecret: 'QR_SECRET_TEST_ONLY', userOpenid: 'SCAN_user-1' };
function fixture(t, overrides = {}) {
  let time = 10_000;
  const calls = [];
  const login = new QQQrLogin({ now: () => time, connect(callbacks, options) {
    const call = { callbacks, options, disposed: false }; calls.push(call);
    return () => { call.disposed = true; callbacks.onFailure(new Error('cancelled')); };
  }, ...overrides });
  t.after(() => login.close());
  return { login, calls, advance(ms) { time += ms; } };
}

test('QR flow generates local PNG, never exposes secret, requires explicit one-shot confirmation', async t => {
  const { login, calls } = fixture(t);
  const s = login.start(); assert.equal(s.status, 'creating');
  assert.equal(calls[0].options.displayQrCodeToConsole, false);
  assert.equal(calls[0].options.source, 'qq-agent');
  calls[0].callbacks.onQrDisplayed(url); await tick();
  // qrcode PNG encoding uses asynchronous zlib, wait with a bounded deadline.
  const deadline = Date.now() + 2000;
  while (login.status(s.id).status === 'creating' && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.match(login.status(s.id).qrImage, /^data:image\/png;base64,iVBOR/);
  assert.throws(() => login.apply(s.id, '123456', () => assert.fail()), /先完成/);
  calls[0].callbacks.onSuccess([credential]);
  const ready = login.status(s.id); assert.equal(ready.status, 'authorized');
  assert.deepEqual(ready.accounts, [{appId:'123456',hasScanUser:true}]);
  assert.equal(JSON.stringify(ready).includes(credential.appSecret), false);
  assert.equal(JSON.stringify(ready).includes(credential.userOpenid), false);
  assert.equal(ready.qrImage, ''); assert.ok(calls[0].disposed);
  assert.throws(() => login.apply(s.id, '999', () => assert.fail()), /本次扫码/);
  let saved = 0;
  assert.equal(login.apply(s.id, '123456', c => { saved++; assert.deepEqual(c,credential); }).status, 'applied');
  assert.equal(saved, 1); assert.deepEqual(login.status(s.id).accounts, []);
  assert.throws(() => login.apply(s.id, '123456', () => assert.fail()), /先完成/);
});
test('QR cancellation, replacement and late SDK callbacks cannot restore credentials', t => {
  const { login, calls, advance } = fixture(t);
  const first = login.start(); login.cancel(first.id);
  calls[0].callbacks.onSuccess([credential]); assert.equal(login.status(first.id).status, 'cancelled');
  advance(5000); const second = login.start();
  calls[0].callbacks.onSuccess([credential]); assert.equal(login.status(second.id).status, 'creating');
  assert.throws(() => login.status(first.id), /已失效/);
  assert.throws(() => login.start(), /过于频繁/);
  login.close(); calls[1].callbacks.onSuccess([credential]); assert.ok(calls[1].disposed);
  assert.throws(() => login.status(second.id), /已失效/);
});
test('QR authorization expires and wipes pending secrets without any save', t => {
  const { login, calls, advance } = fixture(t);
  const s = login.start(); calls[0].callbacks.onSuccess([credential]);
  advance(300_001); assert.equal(login.status(s.id).status, 'expired');
  assert.deepEqual(login.status(s.id).accounts, []);
  assert.throws(() => login.apply(s.id, '123456', () => assert.fail()), /先完成/);
});
test('SDK failures and invalid credential payloads are sanitized', t => {
  const { login, calls, advance } = fixture(t);
  const s = login.start(); calls[0].callbacks.onFailure(new Error('FAIL '+credential.appSecret));
  assert.equal(login.status(s.id).status, 'failed'); assert.ok(!JSON.stringify(login.status(s.id)).includes(credential.appSecret));
  for (const invalid of [[], [null], [{appId:123456,appSecret:'x'}], [{appId:'abc',appSecret:'x'}], [{appId:'1',appSecret:''}], [credential,credential]]) {
    advance(5000); const s2 = login.start(); calls.at(-1).callbacks.onSuccess(invalid);
    assert.equal(login.status(s2.id).status, 'failed');
  }
});
test('QR restricts authorization URLs and ignores superseded image renders', async t => {
  const pending = [];
  const { login, calls, advance } = fixture(t, {render: () => new Promise(resolve => pending.push(resolve))});
  const s = login.start(); calls[0].callbacks.onQrDisplayed('https://evil.invalid/');
  assert.equal(login.status(s.id).status, 'failed'); assert.equal(pending.length,0);
  advance(5000); const s2 = login.start(); const cb = calls[1].callbacks;
  cb.onQrDisplayed(url); await tick(); cb.onQrExpired(); cb.onQrDisplayed(url); await tick();
  pending[1]('NEW_IMAGE'); await tick(); pending[0]('OLD_IMAGE'); await tick();
  assert.equal(login.status(s2.id).qrImage, 'NEW_IMAGE');
  login.cancel(s2.id); cb.onSuccess([credential]); assert.deepEqual(login.status(s2.id).accounts, []);
});
test('QR save checks environment and account identity before changing config; only opt-in user allowlisting', () => {
  const config = {qqbot:{appId:'123456',requireMention:false},allow:{private:['EXISTING'],groups:['GROUP']},api:{apiKey:'MODEL_SECRET'}};
  const original = structuredClone(config);
  const opts = {config,boundAppId:'123456',env:{}};
  const patch = qqQrConfigPatch(opts, credential, true);
  assert.equal(patch.qqbot.authSource,'qr'); assert.equal(patch.api,undefined);
  assert.deepEqual(patch.allow.private,['EXISTING','SCAN_user-1']); assert.deepEqual(config,original);
  assert.equal(qqQrConfigPatch(opts,credential,false).allow,undefined);
  assert.throws(()=>qqQrConfigPatch({...opts,boundAppId:'999'},credential,true),/不同/);
  assert.throws(()=>qqQrConfigPatch({...opts,config:{qqbot:{appId:'999'}}},credential,true),/不同/);
  assert.throws(()=>qqQrConfigPatch({...opts,env:{QQ_AGENT_DOCKER:'1',QQBOT_APP_SECRET:'ENV_SECRET'}},credential,true),/环境变量/);
  assert.deepEqual(config,original);
});
test('failed persistence leaves the QR credentials pending for retry, not falsely marked applied', t => {
  const { login, calls } = fixture(t); const s=login.start(); calls[0].callbacks.onSuccess([credential]);
  assert.throws(()=>login.apply(s.id,credential.appId,()=>{throw new Error('disk full')}),/disk full/);
  assert.equal(login.status(s.id).status,'authorized');
});
