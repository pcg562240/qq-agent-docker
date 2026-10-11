// Tencent's public connector uses the same Portal bind task flow as QwenPaw.
// Keep its AES key / AppSecret in the backend; never return credentials to UI.
import { randomBytes } from 'node:crypto';
import { startQrConnect } from '@tencent-connect/qqbot-connector';
import QRCode from 'qrcode';

const PENDING = new Set(['creating', 'waiting']);
const OPENID = /^[A-Za-z0-9_-]{1,256}$/;
export function loginError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

export function qqQrConfigPatch({ config, boundAppId = '', env = process.env }, credential, allowUser) {
  if (env.QQ_AGENT_DOCKER === '1' && (env.QQBOT_APP_ID || env.QQBOT_APP_SECRET)) {
    throw loginError(409, '凭据由环境变量管理。请先清空 .env 的 QQBOT_APP_ID / QQBOT_APP_SECRET 并重新创建容器，再扫码绑定。');
  }
  for (const existing of [boundAppId, config.qqbot?.appId]) {
    if (existing && String(existing) !== credential.appId) {
      throw loginError(409, '扫码机器人与当前配置或数据卷绑定的 AppID 不同，已保留原配置。请选择原机器人；新机器人请使用独立数据卷。');
    }
  }
  const patch = { qqbot: { appId: credential.appId, clientSecret: credential.appSecret, enabled: true, authSource: 'qr' } };
  if (allowUser && credential.userOpenid) {
    patch.allow = { private: [...new Set([...(config.allow?.private || []), credential.userOpenid])] };
  }
  return patch;
}

export class QQQrLogin {
  #session;
  #lastStart = -Infinity;
  constructor({ connect = startQrConnect, render = url => QRCode.toDataURL(url, {
    width: 320, margin: 4, errorCorrectionLevel: 'M',
  }), now = Date.now, ttl = 5 * 60_000 } = {}) {
    Object.assign(this, { connect, render, now, ttl });
  }
  #current(s) { return this.#session === s && PENDING.has(s.status); }
  #dispose(s) {
    const dispose = s.dispose; s.dispose = null;
    try { dispose?.(); } catch { /* No SDK errors or payloads in logs. */ }
  }
  #finish(s, status, error = '') {
    s.status = status; s.error = error; s.credentials = []; s.qrImage = ''; s.revision++;
    clearTimeout(s.timer); this.#dispose(s);
  }
  #get(id) {
    const s = this.#session;
    if (typeof id !== 'string' || !s || s.id !== id) throw loginError(404, '扫码会话已失效，请重新生成二维码。');
    if (this.now() >= s.expiresAt && (PENDING.has(s.status) || s.status === 'authorized')) this.#finish(s, 'expired');
    return s;
  }
  start() {
    if (this.now() - this.#lastStart < 5000) throw loginError(429, '生成二维码过于频繁，请稍后再试。');
    this.#lastStart = this.now();
    this.close();
    const s = { id: randomBytes(24).toString('hex'), status: 'creating', error: '',
      expiresAt: this.now() + this.ttl, credentials: [], qrImage: '', dispose: null, revision: 0 };
    this.#session = s;
    s.timer = setTimeout(() => this.#finish(s, 'expired'), this.ttl); s.timer.unref?.();
    const fail = () => { if (this.#current(s)) this.#finish(s, 'failed', 'QQ 扫码授权失败，请检查到 q.qq.com 的网络后重试。'); };
    try {
      const dispose = this.connect({
        onQrDisplayed: url => {
          if (!this.#current(s)) return;
          const revision = ++s.revision;
          try {
            const u = new URL(url);
            if (u.origin !== 'https://q.qq.com' || u.pathname !== '/qqbot/openclaw/connect.html'
              || u.username || u.password || !u.searchParams.get('task_id') || url.length > 4096) throw new Error('Unexpected QR URL');
          } catch { fail(); return; }
          // Render locally; never send the binding URL to a third-party QR service.
          Promise.resolve().then(() => this.render(url)).then(qrImage => {
            if (this.#current(s) && s.revision === revision) { s.qrImage = qrImage; s.status = 'waiting'; }
          }).catch(() => { if (s.revision === revision) fail(); });
        },
        onQrExpired: () => { if (this.#current(s)) { s.revision++; s.qrImage = ''; s.status = 'creating'; } },
        onSuccess: credentials => {
          if (!this.#current(s)) return;
          if (!Array.isArray(credentials) || !credentials.length || credentials.length > 20
            || credentials.some(c => !c || typeof c.appId !== 'string' || !/^\d{1,32}$/.test(c.appId)
              || typeof c.appSecret !== 'string' || !c.appSecret.trim() || c.appSecret.length > 4096)
            || new Set(credentials.map(c => c.appId)).size !== credentials.length) { fail(); return; }
          s.credentials = credentials.map(c => ({ appId: c.appId, appSecret: c.appSecret,
            ...(typeof c.userOpenid === 'string' && OPENID.test(c.userOpenid) ? { userOpenid: c.userOpenid } : {}) }));
          s.status = 'authorized'; s.qrImage = ''; this.#dispose(s);
        },
        onFailure: fail,
      }, { source: 'qq-agent', displayQrCodeToConsole: false });
      s.dispose = dispose;
      if (!this.#current(s)) this.#dispose(s); // Synchronous test callbacks / early completion.
    } catch { fail(); }
    return this.status(s.id);
  }
  status(id) {
    const s = this.#get(id);
    return { id: s.id, status: s.status, expiresAt: s.expiresAt, qrImage: s.qrImage, error: s.error,
      accounts: s.credentials.map(c => ({ appId: c.appId, hasScanUser: Boolean(c.userOpenid) })) };
  }
  apply(id, appId, save) {
    const s = this.#get(id);
    if (s.status !== 'authorized') throw loginError(409, '请先完成手机 QQ 扫码授权。');
    const credential = s.credentials.find(c => c.appId === appId);
    if (!credential) throw loginError(400, '请选择本次扫码返回的机器人。');
    // Validation + config write are synchronous, so cancel/new QR cannot race a save.
    save(credential);
    this.#finish(s, 'applied');
    return { ok: true, appId, status: 'applied' };
  }
  cancel(id) { const s = this.#get(id); this.#finish(s, 'cancelled'); return { ok: true }; }
  close() { if (this.#session) this.#finish(this.#session, 'cancelled'); this.#session = null; }
}
