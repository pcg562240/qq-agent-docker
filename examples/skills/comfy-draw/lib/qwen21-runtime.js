import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, parseSize, createClient, buildGraph, imageInfo } from './qwen21-engine.js';

// A hot reload must not let the new module overlap a still-finishing old invocation.
const locks = globalThis[Symbol.for('qq-agent.comfy-draw.locks')] ||= new Set();
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = content => ({ content, isError: true });

export function resolveReference(ctx, messageId, imageIndex = 1) {
  if (!Number.isInteger(imageIndex) || imageIndex < 1 || imageIndex > 10) throw Error('图片序号必须是 1～10');
  let entry;
  if (messageId !== undefined && messageId !== '') {
    if (typeof messageId !== 'string' || messageId.length > 512) throw Error('图片消息 ID 必须是原样保留的字符串');
    // Official QQ IDs are opaque strings, never Number(mid). #123 explicitly means local ID.
    entry = /^#\d+$/.test(messageId)
      ? ctx.store?.findByLocalId(ctx.chatKey, Number(messageId.slice(1)))
      : ctx.store?.findByMid(ctx.chatKey, messageId);
    if (!entry) throw Error('当前会话中没有这条图片消息，请重新发送图片');
  } else {
    const candidates = (Array.isArray(ctx.session?.trigger) ? ctx.session.trigger : [])
      .filter(e => !e.self && e.media?.some(m => m.kind === 'image'));
    if (candidates.length !== 1) throw Error('本轮没有唯一的图片消息；请指定当前会话中的图片消息 ID，或将一张图片和改图要求一起发送；不自动取其他群友的旧图');
    entry = candidates[0];
  }
  const media = entry.media?.filter(m => m.kind === 'image')?.[imageIndex - 1];
  if (!media?.url || !/^https?:\/\//i.test(media.url)) throw Error('这条消息没有可下载的参考图，图片可能已过期，请重新发送');
  return media.url;
}

export function createSkill({ dataDir, downloadReference, pollMs = 1000 }) {
  const jobsDir = path.join(dataDir, 'skill-data', 'comfy-draw', 'jobs');
  const outputDir = path.join(dataDir, 'media', 'comfy-draw');
  let api, enabled = true;
  const controllers = new Set();
  function checkActive(ctx, signal) {
    signal?.throwIfAborted();
    if (!enabled || ['aborted', 'discarded', 'error'].includes(ctx.session?.status)) throw Error('绘图等待已停止；不再自动发图，已提交任务可稍后查询');
  }
  function jobPath(id) {
    if (!JOB_ID.test(String(id))) throw Error('无效的绘图任务编号');
    return path.join(jobsDir, id + '.json');
  }
  function readJob(id, chatKey) {
    const file = jobPath(id);
    if (!fs.existsSync(file)) return null;
    if (fs.lstatSync(file).isSymbolicLink()) throw Error('任务文件类型不正确');
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (job.chatKey !== chatKey) throw Error('只能查询或修改当前会话的绘图任务');
    return job;
  }
  function saveJob(job) {
    fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
    const dest = jobPath(job.id), tmp = dest + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, dest);
  }
  function imagePath(job) { return path.join(outputDir, job.id + '.png'); }
  function readOwnImage(job) {
    const file = imagePath(job);
    if (fs.lstatSync(file).isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== fs.realpathSync(outputDir)) throw Error('图片缓存路径不正确');
    return fs.readFileSync(file);
  }
  function prune(keep) {
    if (!fs.existsSync(jobsDir)) return;
    const done = [];
    for (const file of fs.readdirSync(jobsDir)) {
      if (!JOB_ID.test(file.replace(/\.json$/, ''))) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(jobsDir, file), 'utf8'));
        if (JOB_ID.test(j.id) && j.delivered) done.push(j);
      } catch { /* Preserve unrecognized or incomplete records. */ }
    }
    done.sort((a,b) => b.createdAt - a.createdAt);
    for (const j of done.slice(keep)) {
      fs.rmSync(imagePath(j), { force: true }); fs.rmSync(jobPath(j.id), { force: true });
    }
  }
  function note(ctx, type, text) {
    ctx.session?.sent?.push({ type, text, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
    try { ctx.emit?.('session-update', ctx.session?.id); } catch { /* UI refresh is best effort. */ }
  }
  function safeError(e) {
    // Do not include a signed QQ attachment URL or a full remote traceback in the LLM reply.
    return String(e?.message || e).replace(/https?:\/\/\S+/gi, '[地址省略]').slice(0, 400);
  }
  async function deliver(ctx, job, client, c, signal) {
    if (job.delivered) return `任务 ${job.id} 已在本会话发过图，不重复生成或发送。`;
    checkActive(ctx, signal);
    const file = imagePath(job);
    if (!job.downloaded || !fs.existsSync(file)) {
      const im = await client.history(job.promptId);
      if (!im) return null;
      const buffer = await client.output(im); checkActive(ctx, signal);
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      const tmp = file + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(tmp, buffer, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file);
      job.downloaded = true; job.generationSeconds = (Date.now() - job.submittedAt) / 1000;
      job.dimensions = imageInfo(buffer); saveJob(job);
    }
    checkActive(ctx, signal);
    // A timeout/crash after QQ accepted a send is ambiguous. Do not automatically send twice.
    if (job.sendState === 'uncertain' || job.sendState === 'sending') throw Error('上次发送结果未确认，已保留图片；先检查聊天记录，确认没收到后再明确请求补发');
    job.sendState = 'sending'; saveJob(job);
    try {
      readOwnImage(job); // realpath containment before handing a path to the official QQ client.
      await ctx.sender.sendImage(ctx.chatKey, { file }, { note: '本地绘图 · Qwen 2.1 Turbo' });
      job.delivered = true; job.sendState = 'sent'; job.deliveredAt = Date.now(); saveJob(job);
      note(ctx, 'image', '[图片:本地绘图 · Qwen 2.1 Turbo]');
    } catch (e) {
      job.sendState = 'uncertain'; saveJob(job);
      throw Error(`图片已生成并保存，但 QQ 发送未确认：${safeError(e)}。不要重新生成；确认没收到后使用 local_draw_result 补发`);
    }
    try { prune(c.keepImages); } catch { /* Never fail an already-delivered image because pruning failed. */ }
    api.log?.(`任务 ${job.id} 已发图；生成等待 ${job.generationSeconds.toFixed(1)}s`);
    return `已直接发送 1 张图片，${job.dimensions.width}×${job.dimensions.height}，生成等待约 ${job.generationSeconds.toFixed(1)} 秒，seed=${job.seed}，任务编号 ${job.id}。你没有看到图片内容，不要编造画面细节，也不要再调用发图工具。`;
  }
  async function guarded(ctx, work) {
    let lockKey, controller;
    try {
      const c = config(api.config());
      if (!ctx.chatKey || !ctx.sender?.sendImage) throw Error('缺少当前 QQ 会话或图片发送接口');
      checkActive(ctx);
      lockKey = c.baseUrl;
      if (locks.has(lockKey)) return fail('本地绘图正在处理另一项请求，本次尚未提交，请稍后再试。');
      locks.add(lockKey);
      controller = new AbortController(); controllers.add(controller);
      const client = createClient(c, api.fetch, controller.signal);
      return await work(c, client, controller.signal);
    } catch (e) {
      api.warn?.(safeError(e));
      return fail(safeError(e) + '。没有自动改用云端模型。');
    } finally {
      if (controller) { controllers.delete(controller); locks.delete(lockKey); }
    }
  }
  async function generate(ctx, args, mode) {
    return guarded(ctx, async (c, client, signal) => {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt || prompt.length > 3000) throw Error('请提供 1～3000 字的画面描述或改图要求');
      const count = args.count === undefined ? 1 : args.count;
      if (!Number.isInteger(count) || count < 1 || count > (mode === 'text' ? 2 : 1)) throw Error('文生图一次 1～2 张；改图一次 1 张');
      if (args.seed !== undefined && (!Number.isSafeInteger(args.seed) || args.seed < 0 || args.seed > 4294967294)) throw Error('seed 必须是 0～4294967294 的整数');
      const size = parseSize(args.size || c.defaultSize);
      const sourceJob = mode === 'edit' && args.source_job_id ? readJob(args.source_job_id, ctx.chatKey) : null;
      if (mode === 'edit' && args.source_job_id && !sourceJob?.downloaded) throw Error('参考绘图任务不存在或尚未完成');
      if (args.source_job_id && args.message_id) throw Error('参考来源只能选择消息或绘图任务之一');
      let sourceUrl;
      if (mode === 'edit' && !sourceJob) sourceUrl = resolveReference(ctx, args.message_id, args.image_index ?? 1);
      const reports = [];
      for (let index = 0; index < count; index++) {
        checkActive(ctx, signal);
        // Same tool retry in the same session reuses the persisted job, including after reload.
        const triggerIds = Array.isArray(ctx.session?.trigger) ? ctx.session.trigger.map(e => e.mid ?? e.id) : [];
        const request = [ctx.session?.id, triggerIds, ctx.chatKey, mode, prompt, size, args.seed, sourceUrl, sourceJob?.id, index];
        const hex = createHash('sha256').update(JSON.stringify(request)).digest('hex');
        const id = ctx.session?.id ? `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}` : randomUUID();
        let job = readJob(id, ctx.chatKey);
        if (job && job.baseUrl !== c.baseUrl) throw Error('该任务来自其他 ComfyUI 地址，先恢复原地址再查询；本次没有重新生成');
        if (!job) {
          await client.assertReady();
          let inputName;
          if (mode === 'edit') {
            const buffer = sourceJob ? readOwnImage(sourceJob) : (await downloadReference(sourceUrl, c.maxImageMB * 1048576)).buffer;
            checkActive(ctx, signal);
            inputName = await client.upload(buffer, id);
          }
          const seed = args.seed === undefined ? randomInt(0, 4294967295) : (args.seed + index) % 4294967295;
          job = { id, chatKey: ctx.chatKey, baseUrl: c.baseUrl, mode, seed, createdAt: Date.now(), submittedAt: Date.now(), promptId: randomUUID(), delivered: false };
          // Persist the caller-generated ComfyUI UUID BEFORE POST: a network failure never causes a duplicate.
          saveJob(job);
          if (c.notifyStart !== false && index === 0) {
            try {
              checkActive(ctx, signal);
              const text = '🎨 正在本地' + (mode === 'edit' ? '改图' : '绘图') + '，请稍等。';
              await ctx.sender.sendTextBatch(ctx.chatKey, [text]); note(ctx, 'text', text);
            } catch { /* An optional progress notice must not hide the actual output. */ }
          }
          checkActive(ctx, signal);
          job.submittedAt = Date.now(); saveJob(job);
          try {
            const graph = buildGraph(c, { prompt, seed, size, inputName, prefix: 'qqagent_comfy/' + id });
            const response = await client.json('/prompt', { prompt: graph, prompt_id: job.promptId });
            if (response.prompt_id !== job.promptId) throw Error('ComfyUI 未保留客户端任务编号，请检查版本');
          } catch (e) {
            return fail(`任务 ${id} 提交未确认：${safeError(e)}。请用 local_draw_result 查询，勿重复生成。已发送 ${reports.length} 张。`);
          }
        }
        const deadline = Date.now() + c.timeoutMs;
        try {
          while (Date.now() < deadline) {
            checkActive(ctx, signal);
            const report = await deliver(ctx, job, client, c, signal);
            if (report) { reports.push(report); break; }
            await sleep(pollMs, undefined, { signal });
          }
          if (reports.length !== index + 1) return fail(`等待超时；任务 ${id} 可能还在生成。用 local_draw_result 查询取图，不要重新生成。已完成 ${reports.length} 张。`);
        } catch (e) {
          return fail(`任务 ${id}：${safeError(e)}。已完成 ${reports.length} 张；不要重复生成，可用 local_draw_result 查询。`);
        }
      }
      return { content: reports.join('\n') };
    });
  }
  async function collect(ctx, args) {
    return guarded(ctx, async (c, client, signal) => {
      const job = readJob(args?.job_id, ctx.chatKey);
      if (!job) throw Error('当前会话没有这个绘图任务，或图片已按保留数量清理');
      if (job.baseUrl !== c.baseUrl) throw Error('任务的 ComfyUI 地址与当前设置不同，请先恢复原地址');
      if (args.resend === true) {
        job.delivered = false; job.sendState = 'retry'; saveJob(job);
      }
      const content = await deliver(ctx, job, client, c, signal);
      return { content: content || `任务 ${job.id} 暂无结果（仍在排队、运行、提交失败或历史已清理），没有重新提交。` };
    });
  }
  return {
    setup(value) {
      api = value;
      api.registerTool({
        id: 'local_draw', name: '本地绘图', category: 'media', icon: '🎨',
        description: '用户明确要求画图、头像、插画或写实时调用。本地 Qwen-Image-2.1-Turbo 文生图，支持中英文自然语言，通常数十秒。图片会直接发到当前会话。需要参考图片时用 local_edit。报错或超时不要自动改用云端或重新生成，用 local_draw_result 查任务。',
        parameters: { type: 'object', properties: {
          prompt: { type: 'string', description: '画面描述；主体、场景、风格、构图、光线；中文原文和精确文字要求应保留。' },
          size: { type: 'string', description: '可选，默认 768x768；头像 768x768，竖图 640x960，横图 960x640，高清方图 1024x1024。' },
          count: { type: 'integer', minimum: 1, maximum: 2, description: '可选，1～2 张，默认 1，逐张生成。' },
          seed: { type: 'integer', description: '可选，0～4294967294，默认随机；用户要求复现时填写。' },
        }, required: ['prompt'] }, execute: (ctx, args) => generate(ctx, args, 'text'),
      });
      api.registerTool({
        id: 'local_edit', name: '本地参考图修改', category: 'media', icon: '🖌️',
        description: '用户发来图片并要求换色、换背景、转换画风或保留主体修改时调用，使用本地 Qwen 2.1 Turbo。参考图只能来自当前会话消息或本会话已生成的任务。只指定一个来源；均省略则只取本轮唯一的图片消息。保持参考图宽高比，图片直接发出。',
        parameters: { type: 'object', properties: {
          prompt: { type: 'string', description: '具体修改要求，说明哪些改动、哪些保持不变；单张参考图可称为 <image1>。' },
          message_id: { type: 'string', description: '可选，当前会话图片消息的完整 ID，原样复制，不转数字；本地消息序号写成 #123。' },
          image_index: { type: 'integer', minimum: 1, maximum: 10, description: '可选，该消息中的第几张图片，默认 1。' },
          source_job_id: { type: 'string', description: '可选，修改机器人刚画的图时填它返回的任务编号，与 message_id 二选一。' },
        }, required: ['prompt'] }, execute: (ctx, args) => generate(ctx, args, 'edit'),
      });
      api.registerTool({
        id: 'local_draw_result', name: '查询或补发绘图结果', category: 'media', icon: '🖼️',
        description: '查询本会话绘图任务并发送已生成但未发送的图片，不重新生成。超时或提交未确认时调用。仅用户明确表示没收到、要求再发时才能将 resend 设为 true；否则默认不重复发送。',
        parameters: { type: 'object', properties: {
          job_id: { type: 'string', description: 'local_draw/local_edit 返回的完整绘图任务编号。' },
          resend: { type: 'boolean', description: '仅用户确认需要再次发送时为 true，默认 false。' },
        }, required: ['job_id'] }, execute: collect,
      });
      api.log?.('本地绘图 v2.0.0 已加载：Qwen 2.1 Turbo / Docker 网络模式 / 文生图 + 改图');
    },
    available() { try { config(api?.config?.()); return { ok: true }; } catch (e) { return { ok: false, reason: safeError(e) }; } },
    activate() { enabled = true; },
    deactivate() { enabled = false; for (const c of controllers) c.abort(); },
    dispose() { enabled = false; for (const c of controllers) c.abort(); },
  };
}
