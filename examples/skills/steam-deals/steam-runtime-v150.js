import { scanDeals, renderDealsCompact, initSteam, resolveCurrencyCode, getRate,
  convertCents, listGenreNames } from './steam-data-v150.js'

function gate(ctx, cfg) {
  if (ctx.kind === 'private' || cfg.mentionOnly === false) return ''
  if (ctx.session?.trigger?.some((e) => e.atMe || e.pokeMe)) return ''
  const tier = Number(ctx.session?.contextTier)
  if (tier === 1 || !Number.isFinite(tier)) return ''
  return '本次群聊未点名机器人，不主动发送 Steam 清单。'
}

function note(ctx, type, text) {
  ctx.session?.sent?.push({ type, text, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) })
  try { ctx.emit?.('session-update', ctx.session?.id) } catch {}
}

const safeError = (e) => String(e?.message || e).replace(/https?:\/\/\S+/g, '[地址省略]').slice(0, 260)

export function createSkill(deps = {}) {
  let cfgOf = () => ({})
  let log = () => {}
  let busy = false
  function setup(api) {
    cfgOf = () => api.config?.() || {}
    log = (...a) => { try { api.log?.(...a) } catch {} }
    initSteam({ ...deps, config: cfgOf, log, fetch: api.fetch || deps.fetch || globalThis.fetch })
    api.registerTool({
      id: 'deals', name: '查 Steam 史低好价', category: 'utility', icon: '🎮',
      description: '用户问 Steam 打折、史低好价、什么值得买时使用。查询中国区 Steam 当前折扣，按 Steam 自身历史低价标出新史低/平史低，其他条目明确标注普通折扣或史低待核实。工具自己发消息；status ok/no-results 后直接结束，不重复发送。error 如实解释，不能说成没有折扣。',
      parameters: { type: 'object', properties: {
        count: { type: 'number', description: '5~20 款；留空用设置。' },
        genre: { type: 'string', description: '用户指定的分类，如赛车、射击、恐怖；没提就不填。' },
        currency: { type: 'string', description: '临时换算货币，如 USD、美元。仅中国区价格换算，不切换商店地区。' }
      } },
      async execute(ctx, args = {}) {
        const cfg = cfgOf()
        const deny = gate(ctx, cfg)
        if (deny) return { content: `status: no-target\n${deny}`, isError: true }
        if (!String(cfg.itadKey || '').trim()) return { content: 'status: error\n请先在技能设置中填写 ITAD API Key；未进行史低查询。', isError: true }
        if (!ctx.sender || !ctx.chatKey) return { content: 'status: error\n缺少消息发送通道。', isError: true }
        const currency = args.currency ? resolveCurrencyCode(args.currency) : undefined
        if (args.currency && !currency) return { content: 'status: error\n未识别该计价货币，请使用 CNY / USD 等货币代码。', isError: true }
        if (busy) return { content: 'status: error\n另一次 Steam 查询正在执行，请等它结束后再查。', isError: true }
        busy = true
        let sent = 0
        try {
          const officialQQ = ctx.onebot?.kind === 'qqbot'
          const result = await (deps.scanDeals || scanDeals)({ count: args.count, genre: args.genre,
            currency, rotationKey: ctx.chatKey, coverLimit: officialQQ ? 1 : undefined })
          if (result.unknownGenre) return { content: `status: error\n没有「${result.unknownGenre}」这个分类，可用：${listGenreNames().join('、')}`, isError: true }
          const { items, stats, notices, rate, rateError, genre } = result
          const rendered = renderDealsCompact(items, stats, { currency: result.currency, rate, rateError, notices,
            perBubble: cfg.perBubble, genreName: genre?.name, withCovers: cfg.showCover !== false && !officialQQ, showLink: cfg.showLink === true })
          // Official QQ only accepts one segment. Keep the list in text, with at most
          // one separate cover, rather than sending unsupported mixed-media segments.
          if (officialQQ || typeof ctx.sender.sendMedia !== 'function') {
            if (typeof ctx.sender.sendTextBatch !== 'function') throw new Error('通道不支持文字发送')
            const r = await ctx.sender.sendTextBatch(ctx.chatKey, [rendered.plain], {})
            const records = Array.isArray(r?.sent) ? r.sent : [{ text: rendered.plain }]
            for (const record of records) {
              note(ctx, 'text', record.text)
              if (!record.deduped) sent++
            }
            if (r?.failed?.length) throw new Error(`清单部分发送失败（${r.failed.length} 条），不要重发整份清单`)
            if (cfg.showCover !== false && items[0]?.coverPath && ctx.sender.sendImage) {
              try {
                await ctx.sender.sendImage(ctx.chatKey, { file: items[0].coverPath }, { note: items[0].name })
                sent++
                note(ctx, 'image', `Steam 封面：${items[0].name}`)
              } catch (e) { log(`文字清单已发送，附图跳过：${safeError(e)}`) }
            }
          } else {
            // Retain the old optional illustration on Windows OneBot only. Its
            // helper starts Windows executables; never run it inside Docker/macOS.
            if (cfg.pixivImage !== false && process.platform === 'win32' && items.length) {
              try {
                const pixiv = await import('./pixiv-fetch.js')
                pixiv.initPixiv({ log })
                const image = await pixiv.fetchOneImage('デフォルメ', { timeoutMs: 10000 })
                if (image?.path) rendered.bubbles.at(-1).push({ type: 'image', data: { file: image.path } })
              } catch { log('可选配图未取到，继续发送清单') }
            }
            for (const segments of rendered.bubbles) {
              await ctx.sender.sendMedia(ctx.chatKey, segments, { label: 'Steam 折扣与史低' })
              sent++
              note(ctx, 'text', segments.filter((s) => s.type === 'text').map((s) => s.data.text).join('\n'))
            }
          }
          const historical = items.filter((it) => it.lowLevel).length
          log(`Steam 清单已发出：${items.length} 款，其中 ${historical} 款史低，${sent} 条新消息`)
          return { content: `status: ${items.length ? 'ok' : 'no-results'}\n查询结果已发送：${items.length} 款折扣，其中 ${historical} 款已核实史低，共 ${sent} 条新消息。不要再用 send_message 复述，不要自行补推荐，直接结束本轮。` }
        } catch (e) {
          log(`Steam 查询/发送失败：${safeError(e)}`)
          return { content: `status: error\n${safeError(e)}。${sent ? `已经发出 ${sent} 条，不要重复发送。` : '本次未发出清单。'}这是查询或发送失败，不代表没有折扣。`, isError: true }
        } finally { busy = false }
      }
    })
    api.registerTool({
      id: 'currency', name: '设置计价货币', category: 'utility', icon: '💱',
      description: '用户明确要求切换 Steam 清单显示货币时使用；只改中国区售价的换算显示，不切换国家商店。留空查当前货币。',
      parameters: { type: 'object', properties: { currency: { type: 'string', description: '币种或国家名，如 USD、美元；留空查询。' } } },
      async execute(_ctx, args = {}) {
        const current = resolveCurrencyCode(cfgOf().currency) || 'CNY'
        if (!args.currency) return { content: `当前显示货币：${current}；数据口径始终为中国区 Steam。` }
        const code = resolveCurrencyCode(args.currency)
        if (!code) return { content: '未识别该货币，设置未改动。', isError: true }
        const rate = await getRate(code)
        if (!(rate > 0)) return { content: '汇率获取失败，设置未改动。', isError: true }
        try {
          const after = deps.setSkillConfig?.('steam-deals', { currency: code })
          if (after?.currency !== code) throw new Error('设置保存失败')
          return { content: `已改为 ${code}：¥100 ≈ ${convertCents(10000, rate, code)}。这是中国区价格换算，不是其他地区售价。` }
        } catch { return { content: '货币设置保存失败，请在技能设置页重试。', isError: true } }
      }
    })
    log('Steam 史低好价 v1.5.0 已就绪（Node 请求 / Docker / 官方 QQ 适配）')
  }
  return { setup, available: () => true, dispose: () => { cfgOf = () => ({}); log = () => {} } }
}
export const internals = { gate }
