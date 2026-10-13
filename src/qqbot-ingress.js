// Bounded routing diagnostics only: no message bodies, authors, attachment URLs
// or credentials. These records are not chat history and never enter a prompt.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const INGRESS_LIMIT = 500;
export const INGRESS_REASONS = new Set(['forwarded', 'not_allowed', 'not_mentioned', 'blocked_sender', 'empty_message', 'duplicate', 'bot_message', 'error']);
function metadataOnly(entry) {
  if (!entry || !['group', 'private'].includes(entry.kind) || !/^[A-Za-z0-9_-]{1,256}$/.test(entry.id || '')
    || !/^[a-f0-9]{16}$/.test(entry.ref || '') || !/^[A-Z_]{1,64}$/.test(entry.eventType || '')
    || !INGRESS_REASONS.has(entry.reason) || !Number.isFinite(entry.messageAt) || !Number.isFinite(entry.receivedAt)) return null;
  const { kind, id, ref, eventType, messageAt, receivedAt, reason } = entry;
  return { kind, id, ref, eventType, atMe: entry.atMe === true, messageAt, receivedAt, reason };
}
export class QQIngressJournal {
  constructor(directory) {
    this.file = path.join(directory, 'ingress.json');
    this.entries = [];
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.entries = Array.isArray(data) ? data.map(metadataOnly).filter(Boolean).slice(-INGRESS_LIMIT) : [];
    } catch { /* Diagnostics must not prevent the bot from starting. */ }
  }
  record({ kind, id, messageId, eventType, atMe, messageAt, receivedAt, reason }) {
    if (!INGRESS_REASONS.has(reason)) return;
    const entry = metadataOnly({ kind, id, ref: createHash('sha256').update(`${kind}:${id}:${messageId}`).digest('hex').slice(0, 16),
      eventType, atMe, messageAt, receivedAt, reason });
    if (!entry) return;
    this.entries.push(entry); this.entries = this.entries.slice(-INGRESS_LIMIT);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.entries), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch { /* In-memory diagnostics survive; never block delivery on a log write. */ }
  }
  list(kind, id) {
    return this.entries.filter(e => e.kind === kind && e.id === id).slice(-50).reverse().map(e => ({ ...e }));
  }
}
