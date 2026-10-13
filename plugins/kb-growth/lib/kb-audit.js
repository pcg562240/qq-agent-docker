import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';
// kb-audit.js —— 审计日志（从宿主 kb-audit.js 提炼）
export class AuditLogger {
  constructor({ enabled = true, flushIntervalMs = 1000, maxBuffer = 500 } = {}) {
    this.enabled = enabled;
    this.flushIntervalMs = flushIntervalMs;
    this.maxBuffer = maxBuffer;
    this.buffer = [];
    this.timer = null;
    if (this.enabled) this.timer = setInterval(() => this.flush().catch(() => {}), flushIntervalMs);
    this.timer?.unref?.();
  }
  log(event, detail = {}) {
    if (!this.enabled) return;
    if (this.buffer.length >= this.maxBuffer * 2) return;
    this.buffer.push({ log_id: new Date().toISOString(), event, detail, ts: Date.now() });
    if (this.buffer.length >= this.maxBuffer) this.flush().catch(() => {});
  }
  async flush() {
    if (!this.buffer.length) return;
    const items = this.buffer.slice();
    const dir = path.join(DATA_DIR, 'kb-growth');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), items.map(i => JSON.stringify(i)).join('\n') + '\n');
    this.buffer.splice(0, items.length);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush().catch(() => {});
  }
}
