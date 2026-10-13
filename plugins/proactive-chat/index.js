// proactive-chat —— 主动开场/连发窗口（宿主阶段二 12 号 burst-wake 语义照搬）
//
// 宿主来源：qq-agent-plugins/src/proactive-chat + orchestrator scheduleWake 改造。
// 核心语义：
//   1. 禁言守卫：触发条件「发送被拒且 result=120 / send group message rejected」→
//      查 get_group_member_info 拿 shut_up_timestamp → 记 mutedUntil → 本轮立刻收工 →
//      解禁前 scheduleWake/wake 直接跳过（消息沉底、不叫模型）。宿主：守卫后第一次撞上
//      只用 1 次模型调用就收工（之前 6 个会话白跑 2~8 轮）。
//   2. 自适应连发窗口：scheduleWake 改成 burstWindowSec 内连发 minGapSec 以上 → 主动接话。
//
// 本插件是「纯钩子」确定性插件：after-response（记连发节奏 / 禁言守卫）+ before-context（禁言时跳过 run）。
// 原 proactive.schedule 自建能力名核心无消费点，按 plugin-development.md §5 降级为普通导出
//   （proactiveStatus 顶层函数，供控制台/审计查询，manifest 不再声明 capabilities，避开孤儿审计）。

let cfg = () => ({});
let banStateFn = null;          // 软依赖 chat.ban-state（来自 plugins/ban-state）
let lastBurst = new Map();             // 最近连发时间戳
let mutedUntil = {};            // chatKey → 解禁时间戳
let mutedReason = {};

let api = null;

export function setup(a) {
  api = a;
  cfg = a.config;
  banStateFn = (args) => api.capability('chat.ban-state', args);   // 软依赖，缺了降级（守卫不生效但聊天正常）
  api.log('proactive-chat 已加载（禁言守卫 + 自适应连发窗口）');
}

export function available() {
  return { ok: true, reason: api?.hasCapability('chat.ban-state') ? '禁言守卫就绪' : '禁言守卫降级（chat.ban-state 缺失）' };
}

export async function activate(ctx) {
  lastBurst = new Map();
  sentCounts.clear();
  mutedUntil = {};
  mutedReason = {};
  api.log?.('proactive-chat: 已激活（连发窗口 ' + (cfg().burstWindowSec ?? 180) + 's）');
}

export async function deactivate(ctx) {
  lastBurst = new Map();
  sentCounts.clear();
  mutedUntil = {};
  mutedReason = {};
  api.log?.('proactive-chat: 已停用，连发/禁言状态清理');
}

export function dispose() {
  lastBurst = new Map();
  sentCounts.clear();
  mutedUntil = {};
  mutedReason = {};
}

/** 判断某群现在是否被禁言（禁言守卫）。 */
function isMuted(chatKey, ctx) {
  const until = mutedUntil[chatKey];
  if (until && Date.now() < until) return { muted: true, until, reason: mutedReason[chatKey] };
  if (banStateFn) {
    try {
      const r = banStateFn({ chatKey, action: 'check' });
      if (r?.muted) {
        return { muted: true, until: r.mutedUntil ?? Date.now() + (r.remainSec || 1) * 1000, reason: 'ban-state' };
      }
    } catch {}
  }
  return { muted: false };
}

/** 记录一次连发（after-response 钩子调用）。 */
function recordBurst(chatKey, at = Date.now()) {
  const windowStart = at - (cfg().burstWindowSec ?? 180) * 1000;
  lastBurst.set(chatKey, [...(lastBurst.get(chatKey) || []).filter(t => t >= windowStart), at].slice(-100));
}


const sentCounts = new Map();
export const hooks = {
  // LLM responses are not QQ sends. Count only confirmed session output.
  'after-tool': ({ chatKey, session } = {}) => {
    if (!chatKey || !session?.id) return;
    const count = session.sent?.length || 0;
    if (count > (sentCounts.get(session.id) || 0)) recordBurst(chatKey);
    sentCounts.set(session.id, count);
    while (sentCounts.size > 100) sentCounts.delete(sentCounts.keys().next().value);
  },
};

function api_log(msg) {
  try { console.log('[skill:proactive-chat]', msg); } catch {}
}

/**
 * 主动开场状态查询（供控制台/审计，普通导出非 provider —— 核心无消费点，见 manifest _note）。
 * 宿主 scheduleWake 语义：判断「现在该不该主动接话」。
 * 入参：{ chatKey, now? }
 * 返回：{ shouldProactive, reason, mutedUntil? }
 */
export function proactiveStatus({ chatKey, now = Date.now() } = {}) {
  const m = isMuted(chatKey);
  if (m.muted) return { shouldProactive: false, reason: '禁言中（' + new Date(m.until).toLocaleTimeString('zh-CN') + ' 解禁）', mutedUntil: m.until };
  const c = cfg();
  if (!c.enabled) return { shouldProactive: false, reason: '未启用' };
  const windowStart = now - (c.burstWindowSec ?? 180) * 1000;
  const burst = lastBurst.get(chatKey) || [];
  const recentBurst = burst.filter((t) => t >= windowStart).length;
  if (recentBurst >= (c.maxConsecutive ?? 3)) return { shouldProactive: false, reason: '已达连发上限' };
  const lastAt = burst[burst.length - 1] ?? 0;
  if (now - lastAt < (c.minGapSec ?? 20) * 1000 && lastAt > 0) return { shouldProactive: false, reason: '未到最小间隔' };
  return { shouldProactive: true, reason: '群聊热，可主动接话' };
}

export const providers = {
  'chat.run-guard': ({ chatKey, proactive } = {}) => {
    const m = isMuted(chatKey);
    if (m.muted) return { block: true, reason: '禁言中' };
    if (proactive) {
      const status = proactiveStatus({ chatKey });
      if (!status.shouldProactive) return { block: true, reason: status.reason };
    }
    return { block: false };
  },
};
