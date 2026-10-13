// Contract: pcg562240/chatgpt2api 1.8.1-pcg.2, not the official OpenAI API.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class ServiceError extends Error {}
export const fail = content => ({ content, isError: true });
export const publicError = e => e instanceof ServiceError ? e.message : '请求或本地处理失败，详情请检查服务端状态（未回传原始错误或凭据）';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function serviceRoot(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { throw new ServiceError('请填写 chatgpt2api 的 HTTP(S) 服务地址'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new ServiceError('服务地址须为无凭据、无查询参数的 HTTP(S) 地址');
  }
  return u.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function modelId(value, optional = false) {
  const id = String(value ?? '').trim();
  if ((!id && !optional) || id.length > 200 || /[\s\x00-\x1f\x7f]/.test(id)) throw new ServiceError('请填写有效模型 ID（不含空白，最多 200 字符）');
  return id; // Never lower-case, alias, or silently substitute a model.
}

export function settings(raw = {}, requireModel = true) {
  const root = serviceRoot(raw.baseUrl);
  const key = String(raw.apiKey || '').trim();
  if (!key || key === '******' || /[\r\n]/.test(key)) throw new ServiceError('请在本技能设置中填写 chatgpt2api 用户 API Key');
  const number = (name, fallback, lo, hi) => {
    const n = Number(raw[name] ?? fallback);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new ServiceError(`${name} 必须在 ${lo}～${hi} 之间`);
    return n;
  };
  return { root, key, model: modelId(raw.model, !requireModel), scope: digest([root, key]),
    timeoutMs: number('timeoutMs', 300000, 10000, 600000),
    maxImageBytes: number('maxImageMB', 8, 1, 20) * 1048576,
    defaultSize: imageSize(raw.defaultSize ?? 'auto'), quality: imageQuality(raw.quality ?? 'auto') };
}
export function imageSize(value) {
  const s = String(value || 'auto').trim();
  if (s === 'auto') return s;
  const m = /^(\d{1,4})x(\d{1,4})$/.exec(s);
  if (!m || m.slice(1).some(x => Number(x) < 1 || Number(x) > 4096)) throw new ServiceError('尺寸必须是 auto 或 1～4096 范围内的 宽x高');
  return s;
}
export function imageQuality(value) {
  if (!['auto', 'low', 'medium', 'high'].includes(value)) throw new ServiceError('quality 请选择 auto/low/medium/high');
  return value;
}

export function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
export function readPrivate(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new ServiceError('缓存文件类型不正确');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function boundedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new ServiceError('接口响应超过体积上限'); }
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError('接口返回空响应');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > maxBytes) throw new ServiceError('接口响应超过体积上限');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function client(c, fetcher, signal) {
  async function request(route, { body, binary = false, auth = true, timeoutMs = c.timeoutMs } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const r = await fetcher(c.root + route, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { ...(auth ? { Authorization: `Bearer ${c.key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      if (!r.ok) {
        await r.body?.cancel();
        const hint = ({401:'密钥无效',403:'权限不足',404:'接口或任务不存在',429:'额度或并发受限'})[r.status] || '请检查服务版本、模型及服务端状态';
        throw new ServiceError(`chatgpt2api HTTP ${r.status}：${hint}；未自动重试`);
      }
      const bytes = await boundedBody(r, binary ? c.maxImageBytes : 2 * 1048576);
      if (binary) return bytes;
      try { return JSON.parse(bytes.toString('utf8')); } catch { throw new ServiceError('接口没有返回有效 JSON'); }
    } catch (e) {
      if (e instanceof ServiceError) throw e;
      if (signal?.aborted) throw new ServiceError('操作已停止；上游已提交的任务可能仍在运行');
      throw new ServiceError('服务连接失败或超时，提交结果可能未知；未自动重试');
    }
  }
  return {
    request,
    async image(ref) {
      let bytes;
      if (typeof ref?.b64_json === 'string' && !/^https?:/i.test(ref.b64_json)) {
        if (ref.b64_json.length > Math.ceil(c.maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ref.b64_json)) throw new ServiceError('图片 Base64 无效或超限');
        bytes = Buffer.from(ref.b64_json, 'base64');
      } else {
        let u;
        try { u = new URL(ref?.url || ref?.b64_json, c.root + '/'); } catch { throw new ServiceError('图片结果缺少地址'); }
        // Tasks save images under /images. Rebase ONLY that inert storage path to
        // the configured service (Docker/LAN origins often differ). No redirect,
        // arbitrary URL fetch, query string, or key forwarded to a result host.
        const prefix = new URL(c.root).pathname.replace(/\/$/, '');
        const pathname = u.pathname.startsWith(prefix + '/images/') ? u.pathname.slice(prefix.length) : u.pathname;
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash ||
            !/^\/images\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp)$/i.test(pathname)) throw new ServiceError('图片不是 chatgpt2api 的受支持本地结果路径');
        bytes = await request(pathname, { binary: true, auth: false, timeoutMs: 60000 });
      }
      const info = imageType(bytes, c.maxImageBytes);
      return { bytes, ...info };
    }
  };
}

export function imageType(b, limit = 8 * 1048576) {
  if (!Buffer.isBuffer(b) || !b.length || b.length > limit) throw new ServiceError('图片为空或超过体积上限');
  let width, height, ext, mime;
  if (b.length >= 33 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16) === 'IHDR') {
    width=b.readUInt32BE(16);height=b.readUInt32BE(20);ext='png';mime='image/png';
  } else if (b.length >= 30 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') {
    ext='webp';mime='image/webp';const kind=b.toString('ascii',12,16);
    if (kind==='VP8X') {width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if (kind==='VP8 ' && b.subarray(23,26).equals(Buffer.from([157,1,42]))) {width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff;}
    else if (kind==='VP8L' && b[20]===0x2f) {const n=b.readUInt32LE(21);width=(n&0x3fff)+1;height=((n>>>14)&0x3fff)+1;}
  } else if (b.length >= 4 && b[0]===255 && b[1]===216 && b[b.length-2]===255 && b[b.length-1]===217) {
    ext='jpg';mime='image/jpeg';let i=2;
    while (i+3<b.length && b[i]===255) {
      while(b[i]===255)i++;const marker=b[i++];
      if(marker===0xda || marker===0xd9)break;
      if(marker===1 || (marker>=0xd0 && marker<=0xd7))continue;
      if(i+2>b.length)break;const length=b.readUInt16BE(i);
      if(length<2 || i+length>b.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length>=7){height=b.readUInt16BE(i+3);width=b.readUInt16BE(i+5);break;}
      i+=length;
    }
  }
  if (!width || !height || width>8192 || height>8192 || width*height>32000000) throw new ServiceError('图片格式/尺寸不支持；须为 PNG/JPEG/WebP，最长边≤8192 且不超过 3200 万像素');
  return {ext,mime};
}

export function createCatalog({ dataDir, id, getSettings, getFetch, images }) {
  return async ({ refresh = false } = {}) => {
    const c = settings(getSettings(), false);
    const file = path.join(dataDir, 'skill-data', id, `models-${c.scope}.json`);
    if (!refresh) return readPrivate(file, { models: [], updatedAt: null });
    const result = await client(c, getFetch()).request('/v1/models', { timeoutMs: 30000 });
    if (!Array.isArray(result?.data)) throw new ServiceError('模型列表响应格式不正确；保留旧列表和已选模型');
    const ids = [];
    for (const row of result.data.slice(0, 5000)) {
      try {
        const id = modelId(row.id);
        if (id.includes(c.key)) continue;
        const image = /^(?:gpt-image-|web-image\/|dall-e-)/.test(id);
        if (image === images && !ids.includes(id)) ids.push(id);
      } catch { /* Ignore malformed catalog entries, not the user's custom ID. */ }
    }
    if (!ids.length) throw new ServiceError('没有发现匹配模型；保留旧列表，仍可手填自定义模型 ID');
    if (settings(getSettings(), false).scope !== c.scope) throw new ServiceError('连接设置已变化，请重新获取模型');
    const value = { models: ids.slice(0, 1000), updatedAt: new Date().toISOString() };
    writePrivate(file, value); return value;
  };
}
