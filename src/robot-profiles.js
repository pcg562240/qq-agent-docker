// Docker QQ profiles. Each process owns exactly one immutable data directory.
// Switching starts a fresh process, never retargets live caches/timers in place.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MODEL_KEYS = ['api', 'providers', 'dshProviderKeys', 'providersSourceYaml', 'providersImported'];
const ID = /^\d{1,32}$/;
const KEY = /^(?:\d{1,32}|setup)$/;
export const profileError = message => Object.assign(new Error(message), { expose: true, status: 409 });
export function readJson(file, fallback) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw profileError('配置文件不能是符号链接。');
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    // JSON SyntaxError messages can contain a fragment of a secret.
    if (e instanceof SyntaxError) throw profileError('配置 JSON 损坏，已保留原文件，请从备份恢复。');
    throw e;
  }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export function sharedModels(config) {
  return Object.fromEntries(MODEL_KEYS.filter(k => Object.hasOwn(config, k)).map(k => [k, structuredClone(config[k])]));
}
export function privateConfig(config) {
  const result = structuredClone(config);
  for (const k of MODEL_KEYS) delete result[k];
  return result;
}
export function profileDir(root, id) {
  if (typeof id !== 'string' || !KEY.test(id)) throw profileError('无效的机器人标识。');
  const dir = path.join(root, 'robots', id);
  for (const p of [path.join(root, 'robots'), dir]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw profileError('机器人目录不能是符号链接。');
  }
  return dir;
}
function catalog(root) {
  const data = readJson(path.join(root, 'robot-profiles.json'));
  if (!data || data.version !== 1 || typeof data.active !== 'string' || !KEY.test(data.active) || !Array.isArray(data.accounts)
    || data.accounts.some(a => !a || typeof a.id !== 'string' || !KEY.test(a.id) || typeof a.name !== 'string')
    || !data.accounts.some(a => a.id === data.active)
    || new Set(data.accounts.map(a => a.id)).size !== data.accounts.length) throw profileError('机器人目录索引损坏，请从备份恢复。');
  const archived = data.archivedAccounts ?? [];
  if (!Array.isArray(archived) || archived.some(a => !a || typeof a.id !== 'string' || !ID.test(a.id)
    || typeof a.name !== 'string' || typeof a.deletedAt !== 'string' || data.accounts.some(b => b.id === a.id))
    || new Set(archived.map(a => a.id)).size !== archived.length) throw profileError('机器人保留数据索引损坏，请从备份恢复。');
  return data;
}
function validateProfile(root, id) {
  const dir = profileDir(root, id);
  const cfg = readJson(path.join(dir, 'config.json'));
  if (fs.existsSync(path.join(dir, 'qqbot')) && fs.lstatSync(path.join(dir, 'qqbot')).isSymbolicLink()) throw profileError('机器人身份目录不能是符号链接。');
  const bound = readJson(path.join(dir, 'qqbot', 'account.json'), null);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || (id === 'setup' ? Boolean(cfg.qqbot?.appId) : cfg.qqbot?.appId !== id)
    || (bound && bound.appId !== id)) throw profileError('机器人配置与数据目录身份不一致，已阻止加载。');
  return cfg;
}

function checkTree(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw profileError('旧数据包含链接或特殊文件，已保留原数据；请先整理后迁移。');
  if (stat.isDirectory()) for (const name of fs.readdirSync(file)) checkTree(path.join(file, name));
}

// Called BEFORE importing config.js, while no old worker is running.
export function prepareRobotProfiles(root, env = process.env) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const index = path.join(root, 'robot-profiles.json');
  // Resume only a fully staged, verifiable migration. Never overwrite an
  // unregistered directory: it may contain valuable data from a failed import.
  const pendingFile = path.join(root, 'profile-migration.json');
  if (!fs.existsSync(index) && fs.existsSync(pendingFile)) {
    const pending = readJson(pendingFile);
    validateProfile(root, pending.active);
    readJson(path.join(root, 'shared-models.json'));
    writeJson(index, pending);
  }
  if (!fs.existsSync(index)) {
    const old = readJson(path.join(root, 'config.json'), {});
    const bound = readJson(path.join(root, 'qqbot', 'account.json'), null);
    const id = String(env.QQBOT_APP_ID || old.qqbot?.appId || bound?.appId || 'setup');
    if (!KEY.test(id) || (bound && bound.appId !== id) || (old.qqbot?.appId && old.qqbot.appId !== id)) throw profileError('旧配置与机器人身份记录不一致，迁移未执行。');
    const dir = profileDir(root, id);
    if (fs.existsSync(dir) || fs.existsSync(path.join(root, 'shared-models.json'))) throw profileError('检测到未完成的迁移数据，已停止以保留文件，请检查备份后恢复。');
    const excluded = new Set(['robots', 'robot-profiles.json', 'profile-migration.json', 'shared-models.json', 'legacy-backups', 'qq-agent.lock', 'instance.lock']);
    const entries = fs.readdirSync(root).filter(n => !excluded.has(n));
    for (const n of entries) checkTree(path.join(root, n));
    const backup = path.join(root, 'legacy-backups', `before-profiles-${randomUUID()}`);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const n of entries) fs.cpSync(path.join(root, n), path.join(backup, n), { recursive: true, errorOnExist: true, force: false });
    // Keep legacy files untouched as well. Commit the catalog last.
    fs.cpSync(backup, dir, { recursive: true, force: false, errorOnExist: true });
    writeJson(path.join(dir, 'config.json'), privateConfig({ ...old, qqbot: { ...old.qqbot,
      appId: id === 'setup' ? '' : id, ...(id === 'setup' ? { enabled: false } : {}) } }));
    writeJson(path.join(root, 'shared-models.json'), sharedModels(old));
    const initial = { version: 1, active: id, accounts: [{ id, name: id === 'setup' ? '未配置' : `QQ ${id}` }], migrationBackup: path.relative(root, backup) };
    writeJson(pendingFile, initial);
    writeJson(index, initial);
  }
  const data = catalog(root);
  validateProfile(root, data.active);
  fs.rmSync(pendingFile, { force: true });
  if (env.QQBOT_APP_ID && data.active !== env.QQBOT_APP_ID) throw profileError('环境 AppID 与已选机器人不一致；请清空 QQBOT_APP_ID / QQBOT_APP_SECRET 后再启动。');
  return { id: data.active, dir: profileDir(root, data.active), root };
}

export class RobotProfiles {
  constructor({ root, active, env = process.env }) { Object.assign(this, { root, active, env }); }
  assertWritable() {
    if (this.env.QQBOT_APP_ID || this.env.QQBOT_APP_SECRET) throw profileError('凭据由环境变量管理。请清空 QQBOT_APP_ID / QQBOT_APP_SECRET 并重建容器后管理多个机器人。');
    if (catalog(this.root).active !== this.active) throw profileError('正在切换机器人，请等待并刷新页面。');
  }
  list() {
    const data = catalog(this.root);
    return { enabled: true, active: this.active, environmentManaged: Boolean(this.env.QQBOT_APP_ID || this.env.QQBOT_APP_SECRET),
      archivedAccounts: (data.archivedAccounts || []).map(a => ({ id: a.id, name: a.name, deletedAt: a.deletedAt })),
      accounts: data.accounts.filter(a => a.id !== 'setup').map(a => ({ id: a.id, name: a.name,
        active: a.id === this.active, hasSecret: Boolean(validateProfile(this.root, a.id).qqbot?.clientSecret) })) };
  }
  save({ appId, appSecret, name, userOpenid, authSource = 'manual' }) {
    this.assertWritable();
    if (typeof appId !== 'string' || !ID.test(appId)) throw profileError('AppID 应为 1–32 位数字。');
    if (typeof name !== 'undefined' && (typeof name !== 'string' || name.length > 80 || /[\x00-\x1f]/.test(name))) throw profileError('名称应为不超过 80 字的文字。');
    if (appSecret !== undefined && (typeof appSecret !== 'string' || appSecret.length > 4096)) throw profileError('AppSecret 格式不正确。');
    const data = catalog(this.root), exists = data.accounts.some(a => a.id === appId);
    const archived = (data.archivedAccounts || []).find(a => a.id === appId);
    if (appId === this.active) throw profileError('当前机器人请在原凭据设置中更新；无需新增。');
    if (!exists && !archived && !appSecret?.trim()) throw profileError('新增机器人需要 AppSecret，或使用 QQ 扫码授权。');
    if (!exists && data.accounts.length >= 50) throw profileError('每个实例最多保存 50 个机器人配置。');
    const dir = profileDir(this.root, appId);
    if (!exists && !archived && fs.existsSync(dir)) throw profileError('该 AppID 已有未登记的数据目录，已保留文件，请检查后再添加。');
    // Only config is created for a new identity: no OpenIDs, memories, reminders,
    // transcripts, tools/persona overrides, or old SDK sessions are copied.
    const cfg = exists || archived ? validateProfile(this.root, appId) : { qqbot: { appId, requireMention: true }, allow: { private: [], groups: [] }, allowAllWhenEmpty: false };
    cfg.qqbot = { ...cfg.qqbot,
      ...(appSecret?.trim() ? { enabled: true, authSource, clientSecret: appSecret.trim() } : {}) };
    if (userOpenid && /^[A-Za-z0-9_-]{1,256}$/.test(userOpenid)) cfg.allow = { ...cfg.allow, private: [...new Set([...(cfg.allow?.private || []), userOpenid])] };
    writeJson(path.join(dir, 'config.json'), privateConfig(cfg));
    const existing = data.accounts.find(a => a.id === appId);
    if (existing) { if (name?.trim()) existing.name = name.trim(); }
    else data.accounts.push({ id: appId, name: name?.trim() || archived?.name || `QQ ${appId}` });
    if (archived) data.archivedAccounts = data.archivedAccounts.filter(a => a.id !== appId);
    writeJson(path.join(this.root, 'robot-profiles.json'), data);
    return appId;
  }
  remove({ appId, confirmAppId }) {
    this.assertWritable();
    if (typeof appId !== 'string' || !ID.test(appId)) throw profileError('请选择有效的机器人 AppID。');
    if (confirmAppId !== appId) throw profileError('确认 AppID 不一致，未删除机器人。');
    const data = catalog(this.root);
    const account = data.accounts.find(a => a.id === appId);
    if (!account) throw profileError('机器人不存在或已经删除，请刷新列表。');
    validateProfile(this.root, appId);
    const switching = appId === this.active;
    if (switching) {
      // Never retarget the running worker or copy the deleted bot's identity to
      // setup. The caller closes ingress and restarts after the catalog commit.
      const setup = profileDir(this.root, 'setup');
      if (fs.existsSync(setup)) validateProfile(this.root, 'setup');
      else writeJson(path.join(setup, 'config.json'), { qqbot: { appId: '', enabled: false, requireMention: true },
        allow: { private: [], groups: [] }, allowAllWhenEmpty: false });
      if (!data.accounts.some(a => a.id === 'setup')) data.accounts.push({ id: 'setup', name: '未配置' });
      data.active = 'setup';
    }
    // Logical deletion, not a filesystem purge: an atomic catalog update is
    // crash-safe even if the old worker is still flushing its own data. Retain
    // credentials/history in the original private directory for explicit re-add.
    data.accounts = data.accounts.filter(a => a.id !== appId);
    data.archivedAccounts = [...(data.archivedAccounts || []), { id: appId, name: account.name, deletedAt: new Date().toISOString() }];
    writeJson(path.join(this.root, 'robot-profiles.json'), data);
    return { appId, switching, dataRetained: true };
  }
  select(id) {
    this.assertWritable();
    const data = catalog(this.root);
    if (!data.accounts.some(a => a.id === id) || id === 'setup') throw profileError('请选择已保存的机器人。');
    validateProfile(this.root, id);
    if (id === this.active) return false;
    data.active = id;
    writeJson(path.join(this.root, 'robot-profiles.json'), data);
    return true;
  }
}
