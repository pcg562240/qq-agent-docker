// Inspect the SDK's serialized send metadata, never persist or expose its raw
// log strings (which can contain bodies, OpenIDs, URLs and credentials).
import { AsyncLocalStorage } from 'node:async_hooks';

export const TEXT_SEND_DIAGNOSTIC_LIMIT = 50;
const BODY_PREFIX = '[qqbot:api] >>> Body: ';
const STATUS = /^\[qqbot:api\] <<< Status: ([1-5]\d{2})(?:\s|$)/;
const MAX_LOG_LENGTH = 128 * 1024;
const integer = value => Number.isSafeInteger(value) ? value : null;

export class QQTextSendDiagnostics {
  #contexts = new AsyncLocalStorage();
  #entries = [];
  #sequence = 0;

  async run(target, send) {
    const entry = { sequence: ++this.#sequence, startedAt: Date.now(),
      scope: target.scope === 'group' ? 'group' : 'c2c', outcome: 'pending',
      wireObserved: false, requestBodyCount: 0, httpStatus: null };
    this.#entries.push(entry);
    this.#entries = this.#entries.slice(-TEXT_SEND_DIAGNOSTIC_LIMIT);
    // The comparison ID lives only in the active async context, not the ring.
    const context = { entry, expectedMsgId: target.msgId };
    return this.#contexts.run(context, async () => {
      try {
        const result = await send();
        entry.outcome = 'returned';
        entry.hasReturnedId = typeof result?.id === 'string' && result.id.length > 0;
        return result;
      } catch (error) {
        entry.outcome = 'error';
        try {
          entry.errorHttpStatus = integer(error?.httpStatus);
          entry.errorCode = integer(error?.bizCode);
        } catch { /* Never mask the original send error with diagnostics. */ }
        throw error;
      } finally {
        entry.finishedAt = Date.now();
        delete context.expectedMsgId;
        context.finished = true;
      }
    });
  }

  observe(level, value) {
    const context = this.#contexts.getStore();
    if (!context || context.finished || typeof value !== 'string' || value.length > MAX_LOG_LENGTH) return;
    const { entry } = context;
    try {
      if (level === 'debug' && value.startsWith(BODY_PREFIX)) {
        const body = JSON.parse(value.slice(BODY_PREFIX.length));
        if (!body || !Number.isInteger(body.msg_type)) return;
        const content = typeof body.content === 'string' ? body.content : '';
        const hasMsgId = typeof body.msg_id === 'string' && body.msg_id.length > 0;
        Object.assign(entry, {
          wireObserved: true, requestBodyCount: entry.requestBodyCount + 1,
          msgType: body.msg_type, hasMsgId,
          anchorMatches: hasMsgId ? body.msg_id === context.expectedMsgId : !context.expectedMsgId,
          hasReference: typeof body.message_reference?.message_id === 'string' && body.message_reference.message_id.length > 0,
          hasMarkdown: body.markdown != null,
          contentLength: content.length,
          leadingMention: /^\s*<qqbot-at-user\b/.test(content) ? 'native'
            : /^\s*<@!?[^>]+>/.test(content) ? 'legacy' : 'none',
          sequenceInRange: Number.isInteger(body.msg_seq) && body.msg_seq >= 0 && body.msg_seq <= 65535,
          httpStatus: null,
        });
      } else if (level === 'info' && entry.wireObserved) {
        const match = value.match(STATUS);
        if (match) entry.httpStatus = Number(match[1]);
      }
    } catch { /* SDK logging changes or malformed logs must not affect sending. */ }
  }

  list() { return this.#entries.slice().reverse().map(entry => ({ ...entry })); }
}
