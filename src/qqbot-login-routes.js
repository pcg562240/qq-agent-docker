import fs from 'node:fs';
import path from 'node:path';
import { getConfig, updateConfig, DATA_DIR } from './config.js';
import { loginError, qqQrConfigPatch } from './qqbot-login.js';

// Mounted behind the app's console authentication AND same-origin checks.
export function createQQLoginRoutes({ qqLogin, onebot, readBody, emit, profiles, switchRobot }) {
  return ['start', 'status', 'cancel', 'confirm'].map(action => ({
    method: 'POST', pattern: `/api/qq/login/${action}`,
    handler: async ({ req, res, json }) => {
      res.setHeader('cache-control', 'no-store');
      if (onebot.kind !== 'qqbot' || !getConfig().server?.token) throw loginError(409, '扫码功能需要 QQ 通道和控制台密码。');
      const body = await readBody(req, { maxBytes: 4096 });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw loginError(400, '无效的扫码请求。');
      if (action === 'start') {
        if (process.env.QQ_AGENT_DOCKER === '1' && (process.env.QQBOT_APP_ID || process.env.QQBOT_APP_SECRET)) {
          throw loginError(409, '请先清空 .env 的 QQBOT_APP_ID / QQBOT_APP_SECRET 并重新创建容器，再使用扫码授权。');
        }
        return json(res, 200, qqLogin.start());
      }
      if (action === 'status') return json(res, 200, qqLogin.status(body.id));
      if (action === 'cancel') return json(res, 200, qqLogin.cancel(body.id));
      if (profiles && body.appId !== profiles.active) {
        // Save first; switch after consuming the QR session so cancelling it
        // during shutdown cannot race the explicit credential confirmation.
        const result = qqLogin.apply(body.id, body.appId, credential => {
          profiles.save({ ...credential, authSource: 'qr', userOpenid: body.allowScanUser === true ? credential.userOpenid : undefined });
        });
        return json(res, 200, { ...result, switching: switchRobot(result.appId, res) });
      }
      let boundAppId = '';
      try {
        boundAppId = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'qqbot', 'account.json'), 'utf8')).appId;
        if (typeof boundAppId !== 'string' || !/^\d{1,32}$/.test(boundAppId)) throw new Error('Invalid account identity');
      }
      catch (error) { if (error.code !== 'ENOENT') throw loginError(409, '数据卷身份文件读取失败，已保留现有配置。'); }
      const result = qqLogin.apply(body.id, body.appId, credential => {
        const patch = qqQrConfigPatch({ config: getConfig(), boundAppId }, credential, body.allowScanUser === true);
        updateConfig(patch);
      });
      await onebot.reconnect();
      emit('status', { configUpdated: true });
      return json(res, 200, result); // Saved credentials != gateway connected.
    },
  }));
}
