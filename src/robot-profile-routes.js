import { profileError } from './robot-profiles.js';

export function createRobotProfileRoutes({ profiles, readBody, switchRobot, deleteRobot, context }) {
  return [
    { method: 'GET', pattern: '/api/robots', handler: async ({ res, json }) =>
      json(res, 200, profiles ? { ...profiles.list(), context } : { enabled: false }) },
    { method: 'POST', pattern: '/api/robots/delete', handler: async ({ req, res, json }) => {
      if (!profiles) throw profileError('多机器人管理需要 Docker QQ 通道。');
      const body = await readBody(req, { maxBytes: 8192 });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw profileError('无效的删除请求。');
      return json(res, 200, { ok: true, ...deleteRobot({ appId: body.appId, confirmAppId: body.confirmAppId }, res) });
    } },
    ...['save', 'switch'].map(action => ({
      method: 'POST', pattern: `/api/robots/${action}`,
      handler: async ({ req, res, json }) => {
        if (!profiles) throw profileError('多机器人管理需要 Docker QQ 通道。');
        const body = await readBody(req, { maxBytes: 8192 });
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw profileError('无效的机器人配置。');
        profiles.assertWritable();
        const id = action === 'save' ? profiles.save({ appId: body.appId, appSecret: body.appSecret, name: body.name }) : body.appId;
        const switching = (action === 'switch' || body.activate === true) ? switchRobot(id, res) : false;
        return json(res, 200, { ok: true, appId: id, switching });
      },
    })),
  ];
}
