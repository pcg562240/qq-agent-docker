import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { messageImageReferences } from '../../src/message-quotes.js';
import { ServiceError, settings, client, createCatalog, digest, writePrivate, readPrivate,
  imageSize, imageQuality, imageType, fail, publicError } from '../../src/chatgpt2api-client.js';

const locks = globalThis[Symbol.for('qq-agent.chatgpt2api-image.locks')] ||= new Set();
const JOB = /^[a-f0-9]{32}$/;

export function referenceUrl(ctx, ref = {}) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(k => !['message_id','image_index'].includes(k))) throw new ServiceError('参考图只接受当前会话消息 ID 和图片序号，不接受 URL 或文件路径');
  const find = mid => ctx.store?.findByMid(ctx.chatKey, String(mid));
  let entry;
  if (ref.message_id) {
    const mid = ref.message_id;
    if (typeof mid !== 'string' || mid.length > 512) throw new ServiceError('图片消息 ID 必须是完整字符串');
    // Display-only '#' is accepted only after an exact same-chat lookup fails;
    // never fuzzy-match a truncated QQ message ID or borrow the latest message.
    entry = find(mid) || (mid.startsWith('#') ? find(mid.slice(1)) : null);
    if (!entry && /^#\d+$/.test(mid)) entry = ctx.store?.findByLocalId(ctx.chatKey, Number(mid.slice(1)));
  } else {
    const candidates = (Array.isArray(ctx.session?.trigger) ? ctx.session.trigger : [])
      .filter(e => !e.self && !e.recalled && messageImageReferences(e, find).length);
    if (candidates.length !== 1) throw new ServiceError('本轮没有唯一的参考图消息，请指定本会话图片消息 ID，或将图片和编辑要求一起发送');
    entry = candidates[0];
  }
  if (!entry || entry.recalled || (entry.chatKey && entry.chatKey !== ctx.chatKey)) throw new ServiceError('当前会话找不到这条图片消息，请重新发送图片');
  const index = ref.image_index ?? 1;
  if (!Number.isInteger(index) || index < 1 || index > 20) throw new ServiceError('图片序号必须是 1～20');
  const url = messageImageReferences(entry, find)[index - 1]?.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new ServiceError('参考图片缺失或过期，请重新发送');
  return url;
}

export function createImageSkill({ dataDir, download, pollMs = 1500 }) {
  const id = 'chatgpt2api-image', dir = path.join(dataDir, 'skill-data', id, 'jobs');
  const mediaDir = path.join(dataDir, 'media', id);
  let api, active = true;
  const controllers = new Set();
  const catalog = createCatalog({ dataDir, id, getSettings: () => api.config(), getFetch: () => api.fetch, images: true });
  const jobPath = jobId => {
    if (!JOB.test(String(jobId))) throw new ServiceError('无效的任务编号');
    return path.join(dir, jobId + '.json');
  };
  const save = job => writePrivate(jobPath(job.id), job);
  function read(jobId, chatKey, scope) {
    const job = readPrivate(jobPath(jobId));
    if (job && (job.chatKey !== chatKey || job.scope !== scope)) throw new ServiceError('任务不属于当前会话或当前服务/密钥；请恢复原连接设置后查询');
    return job;
  }
  function check(ctx, signal) {
    if (signal?.aborted || !active || ['aborted', 'discarded', 'error'].includes(ctx.session?.status)) throw new ServiceError('绘图等待已停止；已提交任务可稍后按编号查询，不自动补发');
  }
  function outputFile(job) {
    if (!['png','jpg','webp'].includes(job.ext)) throw new ServiceError('图片尚未下载');
    const file = path.join(mediaDir, job.id + '.' + job.ext);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== fs.realpathSync(mediaDir)) throw new ServiceError('本地结果缺失，请查询原任务；不要重新生成');
    return file;
  }
  function prune() {
    if (!fs.existsSync(dir)) return;
    const jobs = fs.readdirSync(dir).filter(f => /^[a-f0-9]{32}\.json$/.test(f)).map(f => readPrivate(path.join(dir, f)));
    for (const job of jobs.filter(j => j?.delivered && JOB.test(j.id)).sort((a,b) => b.createdAt - a.createdAt).slice(100)) {
      if (['png','jpg','webp'].includes(job.ext)) fs.rmSync(path.join(mediaDir, job.id + '.' + job.ext), { force: true });
      fs.rmSync(jobPath(job.id), { force: true });
    }
    if (fs.readdirSync(dir).length >= 1000) throw new ServiceError('待保留任务过多，请管理员检查历史任务后再生成');
  }
  async function deliver(ctx, job, c, net, signal, resend) {
    check(ctx, signal);
    if (job.delivered) return `任务 ${job.id} 已在本会话发过，不重复生成或发送。`;
    if (job.ext) { outputFile(job); }
    else {
      const r = await net.request('/api/image-tasks?ids=' + job.id, { timeoutMs: 30000 });
      const task = r?.items?.find(t => t.id === job.id);
      if (!task) throw new ServiceError('上游尚未找到任务，或已过保留期/密钥身份变化；本次没有重新提交');
      if (task.status === 'error') throw new ServiceError('上游任务失败，请在 chatgpt2api 查看该任务；没有自动重画或换模型');
      if (['queued', 'running'].includes(task.status)) return null;
      if (task.status !== 'success' || !Array.isArray(task.data) || task.data.length !== 1) throw new ServiceError('任务没有返回恰好一张有效图片');
      const image = await net.image(task.data[0]); check(ctx, signal);
      fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
      const file = path.join(mediaDir, job.id + '.' + image.ext);
      const tmp = file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(tmp, image.bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
      finally { fs.rmSync(tmp, { force:true }); }
      job.ext = image.ext; job.readyAt = Date.now(); save(job);
    }
    check(ctx, signal);
    if (['sending', 'uncertain'].includes(job.sendState) && !resend) throw new ServiceError('上次 QQ 发送结果未确认；先检查聊天，用户明确确认没收到后才用 result 的 resend_confirmed 补发');
    job.sendState = 'sending'; save(job);
    try {
      await ctx.sender.sendImage(ctx.chatKey, { file: outputFile(job) }, { note: 'ChatGPT 绘图' });
      job.delivered = true; job.sendState = 'sent'; save(job);
      ctx.session?.sent?.push({ type:'image', text:'[图片:ChatGPT 绘图]', at:new Date().toLocaleTimeString('zh-CN', { hour12:false }) });
      try { ctx.emit?.('session-update', ctx.session?.id); } catch { /* UI notification is best effort. */ }
    } catch {
      job.sendState = 'uncertain'; save(job);
      throw new ServiceError('图片已缓存，但 QQ 发送结果未确认。不要重新生成，确认未收到后再按任务编号补发');
    }
    return `已直接发送 1 张图片。任务 ${job.id}；请求模型 ${job.model}。不要再发图或编造画面细节。`;
  }
  async function guarded(ctx, work) {
    const controller = new AbortController(); controllers.add(controller);
    try {
      if (!ctx.chatKey || !ctx.session?.id || !ctx.sender?.sendImage) throw new ServiceError('缺少当前会话和图片发送上下文');
      check(ctx, controller.signal);
      const c = settings(api.config());
      return await work(c, client(c, api.fetch, controller.signal), controller.signal);
    } catch (e) { return fail(publicError(e)); }
    finally { controllers.delete(controller); }
  }
  async function locked(jobId, work) {
    const key = dir + ':' + jobId;
    if (locks.has(key)) throw new ServiceError(`任务 ${jobId} 正在处理中，未重复提交`);
    if ([...locks].filter(k => k.startsWith(dir + ':')).length >= 2) throw new ServiceError('本技能已有两项请求处理中，本次尚未提交');
    locks.add(key); try { return await work(); } finally { locks.delete(key); }
  }
  async function draw(ctx, args = {}) {
    return guarded(ctx, async (c, net, signal) => {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt || prompt.length > 6000) throw new ServiceError('请提供 1～6000 字的画面描述/编辑要求');
      const count = args.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 4) throw new ServiceError('一次生成数量必须是 1～4');
      const size = imageSize(args.size || c.defaultSize), quality = imageQuality(args.quality || c.quality);
      const mode = args.mode || 'generate';
      if (!['generate','edit'].includes(mode)) throw new ServiceError('mode 必须是 generate 或 edit');
      if (args.references !== undefined && !Array.isArray(args.references)) throw new ServiceError('references 必须是数组');
      if (mode === 'generate' && (args.references?.length || args.mask)) throw new ServiceError('带参考图时请使用 edit 模式');
      const refs = mode === 'edit' ? (args.references?.length ? args.references : [{}]) : [];
      if (refs.length > 4) throw new ServiceError('最多使用 4 张参考图');
      const urls = refs.map(ref => referenceUrl(ctx, ref));
      const maskUrl = mode === 'edit' && args.mask ? referenceUrl(ctx, args.mask) : null;
      const reports = [];
      for (let i = 0; i < count; i++) {
        const jobId = digest([ctx.session.id, ctx.chatKey, c.scope, c.model, mode, prompt, size, quality, refs, maskUrl, i]).slice(0,32);
        const result = await locked(jobId, async () => {
          let job = read(jobId, ctx.chatKey, c.scope);
          if (!job) {
            prune();
            const images = [];
            for (const url of [...urls, ...(maskUrl ? [maskUrl] : [])]) {
              check(ctx, signal);
              let b;
              try { b = (await download(url, c.maxImageBytes)).buffer; } catch { throw new ServiceError('参考图片安全下载失败，请重发；未向上游提交'); }
              const { mime } = imageType(b, c.maxImageBytes);
              if (maskUrl && images.length === urls.length && mime !== 'image/png') throw new ServiceError('遮罩须为 PNG 图片；未向上游提交');
              images.push({ b64_json:b.toString('base64'), mime_type:mime });
            }
            check(ctx, signal);
            job = { id:jobId, chatKey:ctx.chatKey, scope:c.scope, model:c.model, createdAt:Date.now(), delivered:false };
            save(job); // Write before POST; even an unknown outcome is never blindly resubmitted.
            try {
              const r = await net.request('/api/image-tasks/' + (mode === 'edit' ? 'edits' : 'generations'), {
                timeoutMs: 30000, body: { client_task_id:jobId, prompt, model:c.model, size, quality,
                  ...(mode === 'edit' ? { images: images.slice(0, urls.length), ...(maskUrl ? { mask:images.at(-1) } : {}) } : {}) }
              });
              if (r?.id !== jobId) throw new ServiceError('上游未确认客户端任务编号');
            } catch (e) { return fail(`任务 ${jobId}：${publicError(e)}。请用 result 查询，不要重新生成。`); }
          }
          try {
            const deadline = Date.now() + c.timeoutMs;
            do {
              const done = await deliver(ctx, job, c, net, signal, false);
              if (done) return { content:done };
              await sleep(pollMs, undefined, { signal });
            } while (Date.now() < deadline);
            throw new ServiceError('等待超时，任务可能仍在生成；用 result 查询取图，不要重新生成');
          } catch (e) { return fail(`任务 ${jobId}：${publicError(e)}`); }
        });
        reports.push(result.content);
        if (result.isError) return fail(reports.join('\n'));
      }
      return { content:reports.join('\n') };
    });
  }
  const refSchema = { type:'object', properties:{ message_id:{ type:'string', description:'当前会话的完整图片消息 ID；留空使用本轮唯一带图消息，含引用图' }, image_index:{ type:'integer', description:'该消息中的第几张图片，从 1 起' } } };
  return {
    setup(a) {
      api = a;
      api.registerTool({ id:'draw', name:'ChatGPT 生图/改图', category:'media', description:'使用 chatgpt2api 文生图，或根据本会话参考图进行图生图/自然语言编辑；可传最多四张参考图和可选 mask。直接发图，失败/超时只查询原任务，不重复生成。', parameters:{ type:'object', properties:{
        prompt:{ type:'string', description:'画面描述或编辑要求，中文或英文均可；保留用户意图' }, mode:{ type:'string', enum:['generate','edit'], description:'generate 文生图；edit 参考图/编辑' }, count:{ type:'integer', description:'1～4 张，默认 1，逐张提交' }, size:{ type:'string', description:'auto 原尺寸，或 512x512 等；显式尺寸由服务端后处理，不保证更快' }, quality:{ type:'string', enum:['auto','low','medium','high'], description:'网页质量提示要求，不保证原生档位' }, references:{ type:'array', items:refSchema, description:'编辑参考图（当前会话），最多 4 张' }, mask:{ ...refSchema, description:'可选 PNG 遮罩消息引用；实际遮罩遵循程度由上游决定' }
      }, required:['prompt'] }, execute:draw });
      api.registerTool({ id:'result', name:'查询 ChatGPT 绘图任务', category:'media', description:'按任务编号查询本会话已提交的图片，完成则取图发送。只查询，不新建任务。上次发送未知时须用户明确确认没收到才能补发。', parameters:{ type:'object', properties:{ job_id:{type:'string',description:'draw 返回的完整任务编号'}, resend_confirmed:{type:'boolean',description:'仅当用户明确确认未收到并要求补发时为 true'} },required:['job_id'] },
        execute:(ctx,args) => guarded(ctx, async (c,net,signal) => locked(args.job_id, async () => {
          const job = read(args.job_id,ctx.chatKey,c.scope);
          if (!job) throw new ServiceError('当前会话没有该任务');
          try { return { content:await deliver(ctx,job,c,net,signal,args.resend_confirmed === true) || `任务 ${job.id} 仍在排队或生成，稍后再查询；不要新建同一请求。` }; }
          catch(e) { return fail(`任务 ${job.id}：${publicError(e)}`); }
        })) });
    },
    available() { try { settings(api?.config()); return {ok:true}; } catch(e) { return {ok:false,reason:publicError(e)}; } },
    modelCatalog:catalog,
    activate() { active = true; },
    deactivate() { active = false; for (const c of controllers) c.abort(); },
    dispose() { active = false; for (const c of controllers) c.abort(); }
  };
}
