// Attribution for local/model history only, never QQ message markup or routing.
import { messageReference } from './message-reference.js';

const scalar = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

export function normalizeResponseTo(value, chatKey) {
  if (!value || value.chatKey !== chatKey) return null;
  const userId = scalar(value.userId), messageId = scalar(value.messageId);
  if (!userId || userId === 'self' || userId.length > 256 || messageId.length > 2048) return null;
  return Object.freeze({ chatKey, messageId: messageId || null,
    localId: Number.isSafeInteger(value.localId) && value.localId > 0 ? value.localId : null,
    userId, userName: scalar(value.userName).replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 160) });
}

// Capture BEFORE queueing. For official QQ the immutable route is authoritative:
// a historical explicit quote is not necessarily the current questioner.
export function captureResponseTo(store, chatKey, options = {}, official = false) {
  let messageId = '', userId = '';
  if (official) {
    const route = options.replyRoute;
    // Proactive/cross-chat sends can borrow passive quota, but that does not
    // mean they are addressing that last speaker. Do not fabricate attribution.
    if (!route || route.chatKey !== chatKey || !route.mentionUser) return null;
    messageId = scalar(route.msgId); userId = scalar(route.userId);
  } else {
    // OneBot has no implicit frozen recipient here. Only explicit evidence.
    messageId = scalar(options.replyToMessageId); userId = scalar(options.atUserId);
  }
  let source = messageId ? store?.findByMid?.(chatKey, messageId) : null;
  if (source?.self || source?.recalled) source = null;
  if (official) {
    if (source && String(source.senderId) !== userId) source = null;
  } else {
    if (source && userId && String(source.senderId) !== userId) source = null;
    userId ||= scalar(source?.senderId);
    // An unknown/quoted third-party message cannot become this person's question.
    if (!source) messageId = '';
  }
  return normalizeResponseTo({ chatKey, messageId, localId: source?.id,
    userId, userName: source?.senderName || '' }, chatKey);
}

export function responseToForModel(entry, store, chatKey) {
  if (!entry?.self) return null;
  const target = normalizeResponseTo(entry.responseTo, chatKey);
  if (!target) return null;
  const source = target.messageId ? store?.findByMid?.(chatKey, target.messageId) : null;
  const available = !!source && !source.self && !source.recalled
    && String(source.senderId) === target.userId
    && (target.localId === null || source.id === target.localId);
  return { userId: target.userId, userName: target.userName,
    messageId: available ? messageReference(source, chatKey) : null,
    sourceStatus: available ? 'available' : target.messageId ? 'unavailable' : 'not-recorded' };
}

export function responseToText(entry, store, chatKey) {
  const target = responseToForModel(entry, store, chatKey);
  if (!target) return '';
  const who = target.userName && target.userName !== target.userId ? `${JSON.stringify(target.userName)} ` : '';
  const source = target.messageId ? `原提问 #${target.messageId}`
    : target.sourceStatus === 'unavailable' ? '原提问已不在可用存档' : '原提问未记录';
  return `[回复对象 ${who}(ID:${target.userId})；${source}]`;
}
