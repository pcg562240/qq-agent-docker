import { messageReference } from './message-reference.js';
// Only known read-only tools may precede a reminder. In particular, a failed
// send or a skill with side effects must not turn this into an automatic retry.
const WEB_QUERIES = new Set(['web_search', 'web_fetch', 'chatgpt2api-search__search', 'search-aggregator-skill__web_search_agg']);
const READ_ONLY_TOOLS = new Set(['get_message_images', 'get_message_detail', ...WEB_QUERIES]);
const MESSAGE_LOOKUPS = new Set(['get_message_images', 'get_message_detail']);

function directTargets(trigger, kind, chatKey) {
  return new Set(trigger.filter(e => !e.self && (kind === 'private' || e.atMe === true))
    .flatMap(e => [String(e.mid ?? ''), messageReference(e, chatKey)]).filter(Boolean));
}

function isCurrentLookup(call, targets) {
  if (!MESSAGE_LOOKUPS.has(call.function?.name)) return false;
  try { return targets.has(String(JSON.parse(call.function.arguments || '{}').messageId).replace(/^#/, '')); }
  catch { return false; }
}

// One initial protocol reminder, not a publisher of model reasoning.
// Covers a zero-tool ending for a directly addressed message, or an ending
// after looking up that current message. It never sends the draft itself.
export function unsentReplyReminder({ trigger = [], messages = [], sent = [], kind, chatKey = '',
  proactive = false, alreadyReminded = false, canSend = false } = {}) {
  if (proactive || alreadyReminded || !canSend || sent.length) return '';
  const targets = directTargets(trigger, kind, chatKey);
  if (!targets.size) return '';
  const turns = messages.filter(m => m.role === 'assistant');
  if (!turns.length || turns.at(-1).tool_calls?.length) return '';
  const calls = turns.flatMap(m => m.tool_calls || []);
  if (calls.some(call => !READ_ONLY_TOOLS.has(call.function?.name))) return '';
  const lookedUp = calls.some(call => isCurrentLookup(call, targets));
  // Keep the existing lookup scope. A failed send or an unrelated tool call
  // must not become a new automatic send-retry policy through this branch.
  if (calls.length && !lookedUp) return '';
  return '【发送检查，仅提醒一次】用户本轮直接向你提问，'
    + (lookedUp ? '你已查过这条消息，但尚未向 QQ 发送任何可见回复。'
      : '你刚才没有调用任何工具，也尚未向 QQ 发送可见回复。')
    + '普通正文和思考不会发出去。若要答复，请调用 send_message 给出面向用户的成稿；'
    + (lookedUp ? '若引用图片/新闻内容未取到，明确说明看不到并请用户重发原图、截图或链接，不要猜内容。' : '')
    + '不要发送或复述内部思考。若确实应当保持沉默，请调用 finish 说明原因，而不是只在正文写“直接说……”后结束。';
}

// A separate, single post-query reminder. It requires a completed relevant
// query AFTER the previous reminder, not just another silent model ending.
// The caller enforces the existing model-round budget. Neither helper sends.
export function unsentQueryReplyReminder({ trigger = [], messages = [], sent = [], kind, chatKey = '',
  proactive = false, alreadyReminded = false, canSend = false, afterMessageIndex = -1 } = {}) {
  if (proactive || alreadyReminded || !canSend || sent.length) return '';
  const targets = directTargets(trigger, kind, chatKey);
  if (!targets.size) return '';
  const turns = messages.filter(m => m.role === 'assistant');
  if (!turns.length || turns.at(-1).tool_calls?.length) return '';
  const calls = turns.flatMap(m => m.tool_calls || []);
  if (calls.some(call => !READ_ONLY_TOOLS.has(call.function?.name))) return '';

  const pending = new Map();
  let queried = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') for (const call of m.tool_calls || []) {
      if (call.id) pending.set(call.id, call);
    }
    if (m.role !== 'tool') continue;
    const call = pending.get(m.tool_call_id);
    if (!call || call.function?.name !== m.name) continue;
    pending.delete(m.tool_call_id);
    if (i > afterMessageIndex && (WEB_QUERIES.has(m.name) || isCurrentLookup(call, targets))) queried = true;
  }
  if (!queried || pending.size) return '';
  return '【查询后发送检查，仅提醒一次】用户本轮直接向你提问，查询工具已返回，但你还没有向 QQ 发送可见回复。'
    + '请根据实际查询结果调用 send_message 给出面向用户的成稿；查询失败、资料不足或仍无法确定时，坦诚说明限制或请用户补充，不要编造结论，也不要盲目重复查询。'
    + '普通正文和思考不会发出去，不要发送或复述内部思考。若确实应当保持沉默，请调用 finish 说明原因。';
}
