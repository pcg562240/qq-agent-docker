// Shared by ingestion, prompts and image tools. Quoted media stays separate
// from the author's own media, so provenance survives persistence.
export async function resolveIncomingQuote(event, { findByMid, getMsg, kind, chatId } = {}) {
  if (event.officialReply) return structuredClone(event.officialReply);
  const reply = Array.isArray(event.message) ? event.message.find(s => s?.type === 'reply') : null;
  const id = reply?.data?.id;
  if (id == null || String(id) === '') return null;
  const messageId = String(id);
  const local = findByMid?.(messageId);
  if (local && !local.recalled) return { messageId, sender: local.senderName || '', senderId: local.senderId || '',
    text: String(local.text || '').slice(0, 2000), media: local.media || [], source: 'store', unavailable: false };
  try {
    const raw = await getMsg?.(messageId);
    if (!raw) throw new Error('not found');
    if (kind === 'group' && raw.group_id != null && String(raw.group_id) !== String(chatId)) throw new Error('wrong group');
    if (kind === 'private' && raw.message_type === 'group') throw new Error('wrong scope');
    const segments = Array.isArray(raw.message) ? raw.message : [];
    const media = segments.filter(s => s?.type === 'image' && s.data?.url).slice(0, 20)
      .map(s => ({ kind: 'image', url: String(s.data.url) }));
    const text = segments.length ? segments.map(s => s.type === 'text' ? String(s.data?.text || '') : `[${s.type === 'image' ? '图片' : s.type}]`).join('')
      : typeof raw.message === 'string' ? raw.message : '';
    return { messageId, sender: raw.sender?.card || raw.sender?.nickname || '', senderId: String(raw.sender?.user_id || ''),
      text: text.slice(0, 2000), media, source: 'protocol', unavailable: false };
  } catch { return { messageId, sender: '', text: '', media: [], source: 'unavailable', unavailable: true }; }
}

export function messageImageReferences(entry, findByMid = () => null) {
  const result = [];
  const seen = new Set();
  const add = (media, source) => {
    for (const m of Array.isArray(media) ? media : []) {
      if (m?.kind !== 'image' || !m.url || seen.has(m.url)) continue;
      seen.add(m.url); result.push({ url: m.url, source });
    }
  };
  add(entry?.media, 'message');
  add(entry?.reply?.media, 'reply');
  // Legacy stored replies may only have an ID. Resolve ONE hop in THIS chat.
  if (entry?.reply?.messageId != null) {
    const original = findByMid(entry.reply.messageId);
    if (original && !original.recalled) add(original.media, 'reply');
  }
  return result.slice(0, 20);
}

export function quoteForDetail(reply) {
  if (!reply) return null;
  const { media, ...rest } = reply;
  return { ...rest, imageCount: (media || []).filter(m => m.kind === 'image' && m.url).length };
}

export function quoteText(reply) {
  if (!reply) return '';
  const parts = [reply.sender, reply.text].filter(Boolean);
  if (reply.media?.some(m => m.kind === 'image') && !String(reply.text).includes('[图片]')) parts.push('[图片]');
  if (reply.unavailable) parts.push('引用内容未提供，请用户重发原图或原文');
  return `[引用 ${parts.join('：') || '消息'}]`;
}
