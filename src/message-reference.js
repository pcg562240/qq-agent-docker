import { createHash } from 'node:crypto';

// Model-facing handles only. Never replace a stored/protocol message ID.
// Local sequence alone is not enough: bind it to both the chat and real ID so
// another chat, a cleared archive or a typo cannot silently select another image.
const HANDLE = /^m([1-9]\d*)-([a-f0-9]{10})$/;
export function messageReference(entry, chatKey = '') {
  const mid = String(entry?.mid ?? '');
  if (!chatKey || mid.length < 64 || !Number.isSafeInteger(entry?.id) || entry.id < 1) return mid;
  const hash = createHash('sha256').update(JSON.stringify([chatKey, entry.id, mid])).digest('hex').slice(0, 10);
  return `m${entry.id}-${hash}`;
}

export function resolveMessageReference(store, chatKey, value) {
  if (typeof value !== 'string') return value;
  const raw = value.trim();
  const ref = raw.startsWith('#') ? raw.slice(1) : raw;
  const match = HANDLE.exec(ref);
  if (match) {
    const id = Number(match[1]);
    const entry = Number.isSafeInteger(id) ? store?.findByLocalId?.(chatKey, id) : null;
    if (!entry || entry.recalled || messageReference(entry, chatKey) !== ref) {
      throw new Error('短消息编号不属于当前聊天或已失效；请重新调用 get_recent_messages 获取编号，不要猜测或改写。');
    }
    return entry.mid;
  }
  // Preserve exact raw IDs, including numeric OneBot IDs. The optional display
  // # is stripped only when the remaining ID actually exists in this chat.
  if (store?.findByMid?.(chatKey, raw)) return raw;
  if (raw.startsWith('#') && store?.findByMid?.(chatKey, ref)) return ref;
  return value; // No prefix, substring, edit-distance or latest-message fallback.
}

export function normalizeToolMessageReferences(args, { store, chatKey } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  // Existing drawing extensions interpret bare #123 as a local sequence. Do
  // not change that legacy contract when a numeric protocol ID also exists.
  const imageRef = value => typeof value === 'string' && /^#\d+$/.test(value)
    ? value : resolveMessageReference(store, chatKey, value);
  for (const key of ['messageId', 'message_id', 'replyToMessageId']) {
    if (Object.hasOwn(out, key)) out[key] = key === 'message_id'
      ? imageRef(out[key]) : resolveMessageReference(store, chatKey, out[key]);
  }
  // ChatGPT image edit references/mask have the same same-chat message boundary.
  // Do not walk arbitrary payloads, message bodies, member IDs or URLs.
  if (Array.isArray(out.references)) out.references = out.references.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return ref;
    return Object.hasOwn(ref, 'message_id')
      ? { ...ref, message_id: imageRef(ref.message_id) } : { ...ref };
  });
  if (out.mask && typeof out.mask === 'object' && !Array.isArray(out.mask) && Object.hasOwn(out.mask, 'message_id')) {
    out.mask = { ...out.mask, message_id: imageRef(out.mask.message_id) };
  }
  return out;
}
