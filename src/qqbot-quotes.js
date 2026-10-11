// QQ's quoted attachments live in msgElements, not the current attachments.
// msg_idx is a reference index, NOT a sendable QQ message ID.
export function qqAttachmentSegments(attachments) {
  const segments = [];
  for (const a of (Array.isArray(attachments) ? attachments : []).slice(0, 20)) {
    const type = String(a?.content_type || '').toLowerCase();
    let url = String(a?.url || '');
    if (url.startsWith('//')) url = `https:${url}`;
    if (type.startsWith('image/') && /^https?:\/\//i.test(url)) {
      segments.push({ type: 'image', data: { url } });
    } else {
      segments.push({ type: 'text', data: { text: type.startsWith('image/')
        ? '[图片地址未提供]' : `[附件：${String(a?.filename || type || '文件').slice(0, 200)}]` } });
    }
  }
  return segments;
}

function summarize(segments) {
  const media = segments.filter(s => s?.type === 'image' && /^https?:\/\//i.test(s.data?.url || ''))
    .slice(0, 20).map(s => ({ kind: 'image', url: s.data.url }));
  const text = segments.map(s => s?.type === 'text' ? String(s.data?.text || '') : (s?.type === 'image' ? '[图片]' : `[${s?.type || '附件'}]`))
    .join('').slice(0, 2000);
  return { text, media };
}

export function qqMessageQuote(msg) {
  const refKey = String(msg.refMsgIdx || '');
  if (!refKey && msg.msgType !== 103) return null;
  const elements = Array.isArray(msg.msgElements) ? msg.msgElements : [];
  // A different explicit index must never be borrowed as the quoted message.
  const element = elements.find(e => refKey && String(e?.msg_idx || '') === refKey)
    || (!elements[0]?.msg_idx ? elements[0] : null);
  const segments = [];
  if (element?.content) segments.push({ type: 'text', data: { text: String(element.content) } });
  segments.push(...qqAttachmentSegments(element?.attachments));
  const summary = summarize(segments);
  return { messageId: null, refKey: refKey || String(element?.msg_idx || ''), sender: '', senderId: '',
    ...summary, source: summary.text || summary.media.length ? 'msg_elements' : 'unavailable',
    unavailable: !summary.text && !summary.media.length };
}

export function enrichQQQuote(quote, referencedEvent) {
  if (!quote || !referencedEvent) return quote;
  const cached = summarize(Array.isArray(referencedEvent.message) ? referencedEvent.message : []);
  // Prefer fresh pushed attachments (old QQ CDN URLs may already have expired).
  const useInline = quote.source === 'msg_elements';
  return { ...quote, messageId: String(referencedEvent.message_id),
    sender: String(referencedEvent.sender?.nickname || ''), senderId: String(referencedEvent.user_id || ''),
    text: useInline ? quote.text : cached.text,
    media: useInline && quote.media.length ? quote.media : cached.media,
    source: useInline ? 'msg_elements' : 'cache', unavailable: false };
}
