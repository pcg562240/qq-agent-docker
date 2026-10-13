// Console-only aliases, scoped to the current robot. Never rename a QQ group
// or use an alias as a routing/allowlist key or model instruction.
import fs from 'node:fs';
import path from 'node:path';

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const invalid = message => Object.assign(new Error(message), { status: 400, expose: true });
export class GroupNames {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'group-names.json');
    this.names = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data)) throw new Error('group-names.json 格式错误');
      for (const [id, name] of data) { this.validate(id, name); if (name.trim()) this.names.set(id, name.trim()); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  validate(id, name) {
    if (typeof id !== 'string' || !ID.test(id)) throw invalid('群 OpenID 格式不正确');
    if (typeof name !== 'string' || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw invalid('群备注名须为不超过 80 字的单行文字');
  }
  describe(id, platformName = '') {
    const groupAlias = this.names.get(String(id)) || '';
    const original = String(platformName || '').trim();
    const name = groupAlias || (original === String(id) ? '' : original);
    return { name, groupAlias, nameSource: groupAlias ? 'local' : name ? 'platform' : 'id' };
  }
  set(id, name) {
    this.validate(id, name);
    const next = new Map(this.names);
    if (name.trim()) next.set(id, name.trim()); else next.delete(id);
    if (next.size > 2000) throw invalid('群备注数量已达上限');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify([...next]), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.names = next;
    return this.describe(id);
  }
}

export function createGroupNameRoutes({ groupNames, readBody, emit }) {
  return [{ method: 'POST', pattern: '/api/group-names', handler: async ({ req, res, json }) => {
    const body = await readBody(req, { maxBytes: 4096 });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('无效的群备注请求');
    const result = groupNames.set(body.groupId, body.name);
    emit('chat-names', { groupId: body.groupId });
    return json(res, 200, { ok: true, ...result });
  } }];
}
