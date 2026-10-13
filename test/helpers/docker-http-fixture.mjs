// Offline-only test fixture. Does not connect to QQ or an LLM provider.
import { createApp } from '../../src/app.js';
import { getConfig, updateConfig } from '../../src/config.js';
import assert from 'node:assert/strict';
import path from 'node:path';
const sent = [];
class FakeBot {
  constructor() { this.events = new Map(); }
  on(name, fn) { this.events.set(name, fn); }
  start() { this.events.get('ready')?.({ user: { id: 'bot', username: 'test-bot' } }); return new Promise(r => { this.finish = r; }); }
  stop() { this.finish?.(); }
  async sendText(target, content) { sent.push({ target, content }); return { id: 'SENT_STRING_ID' }; }
  async send(options) { sent.push(options); return { id: 'SENT_QUOTED_ID' }; }
}
if (!getConfig().qqbot?.appId && !process.env.QQ_AGENT_PROFILES_ROOT) updateConfig({
  qqbot: { appId: '123456', clientSecret: 'FIXTURE_SECRET', enabled: true, groupReplyMentionMode: process.env.TEST_GROUP_MENTION_MODE || 'off' },
  allow: { private: ['USER_with-hyphen'], groups: ['GROUP_with-hyphen'] },
  extensions: { hotReload: false },
});
let qrCallbacks;
const app = createApp({ log() {}, qqBotClass: FakeBot, onProfileSwitch: async () => { await app.stop(); process.exit(0); }, qqQrConnect(callbacks) {
  qrCallbacks = callbacks;
  callbacks.onQrDisplayed('https://q.qq.com/qqbot/openclaw/connect.html?task_id=OFFLINE_TEST&source=qq-agent&_wv=2');
  return () => {};
} });
if (process.env.TEST_LLM_URL) updateConfig({
  api: { baseUrl: process.env.TEST_LLM_URL, model: 'local-fixture', apiKey: '', provider: '' },
  wakeDelayMs: 30, store: { contextTier: 1, contextSliderPos: 10 },
  sessionRetryAttempts: 0, send: { minGapMs: 200, maxGapMs: 200, byLengthMs: 1 },
  ...(process.env.TEST_QUOTE_IMAGES === '1' ? { api: { baseUrl: process.env.TEST_LLM_URL, model: 'local-fixture', apiKey: '', provider: '', vision: true },
    security: { allowPrivateImageHosts: true }, skills: { 'reply-safety': { enabled: false } } } : {}),
});
else app.orchestrator.setPaused(true, 'test');
if (process.env.TEST_QUERY_TOOLS === '1') {
  // Test-only substitutes: query-completion regressions must never search the
  // public web. Reapply after config refreshes, retaining real tool schemas.
  const refresh = app.orchestrator.refreshToolDefs.bind(app.orchestrator);
  const patch = () => {
    app.orchestrator.toolDefs = app.orchestrator.toolDefs.map(d => !['web_search', 'web_fetch'].includes(d.id) ? d : {
      ...d, execute: async (_ctx, args) => ({ content: args.query === 'FAIL' ? 'OFFLINE_QUERY_FAILED' : 'OFFLINE_QUERY_RESULT', isError: args.query === 'FAIL' })
    });
  };
  app.orchestrator.refreshToolDefs = (...args) => { const result = refresh(...args); patch(); return result; };
  patch();
}
const port = await app.start();
if (process.send) process.send({ ready: true, port });
else console.log('offline test fixture ready');
process.on('message', async message => {
  try {
    if (message.action === 'qr-authorize') qrCallbacks.onSuccess([{ appId: message.appId || '123456', appSecret: 'QR_FIXTURE_SECRET', userOpenid: 'SCAN_user-1' }]);
    if (message.action === 'profile-memory') app.memory.append('group:GROUP_with-hyphen', 'memberImpression', message.text, { userId: 'USER_with-hyphen' });
    if (message.action === 'profile-memory-read') {
      process.send({ id: message.id, value: app.memory.getMember('group:GROUP_with-hyphen', 'USER_with-hyphen') }); return;
    }
    if (message.action === 'send-tool-parameters') {
      process.send({ id: message.id, parameters: app.orchestrator.toolDefs.find(t => t.id === 'send_message').parameters }); return;
    }
    if (message.action === 'set-config') updateConfig(message.patch);
    if (message.action === 'receive') {
      const group = message.group === true;
      const mode = message.mentionMode || 'event';
      await app.onebot.receive({ kind: group ? 'group' : 'c2c', rawEventType: group ? (['structured','inline','ordinary'].includes(mode) ? 'GROUP_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE') : 'C2C_MESSAGE_CREATE',
        ...(group ? { groupOpenid: message.groupId || 'GROUP_with-hyphen' } : {}),
        ...(mode === 'structured' ? { mentions: [{id:'bot',is_you:true,bot:true}] } : {}),
        senderId: message.senderId || 'USER_with-hyphen', messageId: message.messageId || (group ? 'GROUP_MID-with-hyphen' : 'MID_with-hyphen'),
        content: message.content ?? (!group ? 'offline integration message' : mode === 'structured' ? 'ordinary group event with server mention' : mode === 'bare' ? '<@!bot> ' : '<@!bot> offline group message'),
        ...(message.quote ? { msgType: 103, refMsgIdx: 'QUOTE_INDEX', msgElements: [{ msg_idx: 'QUOTE_INDEX', ...message.quote }] } : {}),
        timestamp: new Date().toISOString() });
    }
    if (message.action === 'media-boundary') {
      const secret = path.join(process.env.QQ_AGENT_DATA_DIR, 'config.json');
      await assert.rejects(app.sender.sendImage('private:USER_with-hyphen', { file: secret }), /媒体目录/);
      await assert.rejects(app.sender.sendSticker('private:USER_with-hyphen', { url: `file://${secret}` }), /媒体目录/);
      await assert.rejects(app.sender.sendMedia('private:USER_with-hyphen', [{ type: 'image', data: { file: secret } }]), /媒体目录/);
      app.memory.append('group:GROUP_with-hyphen', 'memberImpression', 'original', { userId: 'USER_with-hyphen' });
      app.memory.replaceMember('group:GROUP_with-hyphen', 'USER_with-hyphen', 'test', ['updated']);
      assert.equal(app.memory.getMember('group:GROUP_with-hyphen', 'USER_with-hyphen').userId, 'USER_with-hyphen');
      assert.equal(app.memory.removeMember('group:GROUP_with-hyphen', 'USER_with-hyphen'), true);
    }
    process.send({ id: message.id, ok: true, ...(message.action === 'snapshot' ? { sent } : {}) });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
process.on('SIGTERM', async () => { await app.stop(); process.exit(0); });
