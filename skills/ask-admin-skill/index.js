// Explicit, auditable admin request/answer loop. No sends from hooks.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { memberId, requesterId, appendContext } from '../../src/extension-context.js';
let cfg = () => ({});
const file = () => path.join(DATA_DIR, 'ask-admin', 'internal-knowledge.json');
function read() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); if (!Array.isArray(j.knowledge)) throw Error('知识文件格式错误'); return j.knowledge; }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function write(items) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, knowledge: items.slice(-200) }), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
function admin() { return memberId(cfg().adminUserId); }
function answer(id, text, who) {
  if (!admin() || who !== admin()) throw Error('仅配置的管理员可答复');
  const items = read(), item = items.find(k => k.id === id);
  if (!item || !['pending', 'sending', 'unknown'].includes(item.status)) throw Error('没有待答复的问题');
  const body = String(text || '').trim().slice(0, 1000);
  if (!body) throw Error('答案不能为空');
  item.answer = body; item.status = 'answered'; item.answeredAt = new Date().toISOString();
  write(items); return item;
}
export function setup(api) {
  cfg = api.config;
  api.registerTool({
    id: 'ask_admin', name: '求教管理员', category: 'system', defaultEnabled: false,
    description: '用户明确需要求教时，将必要的问题摘要私发给已配置管理员；发送失败或结果未知不自动重试，不声称已通知。',
    parameters: { type: 'object', properties: { question: { type: 'string', description: '问题摘要，不附聊天记录或隐私信息' } }, required: ['question'] },
    async execute(ctx, args) {
      try {
        const uid = admin(), host = getConfig();
        if (!uid || !(host.allow?.private || []).map(String).includes(uid) || (host.deny?.private || []).map(String).includes(uid)) throw Error('请在技能设置填写管理员完整 ID，并加入可用私聊名单');
        const q = String(args?.question || '').trim().slice(0, 300);
        if (!q || !ctx.chatKey) throw Error('问题或当前会话为空');
        const items = read();
        const old = items.find(k => k.chatKey === ctx.chatKey && k.question === q && k.status !== 'answered');
        if (old) return { content: `问题 ${old.id} 已记录，状态 ${old.status}；不要重复通知。`, isError: old.status !== 'pending' };
        const item = { id: 'k' + randomUUID(), question: q, answer: null, status: 'sending', chatKey: ctx.chatKey, at: new Date().toISOString() };
        items.push(item); write(items); // before enqueue: crash/timeout must not cause a blind resend
        try {
          await ctx.sender.sendTextBatch(`private:${uid}`, [`待求教 ${item.id}\n${q}\n答复格式：答复 ${item.id} 答案`]);
          item.status = 'pending'; write(items);
        } catch { item.status = 'unknown'; write(items); return { content: `问题 ${item.id} 已记录，但通知未确认。请检查管理员私聊/平台主动消息权限；不会自动补发。`, isError: true }; }
        return { content: `已通知管理员，问题编号 ${item.id}。等待答复，不编造答案。` };
      } catch (e) { return { content: `求教失败：${e.message}`, isError: true }; }
    }
  });
  api.registerTool({
    id: 'answer_admin', name: '答复求教', category: 'system',
    description: '配置的管理员在私聊中明确答复一个问题时使用；原群只会读取该群的问题答案。',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '完整问题编号' }, answer: { type: 'string', description: '管理员给出的答案' } }, required: ['id', 'answer'] },
    async execute(ctx, args) { try { if (ctx.kind !== 'private') throw Error('请在管理员私聊答复'); answer(args.id, args.answer, requesterId(ctx)); return { content: '答案已保存到原会话知识库。' }; } catch (e) { return { content: e.message, isError: true }; } }
  });
  api.registerTool({
    id: 'internal_knowledge', name: '查内部知识', category: 'knowledge',
    description: '查询当前会话中管理员已经答复过的内部知识，不读取其他群的答案。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '关键词' } }, required: ['query'] },
    async execute(ctx, args) {
      try { const q = String(args?.query || '').trim().toLowerCase(); if (!q) throw Error('请输入关键词');
        const rows = read().filter(k => k.chatKey === ctx.chatKey && k.status === 'answered' && `${k.question} ${k.answer}`.toLowerCase().includes(q));
        return { content: JSON.stringify(rows.slice(-10).map(({ question, answer }) => ({ question, answer }))) };
      } catch (e) { return { content: e.message, isError: true }; }
    }
  });
}
const pending = new Map();
export const hooks = {
  'before-context'(ctx) {
    // Only an exact syntax from the configured private peer is accepted, never quoted text.
    if (ctx.kind === 'private' && String(ctx.chatId) === admin()) {
      for (const e of ctx.triggerEntries || []) {
        if (e.self || String(e.senderId) !== admin()) continue;
        const m = String(e.text || '').match(/^答复\s+(k[\da-f-]{36})\s+([\s\S]+)$/i);
        if (m) answer(m[1], m[2], admin());
      }
    }
    const q = (ctx.triggerEntries || []).map(e => e.text || '').join(' ');
    const rows = read().filter(k => k.chatKey === ctx.chatKey && k.status === 'answered' && (q.includes(k.question) || k.question.includes(q.trim()) && q.trim().length >= 2));
    const key = ctx.sessionId || ctx.chatKey; pending.delete(key);
    if (rows.length) { if (pending.size >= 100) pending.delete(pending.keys().next().value); pending.set(key, JSON.stringify(rows.slice(-3).map(({question, answer}) => ({question, answer})))); }
  },
  'before-llm-messages'(ctx) { const key = ctx.sessionId || ctx.chatKey; const text = pending.get(key); pending.delete(key); appendContext(ctx.messages, '管理员已答复', text); }
};
export function deactivate() { pending.clear(); }
export function dispose() { pending.clear(); }
