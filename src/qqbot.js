// Official QQ channel. Compatibility facade for the existing agent, NOT a
// general-purpose OneBot server. One bot identity per profile data directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { QQBot, FileKVStore, kvSessionPersistence } from '@tencent-connect/qqbot-nodejs';
import { safeFetchBinary } from './safe-fetch.js';
import { qqAttachmentSegments, qqMessageQuote, enrichQQQuote } from './qqbot-quotes.js';

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_IMAGE = 20 * 1024 * 1024;
const REPLY_TTL = 4 * 60_000; // Conservative local reply-anchor retention, not a platform quota.
const LIMIT = 2000;
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function entity(value) {
  const id = String(value || '');
  if (!ID.test(id)) throw new Error('无效的 QQ OpenID');
  return id;
}
function boundedSet(map, key, value) {
  map.delete(key); map.set(key, value);
  while (map.size > LIMIT) map.delete(map.keys().next().value);
}

export function normalizeQQMessage(msg, { appId = '', selfId = '' } = {}) {
  if (!['c2c', 'group'].includes(msg.kind)) return null;
  const user = entity(msg.senderId);
  const group = msg.kind === 'group' ? entity(msg.groupOpenid) : null;
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  const selfMentions = mentions.filter(m => m?.is_you === true);
  const selfIds = new Set([appId, selfId, ...selfMentions.flatMap(m => [m.id, m.user_openid, m.member_openid])]
    .filter(id => typeof id === 'string' && ID.test(id)));
  const raw = String(msg.content || '');
  // Match the SDK mention-gate semantics: ordinary GROUP_MESSAGE_CREATE can
  // also carry a server-marked @bot. Never treat @all or another bot as self.
  const explicitAtEvent = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE';
  const atMe = Boolean(group) && (explicitAtEvent || selfMentions.length > 0
    || [...selfIds].some(id => raw.includes(`<@${id}>`) || raw.includes(`<@!${id}>`)));
  const content = atMe ? raw.replace(/^\s*<@!?([^>]+)>\s*/, (full, id) =>
    selfIds.has(id) || (explicitAtEvent && selfIds.size === 0) ? '' : full) : raw;
  const segments = content.trim() ? [{ type: 'text', data: { text: content } }] : [];
  segments.push(...qqAttachmentSegments(msg.attachments));
  const officialReply = qqMessageQuote(msg);
  // A bare @ is a real wake-up signal, not an empty event to silently drop.
  if (atMe && !segments.length) segments.push({ type: 'text', data: { text: '[用户 @ 了机器人]' } });
  return {
    post_type: 'message', message_type: group ? 'group' : 'private',
    user_id: user, ...(group ? { group_id: group } : {}),
    message_id: String(msg.messageId || ''),
    time: (Date.parse(msg.timestamp) || Date.now()) / 1000,
    sender: { user_id: user, nickname: String(msg.senderName || user) },
    message: segments, raw_message: content, officialAtMe: atMe, officialReply,
  };
}

export class QQBotClient {
  constructor({ getOptions, dataDir, onEvent, allow = () => false,
    log = console.log, Bot = QQBot, now = Date.now }) {
    Object.assign(this, { getOptions, dataDir, onEvent, allow, log, Bot, now });
    this.kind = 'qqbot';
    this.connected = false; this.everConnected = false; this.lastConnectError = '';
    this.statusListeners = new Set(); this.selfInfo = null;
    this.directory = path.join(dataDir, 'qqbot');
    this.peers = new Map(read(path.join(this.directory, 'peers.json'), []));
    this.seen = new Map(read(path.join(this.directory, 'seen.json'), []));
    this.messages = new Map(); this.anchors = new Map(); this.referenceIndex = new Map();
    this.replyContexts = new AsyncLocalStorage();
    this.replyRoutes = new WeakSet();
    this.generation = 0; this.queue = Promise.resolve(); this.closed = true;
    this.supports = { text: true, image: true, groupAt: true, groupAll: true,
      voice: false, video: false, file: false, poke: false, forward: false };
  }
  get selfId() { return String(this.selfInfo?.user_id || this.getOptions().appId || ''); }
  get selfNickname() { return this.selfInfo?.nickname || 'QQ 官方机器人'; }
  onStatus(fn) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  status() {
    const cfg = this.getOptions();
    return { type: this.kind, configured: Boolean(cfg.appId && cfg.clientSecret),
      enabled: cfg.enabled !== false, connected: this.connected, everConnected: this.everConnected,
      error: this.lastConnectError, appId: String(cfg.appId || ''), capabilities: this.supports,
      hint: /接口访问源IP不在白名单|40023002|11298/i.test(this.lastConnectError)
        ? '腾讯对当前凭据返回了源 IP 白名单错误。龙虾机器人请先用下方 QQ 扫码授权核对绑定；不要直接套用传统开发者机器人的审批流程。若该应用确实启用了 IP 白名单，再核对 QQ 接口实际使用的公网出口 IP（不是局域网 IP 或聊天白名单）。' : '',
      peers: [...this.peers.values()] };
  }
  setStatus(connected, error = '') {
    this.connected = connected; this.everConnected ||= connected;
    const nextError = this.redact(error);
    // SDK's final retry message should not hide the actionable platform cause.
    const keepCause = /接口访问源IP不在白名单|40023002|11298/i.test(this.lastConnectError)
      && /Max reconnect attempts reached|连接已结束，等待重连/i.test(nextError);
    if (connected) this.lastConnectError = '';
    else if (!keepCause) this.lastConnectError = nextError;
    for (const fn of this.statusListeners) fn(this.status());
  }
  redact(value) {
    let text = String(value || '');
    const secret = this.getOptions().clientSecret;
    if (secret) text = text.split(secret).join('[REDACTED]');
    return text.replace(/QQBot\s+[A-Za-z0-9._-]+/g, 'QQBot [REDACTED]')
      .replace(/(access_token["'\s:=]+)[^\s,"'}]+/gi, '$1[REDACTED]').slice(0, 500);
  }
  assertAccount(appId) {
    const file = path.join(this.directory, 'account.json');
    const bound = read(file, null);
    if (bound && bound.appId !== appId) throw new Error('此数据卷已绑定其他 AppID。更换机器人请使用新的数据卷，以免串号或串记忆。');
    if (!bound) write(file, { appId });
  }
  async connect() {
    this.close();
    this.closed = false;
    const cfg = this.getOptions();
    if (cfg.enabled === false) { this.setStatus(false, '官方 QQ 通道已暂停'); return; }
    if (!cfg.appId || !cfg.clientSecret) { this.setStatus(false, '请先在连接设置填写 AppID 和 AppSecret'); return; }
    try {
      if (!/^\d+$/.test(String(cfg.appId))) throw new Error('AppID 应为数字字符串');
      this.assertAccount(String(cfg.appId));
    } catch (error) { this.setStatus(false, error.message); return; }
    this.attempt = 0;
    this.run(this.generation);
  }
  async reconnect() { return this.connect(); }
  run(generation) {
    if (this.closed || generation !== this.generation) return;
    const cfg = this.getOptions();
    const current = () => !this.closed && generation === this.generation && this.bot === bot;
    const bot = new this.Bot({
      appId: String(cfg.appId), appSecret: cfg.clientSecret, accountId: String(cfg.appId),
      markdownSupport: cfg.markdown === true, intents: 1 << 25, transport: 'websocket',
      sessionPersistence: kvSessionPersistence({
        store: new FileKVStore({ dir: this.directory, fileName: 'session.json' }),
        accountId: String(cfg.appId),
      }),
      logger: { debug() {}, info: v => {
        if (current() && String(v).includes('WebSocket closed:')) this.setStatus(false, '连接中断，SDK 正在重连');
      }, warn: v => {
        if (current()) this.log('[qqbot]', this.redact(v));
      }, error: v => { if (current()) this.setStatus(false, v); } },
    });
    this.bot = bot;
    bot.on('ready', data => {
      if (!current()) return;
      this.selfInfo = { user_id: String(data?.user?.id || cfg.appId), nickname: data?.user?.username || 'QQ 官方机器人' };
      this.attempt = 0; this.setStatus(true);
    });
    bot.on('resumed', () => { if (current()) { this.attempt = 0; this.setStatus(true); } });
    bot.on('error', error => { if (current()) this.setStatus(false, error.message); });
    bot.on('message', (_ctx, msg) => {
      this.queue = this.queue.then(() => current() ? this.receive(msg) : undefined)
        .catch(error => this.log('[qqbot] 收件处理失败：', this.redact(error.message)));
      return this.queue;
    });
    // SDK start() lives until shutdown: do not await it in the HTTP startup path.
    Promise.resolve().then(() => bot.start()).catch(error => {
      if (current()) this.setStatus(false, error.message);
    }).finally(() => {
      bot.stop();
      if (!current()) return;
      this.setStatus(false, this.lastConnectError || '连接已结束，等待重连');
      const delay = Math.min(60_000, 3000 * 2 ** Math.min(this.attempt++, 5));
      this.retry = setTimeout(() => this.run(generation), delay);
      this.retry.unref?.();
    });
  }
  close() {
    this.closed = true; this.generation++;
    clearTimeout(this.retry);
    this.bot?.stop(); this.bot = null;
    this.setStatus(false);
  }
  async receive(msg) {
    const event = normalizeQQMessage(msg, { appId: this.getOptions().appId, selfId: this.selfId });
    if (!event || !event.message_id || msg.senderIsBot) return;
    const kind = event.message_type;
    const id = kind === 'group' ? event.group_id : event.user_id;
    const key = `${kind}:${id}`;
    const dedup = `${key}:${event.message_id}`;
    if (this.seen.has(dedup)) return;
    // Persist only routing diagnostics, never bodies or sender identities from
    // non-allowlisted group messages. "forwarded" is not a promise of a reply.
    const peer = { key, kind, id, name: kind === 'private' ? event.sender.nickname : id,
      lastSeenAt: this.now(), lastEventType: /^[A-Z_]{1,64}$/.test(msg.rawEventType || '') ? msg.rawEventType : 'UNKNOWN',
      lastAtMe: event.officialAtMe, lastIngress: 'received' };
    const record = reason => {
      peer.lastIngress = reason; boundedSet(this.peers, key, peer);
      write(path.join(this.directory, 'peers.json'), [...this.peers]);
    };
    if (!this.allow(kind, id)) { record('not_allowed'); return; }
    if (kind === 'group' && this.getOptions().requireMention !== false && !event.officialAtMe) { record('not_mentioned'); return; }
    if (event.officialReply) {
      const refKey = event.officialReply.refKey;
      const mid = this.referenceIndex.get(`${key}\0${refKey}`) || refKey;
      const ref = this.messages.get(mid);
      if (ref?.key === key) event.officialReply = enrichQQQuote(event.officialReply, ref);
      peer.lastQuoteSource = event.officialReply.source;
      peer.lastQuotedImageCount = event.officialReply.media.length;
    }
    record('processing');
    boundedSet(this.messages, event.message_id, { ...event, key, receivedAt: this.now() });
    if (msg.msgIdx) boundedSet(this.referenceIndex, `${key}\0${msg.msgIdx}`, event.message_id);
    boundedSet(this.anchors, key, { msgId: event.message_id, at: this.now() });
    try { await this.onEvent(event); record('forwarded'); }
    catch (error) { record('error'); throw error; }
    boundedSet(this.seen, dedup, this.now());
    write(path.join(this.directory, 'seen.json'), [...this.seen]);
  }
  // One immutable inbound snapshot per agent run. AsyncLocalStorage also covers
  // skill/provider sends without changing their API or sharing a mutable target
  // between concurrently running chats. New ingress must never update this list.
  withReplyContext(chatKey, triggerEntries, fn) {
    const entries = (triggerEntries || []).filter(m => !m.self).map(m => {
      const msgId = String(m.mid ?? '');
      const ref = this.messages.get(msgId);
      return Object.freeze({ msgId, userId: String(m.senderId ?? ''),
        at: ref?.key === chatKey ? ref.receivedAt : NaN });
    });
    return this.replyContexts.run(Object.freeze({ chatKey, entries: Object.freeze(entries) }), fn);
  }
  // Prompt rows display #<messageId>. Models sometimes copy that marker too.
  // Remove ONE display marker only when the full remainder is an exact cached
  // message in this chat. Never guess a prefix, change case or borrow another
  // sender's latest event. A genuinely hash-prefixed exact ID takes precedence.
  normalizeReplyOptions(kind, id, options = {}) {
    const raw = options.replyToMessageId;
    if (typeof raw !== 'string' || !raw.startsWith('#') || this.messages.has(raw)) return options;
    const messageId = raw.slice(1);
    if (this.messages.get(messageId)?.key !== `${kind}:${id}`) return options;
    return { ...options, replyToMessageId: messageId };
  }
  // Called BEFORE a send enters SendQueue. All bubbles/retries of that send use
  // this same route, even when the queue sleeps or somebody else @mentions us.
  captureReplyRoute(kind, id, options = {}) {
    options = this.normalizeReplyOptions(kind, id, options);
    const chatKey = `${kind}:${id}`;
    if (options.replyRoute) {
      const route = options.replyRoute;
      if (!this.replyRoutes.has(route) || route.chatKey !== chatKey) throw new Error('回复目标不属于当前会话');
      if (options.atUserId && route.userId !== String(options.atUserId)) throw new Error('@ 对象与回复对象不一致');
      return route;
    }
    const referenceId = options.replyToMessageId == null ? '' : String(options.replyToMessageId);
    const ref = referenceId ? this.messages.get(referenceId) : null;
    if (referenceId && (!ref || ref.key !== chatKey)) throw new Error('引用消息不属于当前会话或已不在缓存中');
    const atUserId = options.atUserId ? entity(options.atUserId) : '';
    const context = this.replyContexts.getStore();
    const scoped = context?.chatKey === chatKey;
    const snapshot = event => event && ({ msgId: event.message_id, userId: event.user_id, at: event.receivedAt });
    let anchor;
    if (scoped && context.entries.length) {
      // A quote of history is NOT the passive reply target: the person asking
      // about that history is the recipient. A quote of a current trigger is.
      const selected = context.entries.find(e => e.msgId === referenceId);
      if (selected && atUserId && selected.userId !== atUserId) throw new Error('@ 对象与引用的本轮提问者不一致，请分别回复');
      const candidates = atUserId ? context.entries.filter(e => e.userId === atUserId) : context.entries;
      if (!candidates.length) throw new Error('@ 对象不在本次唤醒消息中，请核对提问者 OpenID');
      if (selected) anchor = selected;
      else if (new Set(candidates.map(e => e.userId)).size === 1) anchor = candidates.at(-1);
      else throw new Error('本批有多位提问者，请用 send_message 的 replyToMessageId 指定本次唤醒中的消息，分别回复；不要把不同人的答案放在同一个数组中');
      if (!anchor.msgId || !Number.isFinite(anchor.at)) throw new Error('本轮回复消息已不在官方通道缓存中，请让原提问者重新 @；不会改回其他人的消息');
    } else if (ref) {
      anchor = snapshot(ref);
      if (atUserId && anchor.userId !== atUserId) throw new Error('@ 对象与引用的提问者不一致，请分别回复');
    } else if (atUserId) {
      anchor = snapshot([...this.messages.values()].reverse().find(e => e.key === chatKey && e.user_id === atUserId));
      if (!anchor) throw new Error('未找到该 @ 对象在当前会话的可回复消息');
    } else if (!scoped) {
      const latest = this.anchors.get(chatKey);
      // Preserve unscoped/proactive behavior, but snapshot it at enqueue time.
      if (latest && this.now() - latest.at < REPLY_TTL) {
        anchor = { ...latest, userId: this.messages.get(latest.msgId)?.user_id || '' };
      }
    }
    const route = Object.freeze({ chatKey, msgId: anchor?.msgId || null, userId: anchor?.userId || null, at: anchor?.at });
    this.replyRoutes.add(route);
    return route;
  }
  target(kind, id, options = {}) {
    if (!['private', 'group'].includes(kind)) throw new Error('首版仅支持私聊和 QQ 群');
    id = entity(id);
    if (!this.bot || !this.connected) throw new Error('QQ 官方机器人尚未连接');
    if (!this.allow(kind, id)) throw new Error('目标会话不在白名单中');
    const route = this.captureReplyRoute(kind, id, options);
    // Do not steal a newer person's reply lifecycle/quota when the original
    // one expires. Surface the failure instead of silently switching recipients.
    if (route.msgId && (!Number.isFinite(route.at) || this.now() - route.at >= REPLY_TTL)) {
      throw new Error('原提问消息的本地回复窗口已过期，请让原提问者重新 @；未切换到其他群友');
    }
    return { scope: kind === 'private' ? 'c2c' : 'group', targetId: id,
      ...(route.msgId ? { msgId: route.msgId } : {}) };
  }
  async sendText(kind, id, text, options = {}) {
    options = this.normalizeReplyOptions(kind, id, options);
    const { replyToMessageId, atUserId } = options;
    const target = this.target(kind, id, options);
    let content = String(text);
    if (atUserId && kind === 'group') content = `<@${entity(atUserId)}> ${content}`;
    let result;
    if (replyToMessageId != null && String(replyToMessageId)) {
      const ref = this.messages.get(String(replyToMessageId));
      if (!ref || ref.key !== `${kind}:${id}`) throw new Error('引用消息不属于当前会话或已不在缓存中');
      result = await this.bot.send({ target, content, messageReference: { message_id: String(replyToMessageId) } });
    } else result = await this.bot.sendText(target, content);
    return { message_id: result?.id ?? null };
  }
  async imageSource(ref) {
    const value = String(ref);
    const base64 = value.match(/^(?:base64:\/\/|data:image\/[\w.+-]+;base64,)([\s\S]+)$/);
    if (base64) {
      if (base64[1].length > Math.ceil(MAX_IMAGE * 4 / 3) + 4) throw new Error('图片超过 20 MiB');
      return { buffer: Buffer.from(base64[1], 'base64') };
    }
    if (/^https?:\/\//i.test(value)) return { buffer: (await safeFetchBinary(value, MAX_IMAGE)).buffer };
    const file = fs.realpathSync(value.startsWith('file:') ? fileURLToPath(value) : value);
    const base = fs.realpathSync(this.dataDir);
    // 梗鲸技能在自己的 tmp 子目录缓存图片；只开放该媒体子目录，
    // 不放开整个技能数据目录（其中还有 state/config 等非媒体文件）。
    const roots = ['stickers', 'sticker-images', 'media', 'downloads', 'cache', 'tmp', 'whale-memes/tmp'].map(d => path.join(base, d));
    if (!roots.some(root => file.startsWith(`${root}${path.sep}`))) throw new Error('图片本地路径应位于数据卷的媒体目录');
    if (fs.statSync(file).size > MAX_IMAGE) throw new Error('图片超过 20 MiB');
    return { buffer: fs.readFileSync(file) };
  }
  async sendImage(kind, id, ref, options = {}) {
    if (options.replyToMessageId || options.atUserId) throw new Error('首版图片不支持附带引用或 @，请另发文字');
    const target = this.target(kind, id, options);
    const result = await this.bot.sendImage(target, await this.imageSource(ref));
    if (!result?.message?.id) throw new Error('媒体已处理，但平台未返回消息 ID，请检查发送结果后再重试');
    return { message_id: result.message.id };
  }
  sendSticker(...args) { return this.sendImage(...args); }
  async sendSegments(kind, id, segments, options = {}) {
    // Validate entire batch before sending anything.
    if (!Array.isArray(segments) || segments.some(s => !['text', 'image'].includes(s.type))) {
      throw new Error('官方 QQ 通道首版仅支持文字和图片消息段');
    }
    if (segments.length !== 1) throw new Error('官方 QQ 通道请把文字和图片分别发送');
    const [seg] = segments;
    return seg.type === 'text' ? this.sendText(kind, id, seg.data.text, options)
      : this.sendImage(kind, id, seg.data.file || seg.data.url, options);
  }
  async getMsg(messageId) {
    const event = this.messages.get(String(messageId));
    if (!event) throw new Error('官方通道只可读取本进程缓存的消息');
    return event;
  }
  async getGroupInfo(id) { return { group_id: entity(id), group_name: this.peers.get(`group:${id}`)?.name || id }; }
  async getGroupMemberInfo(groupId, userId) { return { group_id: entity(groupId), user_id: entity(userId), nickname: String(userId) }; }
  async sendPoke() { throw new Error('官方 QQ 通道未实现拍一拍'); }
  async call(action, params = {}) {
    if (action === 'get_login_info') return this.selfInfo;
    if (action === 'get_msg') return this.getMsg(params.message_id);
    if (action === 'get_group_info') return this.getGroupInfo(params.group_id);
    if (action === 'get_group_member_info') return this.getGroupMemberInfo(params.group_id, params.user_id);
    if (action === 'get_group_list') return [...this.peers.values()].filter(p => p.kind === 'group')
      .map(p => ({ group_id: p.id, group_name: p.name }));
    if (action === 'get_friend_list') return [...this.peers.values()].filter(p => p.kind === 'private')
      .map(p => ({ user_id: p.id, nickname: p.name }));
    throw new Error(`官方 QQ 通道未实现 OneBot 操作：${action}`);
  }
}
