// Steam / ITAD data client, cross-platform Node.js 22+.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { cleanTitle, hasChinese, lookupDict, translateViaDeepSeek } from './game-names-v150.js'

const STEAM = 'https://store.steampowered.com'
const ITAD = 'https://api.isthereanydeal.com'
let cfgOf = () => ({})
let log = () => {}
let request = globalThis.fetch
let downloadBinary = null
let cacheDir = ''
let translationConfig = () => ({})
const listCache = new Map()
const rotationCounter = new Map()
const metadata = new Map()

export function initSteam(options = {}) {
  cfgOf = options.config || (() => ({}))
  log = options.log || (() => {})
  request = options.fetch || globalThis.fetch
  downloadBinary = options.downloadBinary || null
  cacheDir = options.dataDir ? path.join(options.dataDir, 'media', 'steam-deals') : ''
  translationConfig = options.translationConfig || (() => ({}))
  listCache.clear()
  rotationCounter.clear()
  metadata.clear()
  rateCache = null
}

function boundedInt(v, min, max, fallback) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}

// Never put credentials, arbitrary server bodies or request URLs into error messages.
async function requestJson(url, options = {}, timeoutMs = 15000) {
  const label = new URL(url).hostname
  try {
    const r = await request(url, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'QQ-Agent-Steam-Deals/1.5', 'Accept-Language': 'zh-CN', ...options.headers }
    })
    if (!r.ok) {
      await r.body?.cancel()
      throw new Error(`HTTP ${r.status}`)
    }
    const limit = 8 * 1024 * 1024
    const chunks = []
    let size = 0
    for await (const chunk of r.body) {
      size += chunk.byteLength
      if (size > limit) throw new Error('响应过大')
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new Error('响应不是有效 JSON') }
  } catch (e) {
    const message = String(e?.message || '')
    const known = /^(HTTP \d{3}|响应过大|响应不是有效 JSON)$/.test(message)
    throw new Error(`${label}：${known ? message : (e?.name === 'TimeoutError' ? '请求超时' : '网络请求失败')}`)
  }
}

const getJson = (url, timeoutMs) => requestJson(url, {}, timeoutMs)

async function itadPost(endpoint, body, query = {}) {
  const key = String(cfgOf().itadKey || '').trim()
  if (!key) throw new Error('缺少 ITAD API Key')
  const url = new URL(ITAD + endpoint)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  return requestJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'ITAD-API-Key': key },
    body: JSON.stringify(body)
  })
}

async function cachedList(key, loader) {
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < 120000) return hit.value
  const value = await loader() // A failed request is never cached as an empty list.
  if (listCache.size >= 64) listCache.delete(listCache.keys().next().value)
  listCache.set(key, { at: Date.now(), value })
  return value
}

async function fetchFeatured() {
  return cachedList('featured', async () => {
    const d = await getJson(`${STEAM}/api/featuredcategories?cc=cn&l=schinese`)
    if (!Array.isArray(d?.specials?.items) || !Array.isArray(d?.top_sellers?.items)) {
      throw new Error('Steam 特惠榜响应格式变化')
    }
    const out = []
    for (const section of ['specials', 'top_sellers']) {
      for (const it of d[section].items) {
        if (it.currency && it.currency !== 'CNY') continue
        if (Number(it.discount_percent) <= 0) continue
        out.push({ appid: Number(it.id), name: String(it.name || ''), cut: Number(it.discount_percent),
          final: numOrNull(it.final_price), original: numOrNull(it.original_price),
          expiry: Number(it.discount_expiration) || 0 })
      }
    }
    return out
  })
}

const decodeName = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

async function fetchSearchSpecials(pages = 2, tagId = null, offset = 0) {
  return cachedList(`search:${pages}:${tagId}:${offset}`, async () => {
    const out = []
    for (let page = 0; page < pages; page++) {
      const start = offset + page * 50
      const u = new URL(`${STEAM}/search/results/`)
      u.search = new URLSearchParams({ query: '', start: String(start), count: '50', specials: '1',
        filter: 'topsellers', infinite: '1', cc: 'cn', l: 'schinese', ...(tagId ? { tags: String(tagId) } : {}) })
      const d = await getJson(u)
      if (typeof d?.results_html !== 'string' || !Number.isFinite(Number(d?.total_count))) {
        throw new Error('Steam 搜索响应格式变化')
      }
      let appRows = 0
      let parsed = 0
      for (const block of d.results_html.split('</a>')) {
        const appid = Number(/data-ds-appid="(\d+)"/.exec(block)?.[1])
        if (!appid) continue // Exclude bundles/subscriptions and multi-app packages.
        appRows++
        const name = /<span class="title">([^<]+)<\/span>/.exec(block)?.[1]
        const cut = Number(/-(\d+)%/.exec(block)?.[1])
        const price = (cls) => {
          const raw = new RegExp(`<div class="${cls}">([^<]+)</div>`).exec(block)?.[1]
          if (!raw || !/[¥￥]|CNY|RMB/.test(raw)) return null
          const n = /\d+(?:\.\d+)?/.exec(raw.replaceAll(',', ''))?.[0]
          return n ? Math.round(Number(n) * 100) : null
        }
        const final = price('discount_final_price')
        const original = price('discount_original_price')
        if (!name || !Number.isFinite(cut) || final == null || original == null) continue
        parsed++
        if (cut > 0) out.push({ appid, name: decodeName(name), cut, final, original, expiry: 0 })
      }
      if (appRows > 0 && parsed === 0) throw new Error('Steam 搜索价格格式变化，未取得人民币价格')
      if (Number(d.total_count) > start && !d.results_html.trim()) throw new Error('Steam 搜索返回了不完整的列表')
      if (start + 50 >= Number(d.total_count)) break
    }
    return out
  })
}

async function mapConcurrent(items, worker, concurrency = 6) {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++])
  }))
}

async function fetchReviews(appids) {
  const out = new Map()
  await mapConcurrent(appids, async (id) => {
    try {
      const d = await getJson(`${STEAM}/appreviews/${id}?json=1&language=all&purchase_type=all&num_per_page=0`)
      const total = numOrNull(d?.query_summary?.total_reviews)
      if (total == null) throw new Error('评测响应格式变化')
      out.set(id, { total })
    } catch (e) { out.set(id, { failed: true, error: e.message }) }
  })
  return out
}

async function lookupItadIds(appids) {
  if (!appids.length) return {}
  const data = await itadPost('/lookup/id/shop/61/v1', appids.map((id) => `app/${id}`))
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('ITAD 游戏映射格式变化')
  return data
}

async function fetchItadPrices(uuids) {
  if (!uuids.length) return new Map()
  const data = await itadPost('/games/prices/v3', uuids, { country: 'CN', deals: true, shops: 61 })
  if (!Array.isArray(data)) throw new Error('ITAD 价格响应格式变化')
  const map = new Map()
  for (const entry of data) {
    // historyLow.all aggregates OTHER SHOPS too. Only Steam's own storeLow is relevant.
    const deal = entry.deals?.find((d) => Number(d?.shop?.id) === 61 && d.price?.currency === 'CNY')
    if (!deal) continue
    map.set(entry.id, {
      storeLow: deal.storeLow?.currency === 'CNY' ? numOrNull(deal.storeLow.amountInt) : null,
      expiry: String(deal.expiry || '')
    })
  }
  return map
}

export function classifyLow(current, storeLow) {
  if (current == null || storeLow == null) return { level: null, label: '史低待核实' }
  if (current < storeLow) return { level: 'newLow', label: '新史低' }
  if (current === storeLow) return { level: 'tieLow', label: '平史低' }
  return { level: null, label: '普通折扣' }
}

async function enrichNames(items, translate = true) {
  await mapConcurrent(items, async (it) => {
    let n = metadata.get(it.appid)
    if (!n || Date.now() - n.at > 86400000) {
      try {
        const d = await getJson(`${STEAM}/api/appdetails?appids=${it.appid}&cc=cn&l=schinese`)
        const data = d?.[it.appid]?.data
        if (data?.name) {
          n = { name: data.name, image: data.header_image || '', at: Date.now() }
          if (metadata.size >= 400) metadata.delete(metadata.keys().next().value)
          metadata.set(it.appid, n)
        }
      } catch { /* Display the name obtained from the already verified Steam listing. */ }
    }
    it.name = cleanTitle(n?.name || it.name)
    it.zhTitle = hasChinese(it.name) ? it.name : lookupDict(it.name) || ''
    it.enTitle = hasChinese(it.name) ? '' : it.name
    it.imageUrl = n?.image || ''
  })
  const rest = items.filter((it) => !it.zhTitle && it.enTitle)
  if (translate && rest.length) {
    try {
      const translated = await translateViaDeepSeek(rest.map((it) => it.enTitle), translationConfig())
      for (const it of rest) if (hasChinese(translated[it.enTitle])) it.zhTitle = cleanTitle(translated[it.enTitle])
    } catch { log('译名补全暂不可用，保留 Steam 原名') }
  }
}

async function downloadCover(url, appid) {
  if (!cacheDir || !downloadBinary || !/^\d+$/.test(String(appid))) return null
  let u
  try { u = new URL(url) } catch { return null }
  const domains = ['steamstatic.com', 'steamusercontent.com', 'akamaihd.net']
  if (u.protocol !== 'https:' || !domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))) return null
  const out = path.join(cacheDir, `cover-${appid}.jpg`)
  const temp = `${out}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    try { if ((await fs.stat(out)).size > 500) return out } catch {}
    const r = await downloadBinary(url, 5 * 1024 * 1024)
    const buffer = r.buffer
    if (!buffer || buffer.length < 500 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('非 JPEG 封面')
    await fs.writeFile(temp, buffer)
    await fs.rename(temp, out)
    return out
  } catch { log(`封面未取到 appid=${appid}，保留文字结果`); return null }
  finally { await fs.rm(temp, { force: true }).catch(() => {}) }
}

export async function scanDeals(opts = {}) {
  const cfg = cfgOf()
  const count = boundedInt(opts.count ?? cfg.maxItems, 5, 20, 10)
  const minReviews = boundedInt(cfg.minReviews, 0, 500000, 5000)
  const pages = boundedInt(cfg.searchPages, 1, 6, 2)
  const maxCandidates = boundedInt(cfg.maxCandidates, 10, 200, 70)
  const genre = opts.genre ? resolveGenre(opts.genre) : null
  if (opts.genre && !genre) return { unknownGenre: String(opts.genre) }
  const rotationKey = `${opts.rotationKey || ''}:${genre?.key || 'all'}`
  const rotation = rotationCounter.get(rotationKey) || 0
  const offset = rotation % boundedInt(cfg.rotatePages, 1, 5, 2) * 50
  const sources = [fetchSearchSpecials(pages, genre?.id, offset)]
  if (!genre) sources.push(fetchFeatured())
  const loaded = await Promise.allSettled(sources)
  const notices = loaded.filter((r) => r.status === 'rejected').map((r) => r.reason.message)
  const good = loaded.filter((r) => r.status === 'fulfilled')
  if (!good.length) throw new Error(`Steam 数据源全部失败：${notices.join('；')}`)
  let parts = good.flatMap((r) => r.value)
  if (genre && parts.length < 5 && offset > 0) parts = [...parts, ...await fetchSearchSpecials(pages, genre.id, 0)]
  if (!parts.length && notices.length) throw new Error(`查询不完整，尚不能判断是否有折扣：${notices.join('；')}`)
  const unique = new Map()
  for (const it of parts) if (it.appid > 0 && it.name && it.final != null && it.cut > 0) unique.set(it.appid, it)
  const now = Date.now()
  const live = [...unique.values()].filter((it) => !it.expiry || it.expiry * 1000 > now)
  if (!genre) live.sort((a, b) => b.cut - a.cut)
  const candidates = live.slice(0, maxCandidates)
  const reviews = await fetchReviews(candidates.map((it) => it.appid))
  const failedReviews = [...reviews.values()].filter((r) => r.failed).length
  if (candidates.length && failedReviews === candidates.length) {
    throw new Error(`Steam 评测查询全部失败：${[...reviews.values()][0].error}`)
  }
  if (failedReviews) notices.push(`${failedReviews} 款评测请求失败，已跳过`)
  const popular = candidates.filter((it) => !reviews.get(it.appid)?.failed && reviews.get(it.appid)?.total >= minReviews)
  if (!popular.length && failedReviews) throw new Error('评测查询不完整，尚不能判断是否有符合门槛的游戏')
  const ids = await lookupItadIds(popular.map((it) => it.appid))
  const uuids = [...new Set(Object.values(ids).filter((id) => typeof id === 'string' && id.length > 0))]
  const prices = await fetchItadPrices(uuids)
  const items = []
  let expiredItad = 0
  for (const it of popular) {
    const p = prices.get(ids[`app/${it.appid}`])
    if (p?.expiry && Date.parse(p.expiry) <= now) { expiredItad++; continue }
    // Live Steam price is authoritative; never replace it with another shop's cheaper price.
    const low = classifyLow(it.final, p?.storeLow)
    items.push({ ...it, cur: it.final, regular: it.original, lowLevel: low.level, lowLabel: low.label,
      storeLow: p?.storeLow ?? null, reviews: reviews.get(it.appid).total, expiry: p?.expiry || '' })
  }
  if (!genre) {
    const rank = { newLow: 0, tieLow: 1 }
    items.sort((a, b) => (rank[a.lowLevel] ?? 2) - (rank[b.lowLevel] ?? 2) || b.cut - a.cut || b.reviews - a.reviews)
  }
  const selected = items.slice(0, count)
  await enrichNames(selected, opts.translate !== false)
  if (cfg.showCover !== false) {
    await mapConcurrent(selected.slice(0, opts.coverLimit ?? selected.length), async (it) => {
      it.coverPath = await downloadCover(it.imageUrl, it.appid)
    })
  }
  let currency = resolveCurrency(opts.currency || cfg.currency) || 'CNY'
  let rate = 1
  let rateError = ''
  if (currency !== 'CNY') {
    const r = await getRate(currency)
    if (r > 0) rate = r
    else { rateError = `拿不到 ${currency} 的汇率，已按人民币显示`; currency = 'CNY' }
  }
  if (rotationCounter.size >= 300) rotationCounter.delete(rotationCounter.keys().next().value)
  rotationCounter.set(rotationKey, rotation + 1)
  const stats = { candidates: candidates.length, popular: popular.length, minReviews, failedReviews,
    expiredDropped: unique.size - live.length + expiredItad, scanned: items.length,
    historical: selected.filter((it) => it.lowLevel).length }
  log(`扫描完成：候选 ${stats.candidates}，达评测门槛 ${stats.popular}，返回 ${selected.length}，史低 ${stats.historical}`)
  return { items: selected, stats, notices, currency, rate, rateError, genre }
}

export function renderDealsCompact(items, stats = {}, opts = {}) {
  const currency = opts.currency || 'CNY'
  const money = (n) => convertCents(n, opts.rate || 1, currency)
  const source = '数据来源：Steam 商店 + https://isthereanydeal.com/'
  const notes = [opts.rateError, ...(opts.notices || [])].filter(Boolean)
  const footer = [currency !== 'CNY' ? `中国区价格按汇率换算成 ${currency}，不是该地区商店售价。` : '',
    ...notes.map((s) => `提示：${s}`), '史低按 ITAD 已收录的中国区 Steam 商店记录比较，非全平台最低。', source].filter(Boolean).join('\n')
  if (!items.length) {
    const plain = `本轮查询完成：检查 ${stats.candidates || 0} 款，评测门槛 ${stats.minReviews || 0} 条，没有符合本轮条件的结果。不代表 Steam 全站没有折扣。\n${footer}`
    return { plain, bubbles: [[{ type: 'text', data: { text: plain } }]] }
  }
  const header = `🎮 Steam 中国区折扣${opts.genreName ? ` · ${opts.genreName}` : ''} · ${items.length} 款（已核实史低 ${items.filter((it) => it.lowLevel).length} 款）`
  const bubbles = []
  const lines = []
  let current = [{ type: 'text', data: { text: header } }]
  const perBubble = boundedInt(opts.perBubble, 1, 10, 10)
  items.forEach((it, i) => {
    const title = it.zhTitle && it.enTitle && it.zhTitle !== it.enTitle ? `${it.zhTitle}（${it.enTitle}）` : (it.zhTitle || it.enTitle || it.name)
    const range = it.regular > it.cur ? `${money(it.regular)}→${money(it.cur)}` : money(it.cur)
    const line = `${i + 1}. ${title}  ${range}  ${it.lowLabel}  -${it.cut}%`
      + (opts.showLink ? `\n${STEAM}/app/${it.appid}/` : '')
    lines.push(line)
    current.push({ type: 'text', data: { text: line } })
    if (opts.withCovers && it.coverPath) current.push({ type: 'image', data: { file: it.coverPath } })
    if ((i + 1) % perBubble === 0 || i === items.length - 1) { bubbles.push(current); current = [] }
  })
  bubbles.at(-1).push({ type: 'text', data: { text: footer } })
  return { plain: [header, ...lines, footer].join('\n'), bubbles }
}

export const internals = { requestJson, fetchFeatured, fetchSearchSpecials, fetchReviews, lookupItadIds,
  fetchItadPrices, downloadCover, numOrNull }
export { resolveCurrency as resolveCurrencyCode }
export const GENRE_TAGS = {
  action:        { id: 19,   name: '动作',     aliases: ['动作', '动作游戏', 'act', 'action', 'act游戏'] },
  adventure:     { id: 21,   name: '冒险',     aliases: ['冒险', 'adventure', 'avg'] },
  rpg:           { id: 122,  name: '角色扮演', aliases: ['角色扮演', 'rpg', '扮演', 'jrpg', 'arpg', 'roleplay', 'role playing', '角色扮演游戏'] },
  strategy:      { id: 1742, name: '策略',     aliases: ['策略', '战略', 'strategy', 'slg', 'rts'] },
  simulation:    { id: 599,  name: '模拟',     aliases: ['模拟', 'simulation', 'sim', '经营', '模拟经营'] },
  racing:        { id: 699,  name: '竞速',     aliases: ['竞速', '赛车', '赛车游戏', 'racing', 'race', '驾驶', '开车'] },
  sports:        { id: 701,  name: '体育',     aliases: ['体育', '运动', 'sports'] },
  shooter:       { id: 1774, name: '射击',     aliases: ['射击', 'fps', 'shooter', '枪战', '打枪'] },
  indie:         { id: 492,  name: '独立',     aliases: ['独立', 'indie'] },
  casual:        { id: 597,  name: '休闲',     aliases: ['休闲', 'casual', '轻松'] },
  horror:        { id: 1667, name: '恐怖',     aliases: ['恐怖', '惊悚', 'horror', '吓人'] },
  puzzle:        { id: 1664, name: '解谜',     aliases: ['解谜', 'puzzle', '解密'] },
  openworld:     { id: 1695, name: '开放世界', aliases: ['开放世界', '沙盒', 'openworld', 'open world', '沙箱'] },
  coop:          { id: 1685, name: '合作',     aliases: ['合作', '联机', 'coop', 'co-op', '多人合作'] },
  anime:         { id: 4085, name: '动漫',     aliases: ['动漫', '二次元', 'anime', '日系'] },
  roguelike:     { id: 1716, name: 'Roguelike', aliases: ['roguelike', 'rogue', '肉鸽', '类rogue'] },
  sandbox:       { id: 3810, name: '沙盒建造', aliases: ['建造', '沙盒建造', 'craft', 'crafting', 'production'] },
  survival:      { id: 1662, name: '生存',     aliases: ['生存', 'survival', '求生'] },
  moba:          { id: 1718, name: 'MOBA',     aliases: ['moba', 'dota', 'lol'] },
  mmo:           { id: 128,  name: '大型多人在线', aliases: ['mmo', 'mmorpg', '网游'] },
  visualnovel:   { id: 3799, name: '视觉小说', aliases: ['视觉小说', 'galgame', 'gal', 'visual novel'] },
  platformer:    { id: 1625, name: '平台跳跃', aliases: ['平台', '平台跳跃', 'platformer', '跳跃'] },
  fighting:      { id: 1743, name: '格斗',     aliases: ['格斗', 'ftg', 'fighting', '拳皇'] },
  stealth:       { id: 1687, name: '潜行',     aliases: ['潜行', 'stealth', '暗杀'] },
  citybuilder:   { id: 4321, name: '城市营造', aliases: ['城建', '城市营造', 'city', '城市建造'] },
  farming:       { id: 8791, name: '农场模拟', aliases: ['农场', '种田', 'farming', 'agriculture'] },
  soulslike:     { id: 29482, name: '魂类',    aliases: ['魂类', 'souls', 'soulslike', '类魂'] },
  deckbuilder:   { id: 32322, name: '卡牌构筑', aliases: ['卡牌', '卡牌构筑', 'deck', 'deckbuilder', 'rouge卡牌'] },
  tps:           { id: 1827, name: '第三人称射击', aliases: ['tps', '第三人称射击'] },
  arcade:        { id: 1773, name: '街机',     aliases: ['街机', 'arcade'] },
  party:         { id: 5375, name: '派对',     aliases: ['派对', 'party', '聚会'] },
  psychological: { id: 21978, name: '心理恐怖', aliases: ['心理恐怖'] },
  bullethell:    { id: 3944, name: '弹幕射击', aliases: ['弹幕', '弹幕射击', 'bullet'] },
  boardgame:     { id: 4763, name: '桌游',     aliases: ['桌游', 'board game'] },
  pixel:         { id: 3964, name: '像素图形', aliases: ['像素', '像素风', 'pixel'] },
  cyberpunk:     { id: 4094, name: '赛博朋克', aliases: ['赛博朋克', 'cyberpunk'] },
  martialarts:   { id: 6915, name: '武侠',     aliases: ['武侠', '功夫', 'martial'] },
  space:         { id: 12472, name: '太空',     aliases: ['太空', 'space', '星际'] },
  detective:     { id: 2533, name: '推理',     aliases: ['推理', '探案', 'detective'] },
  music:         { id: 1752, name: '音乐/节奏', aliases: ['音乐', '音游', '节奏', 'rhythm', 'music'] },
  fishing:       { id: 23984, name: '钓鱼',    aliases: ['钓鱼', 'fishing'] }
}

/** 归一化分类输入，便于模糊匹配。 */
function normGenre(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-·、,，。.]/g, '').trim()
}

/**
 * 把用户说的分类解析成 { key, id, name }。认不出返回 null。
 * 支持：中文风格名（"赛车"）、分类 key（"racing"）、英文别名（"race"）。
 */
export function resolveGenre(input) {
  const raw = normGenre(input)
  if (!raw) return null
  // 精确别名
  for (const [key, meta] of Object.entries(GENRE_TAGS)) {
    if (normGenre(key) === raw) return { key, id: meta.id, name: meta.name }
    for (const a of meta.aliases) if (normGenre(a) === raw) return { key, id: meta.id, name: meta.name }
  }
  // 包含匹配（"来个赛车的" / "我想玩射击类"）
  for (const [key, meta] of Object.entries(GENRE_TAGS)) {
    if (raw.includes(normGenre(meta.name))) return { key, id: meta.id, name: meta.name }
    for (const a of meta.aliases) {
      const na = normGenre(a)
      if (na.length >= 2 && raw.includes(na)) return { key, id: meta.id, name: meta.name }
    }
  }
  return null
}

/** 列出可用的分类名（给"有哪些分类"这类提问用）。 */
export function listGenreNames() {
  return Object.values(GENRE_TAGS).map((m) => m.name)
}


export const CURRENCIES = {
  CNY: { symbol: '¥', name: '人民币', aliases: ['中国', '人民币', '元', 'rmb', 'cny', 'chinese'] },
  USD: { symbol: '$', name: '美元', aliases: ['美国', '美元', 'usd', 'dollar', 'usa', '美刀'] },
  UAH: { symbol: '₴', name: '乌克兰格里夫纳', aliases: ['乌克兰', 'uah', 'hryvnia', '格里夫纳'] },
  RUB: { symbol: '₽', name: '俄罗斯卢布', aliases: ['俄罗斯', '俄国', '卢布', 'rub', 'ruble', 'rouble'] },
  EUR: { symbol: '€', name: '欧元', aliases: ['欧元', '欧盟', 'eur', 'euro'] },
  JPY: { symbol: '¥', name: '日元', aliases: ['日本', '日元', 'jpy', 'yen'] },
  KRW: { symbol: '₩', name: '韩元', aliases: ['韩国', '韩元', 'krw', 'won'] },
  GBP: { symbol: '£', name: '英镑', aliases: ['英国', '英镑', 'gbp', 'pound'] },
  HKD: { symbol: 'HK$', name: '港币', aliases: ['香港', '港币', 'hkd'] },
  TWD: { symbol: 'NT$', name: '新台币', aliases: ['台湾', '新台币', 'twd'] },
  BRL: { symbol: 'R$', name: '巴西雷亚尔', aliases: ['巴西', 'brl', 'real'] },
  TRY: { symbol: '₺', name: '土耳其里拉', aliases: ['土耳其', 'try', 'lira'] },
  INR: { symbol: '₹', name: '印度卢比', aliases: ['印度', 'inr', 'rupee'] },
  ARS: { symbol: 'AR$', name: '阿根廷比索', aliases: ['阿根廷', 'ars', 'peso'] }
}

/** 把用户说的"乌克兰/美国/卢布/USD"这类说法解析成货币代码。 */
export function resolveCurrency(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (CURRENCIES[upper]) return upper
  const low = raw.toLowerCase()
  for (const [code, meta] of Object.entries(CURRENCIES)) {
    if (meta.aliases.some((a) => a.toLowerCase() === low)) return code
  }
  // 再宽松一点：包含关系（"换成乌克兰的"也能命中）
  for (const [code, meta] of Object.entries(CURRENCIES)) {
    if (meta.aliases.some((a) => a.length >= 2 && low.includes(a.toLowerCase()))) return code
  }
  // 3 个字母的代码即使不在表里也接受（汇率源可能支持）
  if (/^[A-Z]{3}$/.test(upper)) return upper
  return null
}

let rateCache = null   // { at, code, rates }

/** CNY → 目标货币的汇率（1 CNY = ? target）。失败返回 null。 */
export async function getRate(code) {
  const target = String(code || 'CNY').toUpperCase()
  if (target === 'CNY') return 1
  if (rateCache && rateCache.code === 'CNY' && Date.now() - rateCache.at < 6 * 3600 * 1000) {
    const hit = rateCache.rates?.[target]
    if (Number.isFinite(hit)) return hit
  }
  const sources = [
    ['jsdelivr currency-api', 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json', (d) => d?.cny],
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/CNY', (d) => d?.rates]
  ]
  for (const [name, url, pick] of sources) {
    try {
      const d = await getJson(url, 20000)
      const rates = pick(d) || {}
      const rate = rates[target] ?? rates[target.toLowerCase()]
      const n = Number(rate)
      if (Number.isFinite(n) && n > 0) {
        rateCache = { at: Date.now(), code: 'CNY', rates: normalizeRates(rates) }
        return n
      }
      log(`${name} 没有 ${target} 的汇率`)
    } catch (e) {
      log(`${name} 汇率获取失败：${String(e?.message || e).slice(0, 80)}`)
    }
  }
  return null
}

function normalizeRates(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'object' && v) {
      const r = Number(v.rate)          // floatrates 风格
      if (Number.isFinite(r)) out[String(k).toUpperCase()] = r
    } else {
      const r = Number(v)
      if (Number.isFinite(r)) out[String(k).toUpperCase()] = r
    }
  }
  return out
}

/** 按汇率把"分"换算成目标货币的面值字符串。 */
export function convertCents(cents, rate, code) {
  if (cents == null) return '—'
  const meta = CURRENCIES[code] || { symbol: '', name: code }
  const y = (Number(cents) / 100) * (Number(rate) || 1)
  // 大额货币（日元/韩元/里拉）没有小数，小额货币保留两位
  const digits = ['JPY', 'KRW'].includes(code) ? 0 : 2
  return `${meta.symbol}${y.toFixed(digits)}`
}

function numOrNull(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}
