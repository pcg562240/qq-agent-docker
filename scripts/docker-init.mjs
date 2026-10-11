import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.env');
try {
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  fs.writeFileSync(file, example.replace('QQ_AGENT_CONSOLE_TOKEN=',
    `QQ_AGENT_CONSOLE_TOKEN=${crypto.randomBytes(32).toString('hex')}`), { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env（权限 600），未覆盖已有配置。启动：docker compose up -d --build');
  console.log('浏览器打开 http://127.0.0.1:3210，使用 .env 内的 QQ_AGENT_CONSOLE_TOKEN 登录。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env 已存在，保持不变。');
}
