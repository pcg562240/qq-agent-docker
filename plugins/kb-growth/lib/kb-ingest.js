// kb-ingest.js —— 异步入队队列（从宿主 kb-ingest.js 提炼；微秒级入队，不 await IO）
export class IngestQueue {
  constructor({ maxSize = 500, dedupeMs = 600000, onFlush } = {}) {
    this.maxSize = maxSize;
    this.dedupeMs = dedupeMs;
    this.onFlush = onFlush;
    this.items = new Map();   // key → { item, ts }
    this.size = 0;
  }
  async enqueue(item) {
    const key = JSON.stringify([item.tenantId, item.kind, item.payload?.query, item.payload?.url]);
    const now = Date.now();
    const prev = this.items.get(key);
    if (prev && now - prev.ts < this.dedupeMs) return;  // 窗口去重静默丢弃
    this.items.set(key, { item, ts: now });
    this.size = this.items.size;
    if (this.size >= this.maxSize) await this.flush();
  }
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.items.size) return;
    const batch = [...this.items.entries()];
    this.flushing = (async () => {
      await this.onFlush?.(batch.map(([, v]) => v.item));
      for (const [key, value] of batch) if (this.items.get(key) === value) this.items.delete(key);
      this.size = this.items.size;
    })();
    try { await this.flushing; } finally { this.flushing = null; }
  }
}
