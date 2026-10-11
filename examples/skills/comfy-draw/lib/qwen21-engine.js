// Distinct filename from the v1 generic engine avoids stale ESM imports during live upgrades.
// Qwen-Image-2.1-Turbo native ComfyUI API; no host filesystem mounts or custom nodes.
export const SIGMAS = '1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0';
export const DEFAULTS = {
  baseUrl: 'http://host.docker.internal:9000',
  modelName: 'qwen_image_2.1_turbo_bf16.safetensors',
  clipName: 'qwen3vl_8b_int8_convrot.safetensors',
  vaeName: 'qwen_image_2.1_vae_bf16.safetensors',
  defaultSize: '768x768', editResolution: 768, notifyStart: true,
  timeoutMs: 240000, maxImageMB: 12, keepImages: 200,
};

export function parseSize(raw) {
  const match = /^(\d{3,4})\s*[x×*]\s*(\d{3,4})$/i.exec(String(raw).trim());
  if (!match) throw Error('尺寸请写成 768x768、640x960、960x640 或 1024x1024');
  const [width, height] = match.slice(1).map(Number);
  if ([width, height].some(v => v < 512 || v > 1536 || v % 32) || width * height > 1048576 || Math.max(width / height, height / width) > 2.25) {
    throw Error('当前 QQ 预设要求尺寸为 32 的倍数、每边 512～1536 且总像素不超过 1024×1024；不直接生成 4K');
  }
  return { width, height };
}

export function config(raw = {}) {
  const c = { ...DEFAULTS, ...raw };
  let url;
  try { url = new URL(c.baseUrl); } catch { throw Error('请在技能设置中填写 ComfyUI 的 http(s) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('ComfyUI 地址只接受无凭据、无查询参数的 http(s) 地址');
  c.baseUrl = url.href.replace(/\/+$/, '');
  for (const key of ['modelName', 'clipName', 'vaeName']) {
    if (typeof c[key] !== 'string' || !c[key].trim() || /[\x00-\x1f]/.test(c[key])) throw Error(`技能设置缺少有效的 ${key}`);
  }
  parseSize(c.defaultSize);
  c.editResolution = Number(c.editResolution);
  if (![768, 1024].includes(c.editResolution)) throw Error('改图分辨率请选择 768 或 1024');
  for (const [key, lo, hi] of [['timeoutMs', 30000, 600000], ['maxImageMB', 1, 20], ['keepImages', 20, 1000]]) {
    c[key] = Number(c[key]);
    if (!Number.isInteger(c[key]) || c[key] < lo || c[key] > hi) throw Error(`${key} 必须在 ${lo}～${hi} 之间`);
  }
  return c;
}

export function buildGraph(c, { prompt, seed, size, inputName, prefix }) {
  const node = (class_type, inputs) => ({ class_type, inputs });
  const g = {
    '1': node('UNETLoader', { unet_name: c.modelName, weight_dtype: 'default' }),
    '2': node('CLIPLoader', { clip_name: c.clipName, type: 'qwen_image', device: 'default' }),
    '3': node('VAELoader', { vae_name: c.vaeName }),
    '4': node('TextEncodeQwenImage21', { clip: ['2', 0], prompt, negative_prompt: '', vae: ['3', 0], resolution: inputName ? c.editResolution : size.width }),
    '5': node('QwenImage21Cache', { model: ['1', 0], device: 'auto', dtype: 'default' }),
    '6': node('BasicGuider', { model: ['5', 0], conditioning: ['4', 0] }),
    '7': node('KSamplerSelect', { sampler_name: 'euler' }),
    '8': node('ManualSigmas', { sigmas: SIGMAS }),
    '9': node('RandomNoise', { noise_seed: seed }),
    '10': node('SamplerCustomAdvanced', { noise: ['9', 0], guider: ['6', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['4', 2] }),
    '11': node('VAEDecode', { samples: ['10', 0], vae: ['3', 0] }),
    '12': node('SaveImage', { images: ['11', 0], filename_prefix: prefix }),
  };
  if (inputName) {
    g['13'] = node('LoadImage', { image: inputName });
    // V3 autogrow API names are namespaced. Bare image_1 validates but fails at execution.
    g['4'].inputs['images.image_1'] = ['13', 0];
  } else if (size.width !== size.height) {
    g['14'] = node('EmptyLatentImage', { ...size, batch_size: 1 });
    g['10'].inputs.latent_image = ['14', 0];
  }
  return g;
}

export async function boundedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw Error('响应图片或数据超过大小限制');
  }
  if (!response.body) throw Error('服务返回了空响应');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw Error('响应图片或数据超过大小限制'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

// Check magic and dimensions before sending an untrusted QQ attachment to the decoder.
export function imageInfo(b) {
  let width, height, ext, mime;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20); ext = 'png'; mime = 'image/png';
    for (let i = 8; i + 12 <= b.length;) {
      const length = b.readUInt32BE(i);
      if (b.toString('ascii', i + 4, i + 8) === 'acTL') throw Error('改图请发送静态图片，而非 APNG 动图');
      i += length + 12;
    }
  } else if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) {
    throw Error('改图请发送静态 PNG/JPEG/WebP 图片，而非 GIF');
  } else if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    ext = 'webp'; mime = 'image/webp';
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') { if (b[20] & 2) throw Error('改图请发送静态图片，而非 WebP 动图'); width = 1 + b.readUIntLE(24, 3); height = 1 + b.readUIntLE(27, 3); }
    else if (kind === 'VP8 ' && b.subarray(23, 26).equals(Buffer.from([157,1,42]))) { width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
    else if (kind === 'VP8L' && b[20] === 0x2f) { const n = b.readUInt32LE(21); width = (n & 0x3fff) + 1; height = ((n >>> 14) & 0x3fff) + 1; }
  } else if (b.length > 4 && b[0] === 255 && b[1] === 216) {
    ext = 'jpg'; mime = 'image/jpeg';
    let i = 2;
    while (i + 3 < b.length && b[i] === 255) {
      while (b[i] === 255) i++;
      const marker = b[i++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > b.length) break;
      const length = b.readUInt16BE(i);
      if (length < 2 || i + length > b.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        height = b.readUInt16BE(i + 3); width = b.readUInt16BE(i + 5); break;
      }
      i += length;
    }
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32000000) throw Error('图片格式或尺寸不支持；请发送 PNG/JPEG/WebP 静态图（最多 3200 万像素）');
  if (Math.max(width / height, height / width) > 4) throw Error('参考图长宽比请控制在 4:1 以内');
  return { width, height, ext, mime };
}

export function imageLocator(im, expectedType) {
  if (!im || typeof im.filename !== 'string' || !im.filename || /[/\\\x00-\x1f]/.test(im.filename) || im.filename === '.' || im.filename === '..') throw Error('ComfyUI 返回了非法图片文件名');
  const subfolder = im.subfolder || '';
  if (typeof subfolder !== 'string' || /[\\\x00-\x1f]/.test(subfolder) || subfolder.split('/').some(p => p === '..' || p === '.') || subfolder.startsWith('/')) throw Error('ComfyUI 返回了非法图片目录');
  if (im.type && im.type !== expectedType) throw Error('ComfyUI 返回了错误的图片类型');
  return { filename: im.filename, subfolder, type: expectedType };
}

export function createClient(c, fetchImpl, signal) {
  async function request(route, { json, form, maxBytes = 2 * 1024 * 1024 } = {}) {
    const timeout = AbortSignal.timeout(30000);
    const response = await fetchImpl(c.baseUrl + route, {
      method: json !== undefined || form ? 'POST' : 'GET',
      headers: json !== undefined ? { 'content-type': 'application/json' } : {},
      body: form || (json !== undefined ? JSON.stringify(json) : undefined),
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = await boundedBody(response, maxBytes);
    if (!response.ok) {
      let detail = '';
      try { const e = JSON.parse(body); detail = e.error?.message || (typeof e.error === 'string' ? e.error : ''); } catch { /* Never echo untrusted HTML or URLs. */ }
      throw Error(`ComfyUI HTTP ${response.status}${detail ? ': ' + detail.slice(0, 240) : ''}`);
    }
    return body;
  }
  const json = async (route, body) => JSON.parse((await request(route, { json: body })).toString());
  return {
    json,
    async assertReady() {
      const q = await json('/queue');
      if (q.queue_running?.length || q.queue_pending?.length) throw Error('ComfyUI 正在处理其他任务，本次尚未提交；请稍后再画');
      for (const [node, key, value] of [['UNETLoader','unet_name',c.modelName], ['CLIPLoader','clip_name',c.clipName], ['VAELoader','vae_name',c.vaeName]]) {
        const info = await json('/object_info/' + node);
        if (!info[node]?.input?.required?.[key]?.[0]?.includes(value)) throw Error(`ComfyUI 未找到 ${value}，没有切换其他模型`);
      }
      const info = await json('/object_info/TextEncodeQwenImage21');
      if (!info.TextEncodeQwenImage21) throw Error('ComfyUI 缺少原生 TextEncodeQwenImage21 节点');
    },
    async upload(buffer, name) {
      if (buffer.length > c.maxImageMB * 1048576) throw Error('参考图超过大小限制');
      const info = imageInfo(buffer), form = new FormData();
      form.append('image', new Blob([buffer], { type: info.mime }), `${name}.${info.ext}`);
      form.append('type', 'input'); form.append('subfolder', 'qqagent_comfy');
      const uploaded = JSON.parse((await request('/upload/image', { form })).toString());
      const loc = imageLocator({ ...uploaded, filename: uploaded.name }, 'input');
      return [loc.subfolder, loc.filename].filter(Boolean).join('/');
    },
    async output(im) {
      const loc = imageLocator(im, 'output');
      const b = await request('/view?' + new URLSearchParams(loc), { maxBytes: c.maxImageMB * 1048576 });
      const info = imageInfo(b);
      // SaveImage emits PNG. Reject formats which do not match the local output suffix.
      if (info.ext !== 'png') throw Error('SaveImage 没有返回 PNG 图片');
      return b;
    },
    async history(id) {
      const h = (await json('/history/' + encodeURIComponent(id)))[id];
      if (!h) return null;
      if (h.status?.status_str === 'error') {
        const e = h.status.messages?.find(m => m[0] === 'execution_error')?.[1];
        throw Error(`ComfyUI 执行失败（${e?.node_type || '未知节点'}）：${String(e?.exception_message || '请查看 ComfyUI 日志').slice(0, 240)}`);
      }
      const images = h.outputs?.['12']?.images;
      if (!images?.length) throw Error('任务结束但没有生成图片');
      if (images.length !== 1) throw Error('任务返回了非预期的图片数量');
      return images[0];
    },
  };
}
