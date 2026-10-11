// One bounded protocol reminder, not a publisher of model reasoning.
// Covers a zero-tool ending for a directly addressed message, or an ending
// after looking up that current message. It never sends the draft itself.
export function unsentReplyReminder({ trigger = [], messages = [], sent = [], kind,
  proactive = false, alreadyReminded = false, canSend = false } = {}) {
  if (proactive || alreadyReminded || !canSend || sent.length) return '';
  const targets = new Set(trigger.filter(e => !e.self && (kind === 'private' || e.atMe === true))
    .map(e => String(e.mid ?? '')).filter(Boolean));
  if (!targets.size) return '';
  const turns = messages.filter(m => m.role === 'assistant');
  if (!turns.length || turns.at(-1).tool_calls?.length) return '';
  const calls = turns.flatMap(m => m.tool_calls || []);
  if (calls.some(call => call.function?.name === 'finish')) return '';
  const lookedUp = calls.some(call => {
    if (!['get_message_images', 'get_message_detail'].includes(call.function?.name)) return false;
    try { return targets.has(String(JSON.parse(call.function.arguments || '{}').messageId)); }
    catch { return false; }
  });
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
