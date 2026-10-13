import { memberId } from '../../src/extension-context.js';
import { DATA_DIR, getConfig } from '../../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
// 定时文案推送 —— 移植自魔改包 crazy-thursday，去掉人设/写死品牌依赖
// 按 weekdays + times 触发：LLM 写一段文案 → sender 直发到 groupIds
// 不经过角色卡：system 里只有「写文案」指令。

import { chatCompletion } from '../../src/llm.js';

let cfg = () => ({});
let log = () => {};
let timer = null;
let active = false;
let generation = 0;
let busy = false;
const stateFile = path.join(DATA_DIR, "scheduled-announcer-attempts.json");
let senderRef = null;
const fired = new Set();

function conf() {
  const c = cfg() || {};
  return {
    enabled: c.enabled !== false,
    weekdays: (Array.isArray(c.weekdays) && c.weekdays.length ? c.weekdays : [4]).map(Number),
    times: (Array.isArray(c.times) && c.times.length ? c.times : ['07:00', '13:00', '19:00']).map(String),
    groupIds: (Array.isArray(c.groupIds) ? c.groupIds : []).map(String).filter(s => memberId(s)),
    theme: String(c.theme || '疯狂星期四 V 我 50 玩梗文案'),
    minChars: Math.max(20, Number(c.minChars) || 80),
    maxChars: Math.max(100, Number(c.maxChars) || 220)
  };
}

async function writeCopy(c) {
  const sys = [
    '你是一个写文案的助手，不是任何群友、角色或虚拟形象。',
    `任务：写一段「${c.theme}」群公告/玩梗文案。`,
    '要求：',
    `1. 中文，长度大于${c.minChars}字，小于${c.maxChars}字。`,
    '2. 口语、群聊感，像真人随手发的，不要书面腔、不要分点列提纲。',
    '3. 不要出现机器人人设、管理员、内部梗或模型名称。',
    '4. 只输出正文，不要引号包裹，不要解释，不要标题。'
  ].join('\n');
  const res = await chatCompletion({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `请按主题写一段文案（>${c.minChars}字）。` }
    ],
    temperature: 0.95,
    // 0.31：不传 overrides，走当前生效 API；返回值是 { message } 不是 choices[]
  });
  const text = String(res?.message?.content || res?.text || '')
    .replace(/^["'“”]|["'“”]$/g, '')
    .replace(/^(文案|标题)[:：]\s*/i, '')
    .replace(/^#+\s*/, '')
    .trim();
  return text.slice(0, c.maxChars);
}

function checkOnce() {
  const c = conf();
  if (!active || busy || !c.enabled || !c.groupIds.length) return;
  const now = new Date();
  if (!c.weekdays.includes(now.getDay())) return;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (!c.times.includes(hhmm)) return;
  const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const host = getConfig();
  const pending = c.groupIds.filter(gid => (host.allow?.groups || []).map(String).includes(gid) && !(host.deny?.groups || []).map(String).includes(gid)).filter((gid) => !fired.has(`${dateKey}|${hhmm}|${gid}`));
  if (!pending.length || !senderRef) return;

  busy = true;
  const epoch = generation;
  for (const gid of pending) fired.add(`${dateKey}|${hhmm}|${gid}`);
  while (fired.size > 1000) fired.delete(fired.values().next().value);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify([...fired].slice(-1000)));
    fs.renameSync(stateFile + '.tmp', stateFile);
  } catch { busy = false; return; }
  (async () => {
    let text = '';
    try {
      text = await writeCopy(c);
    } catch (e) {
      log('[scheduled-announcer] LLM 生成失败:', e?.message ?? e);
      return;
    }
    if (!text || text.length < c.minChars) {
      log('[scheduled-announcer] 文案过短跳过:', text.length);
      return;
    }
    if (epoch !== generation || !active || !conf().enabled) return;
    for (const gid of pending) {
      const host = getConfig();
      if (!(host.allow?.groups || []).map(String).includes(gid) || (host.deny?.groups || []).map(String).includes(gid)) continue;
      if (!active || epoch !== generation) return;
      const chatKey = `group:${gid}`;
      fired.add(`${dateKey}|${hhmm}|${gid}`);
      try {
        await senderRef.sendTextBatch(chatKey, text);
        log(`[scheduled-announcer] 已发 ${chatKey} (${text.length}字)`);
      } catch (e) {
        log(`[scheduled-announcer] 发送失败 ${chatKey}:`, e?.message ?? e);
      }
      // 同一分钟内多群只生成一次，已复用 text
    }
  })().catch(() => log('[scheduled-announcer] 运行失败')).finally(() => { busy = false; });
}

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);
}

export function activate(ctx) {
  active = true; generation++;
  try { for (const key of JSON.parse(fs.readFileSync(stateFile, 'utf8'))) fired.add(String(key)); } catch (e) { if (e.code !== 'ENOENT') { active = false; return; } }
  senderRef = ctx?.sender || null;
  if (timer) return;
  const tick = () => {
    timer = setTimeout(tick, 20_000);
    try {
      checkOnce();
    } catch (e) {
      log('[scheduled-announcer] tick error', e?.message ?? e);
    }
  };
  timer = setTimeout(tick, 12_000);
  log('[scheduled-announcer] 已启动定时检查');
}

export function deactivate() {
  active = false; generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  senderRef = null;
}

export const dispose = deactivate;
