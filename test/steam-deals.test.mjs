import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initSteam, scanDeals, classifyLow, convertCents, renderDealsCompact, internals } from '../examples/skills/steam-deals/steam-data-v150.js'
import { createSkill } from '../examples/skills/steam-deals/steam-runtime-v150.js'

const item = (id = 1) => ({ id, name: `测试游戏${id}`, currency: 'CNY', discount_percent: 75,
  final_price: 6975, original_price: 27900, discount_expiration: 0 })
const base = { itadKey: 'private-test-key', minReviews: 5000, maxCandidates: 70, searchPages: 1,
  maxItems: 10, currency: 'CNY', showCover: false, mentionOnly: false }
const response = (d, status = 200) => new Response(JSON.stringify(d), { status })
function mock(overrides = {}) {
  const calls = []
  const fetch = async (input, options) => {
    const u = new URL(input)
    calls.push({ url: u, options })
    const key = u.pathname.includes('featuredcategories') ? 'featured'
      : u.pathname.includes('search/results') ? 'search'
      : u.pathname.includes('appreviews') ? 'reviews'
      : u.pathname.includes('lookup/id') ? 'ids'
      : u.pathname.includes('games/prices') ? 'prices'
      : u.pathname.includes('appdetails') ? 'names' : 'rate'
    if (overrides[key]) return overrides[key](u, options)
    if (key === 'featured') return response({ specials: { items: [item()] }, top_sellers: { items: [] } })
    if (key === 'search') return response({ total_count: 0, results_html: '' })
    if (key === 'reviews') return response({ query_summary: { total_reviews: 20000 } })
    if (key === 'ids') return response({ 'app/1': 'uuid-1' })
    if (key === 'prices') return response([{ id: 'uuid-1', historyLow: { all: { amountInt: 4525, currency: 'CNY' } },
      deals: [{ shop: { id: 61 }, price: { amountInt: 6975, currency: 'CNY' }, storeLow: { amountInt: 6975, currency: 'CNY' } }] }])
    if (key === 'names') return response({ 1: { data: { name: '测试游戏', header_image: '' } } })
    return response({ rates: { USD: 0.14 } })
  }
  return { fetch, calls }
}
function initialize(overrides = {}, settings = {}) {
  const m = mock(overrides)
  initSteam({ config: () => ({ ...base, ...settings }), fetch: m.fetch })
  return m
}
const scan = (opts = {}) => scanDeals({ ...opts, translate: false })
const networkFail = () => { throw new Error('secret-key=https://private.invalid/?key=private-test-key') }

test('Docker-native requests find current deals and compare Steam storeLow, not all-shop low', async () => {
  const m = initialize()
  const r = await scan()
  assert.equal(r.items[0].lowLevel, 'tieLow')
  assert.equal(r.items[0].cur, 6975)
  const req = m.calls.find((c) => c.url.pathname.includes('games/prices'))
  assert.equal(req.url.searchParams.get('shops'), '61')
  assert.equal(req.url.searchParams.get('country'), 'CN')
  assert.equal(req.url.searchParams.has('key'), false)
  assert.equal(req.options.headers['ITAD-API-Key'], base.itadKey)
  assert.ok(m.calls.every((c) => c.options.signal && c.options.redirect === 'error'))
})
test('all Steam source failures are errors, not successful empty deals', async () => {
  initialize({ search: networkFail, featured: networkFail })
  await assert.rejects(scan(), /数据源全部失败/)
})
test('one working source is usable but incomplete scan is disclosed', async () => {
  initialize({ search: networkFail })
  const r = await scan()
  assert.equal(r.items.length, 1)
  assert.equal(r.notices.length, 1)
})
test('empty working source plus failed source does not claim no deals', async () => {
  initialize({ featured: networkFail })
  await assert.rejects(scan(), /查询不完整/)
})
test('valid empty lists give genuine zero results without guessing cause', async () => {
  initialize({ featured: () => response({ specials: { items: [] }, top_sellers: { items: [] } }) })
  const r = await scan()
  assert.equal(r.items.length, 0)
  const t = renderDealsCompact([], r.stats, r).plain
  assert.match(t, /不代表 Steam 全站没有折扣/)
  assert.doesNotMatch(t, /要么|热门游戏没在打折/)
})
test('malformed source JSON shape is not cached as success', async () => {
  let tries = 0
  initialize({ featured: () => { tries++; return response({}) }, search: networkFail })
  await assert.rejects(scan())
  await assert.rejects(scan())
  assert.equal(tries, 2)
})
test('all review request failures are not zero review counts', async () => {
  initialize({ reviews: networkFail })
  await assert.rejects(scan(), /评测查询全部失败/)
})
test('review threshold is respected rather than silently relaxed', async () => {
  initialize({ reviews: () => response({ query_summary: { total_reviews: 10 } }) })
  const r = await scan()
  assert.equal(r.items.length, 0)
  assert.equal(r.stats.popular, 0)
})
test('zero threshold allows verified zero reviews', async () => {
  initialize({ reviews: () => response({ query_summary: { total_reviews: 0 } }) }, { minReviews: 0 })
  assert.equal((await scan()).items.length, 1)
})
test('malformed review response is an error', async () => {
  initialize({ reviews: () => response({ query_summary: {} }) })
  await assert.rejects(scan(), /评测查询全部失败/)
})
test('ITAD HTTP failures surface without exposing key or response body', async () => {
  initialize({ ids: () => response({ reason_phrase: base.itadKey }, 403) })
  await assert.rejects(scan(), (e) => /HTTP 403/.test(e.message) && !e.message.includes(base.itadKey))
})
test('malformed ITAD prices are an error', async () => {
  initialize({ prices: () => response({}) })
  await assert.rejects(scan(), /价格响应格式变化/)
})
test('other-shop deals never become Steam price or Steam history', async () => {
  initialize({ prices: () => response([{ id: 'uuid-1', deals: [{ shop: { id: 99 }, price: { amountInt: 10, currency: 'CNY' }, storeLow: { amountInt: 10, currency: 'CNY' } }] }]) })
  const it = (await scan()).items[0]
  assert.equal(it.cur, 6975)
  assert.equal(it.lowLevel, null)
  assert.equal(it.lowLabel, '史低待核实')
})
test('foreign-currency historical lows are not compared with CNY', async () => {
  initialize({ prices: () => response([{ id: 'uuid-1', deals: [{ shop: { id: 61 }, price: { amountInt: 6975, currency: 'CNY' }, storeLow: { amountInt: 6975, currency: 'USD' } }] }]) })
  assert.equal((await scan()).items[0].lowLevel, null)
})
test('expired ITAD deals are excluded', async () => {
  initialize({ prices: () => response([{ id: 'uuid-1', deals: [{ shop: { id: 61 }, price: { currency: 'CNY' }, expiry: '2020-01-01T00:00:00Z' }] }]) })
  const r = await scan()
  assert.equal(r.items.length, 0)
  assert.equal(r.stats.expiredDropped, 1)
})
test('missing low values stay null, not zero', () => {
  for (const v of [null, undefined, '', false]) assert.equal(internals.numOrNull(v), null)
  assert.equal(internals.numOrNull(0), 0)
  assert.equal(classifyLow(100, null).level, null)
})
test('new, tied, ordinary and free pricing use exact cents', () => {
  assert.equal(classifyLow(100, 140).level, 'newLow')
  assert.equal(classifyLow(140, 140).level, 'tieLow')
  assert.equal(classifyLow(141, 140).level, null)
  assert.equal(classifyLow(0, 0).level, 'tieLow')
  assert.equal(convertCents(27999, 1, 'CNY'), '¥279.99')
})
test('temporary currency option is actually applied without updating configuration', async () => {
  initialize()
  const r = await scan({ currency: 'USD' })
  assert.equal(r.currency, 'USD')
  assert.equal(r.rate, 0.14)
  assert.match(renderDealsCompact(r.items, r.stats, r).plain, /不是该地区商店售价/)
})
test('exchange failure resets actual display currency to CNY', async () => {
  initialize({ rate: networkFail })
  const r = await scan({ currency: 'USD' })
  assert.equal(r.currency, 'CNY')
  assert.match(r.rateError, /按人民币显示/)
  assert.match(renderDealsCompact(r.items, r.stats, r).plain, /¥69.75/)
})
test('search HTML parses exact CNY cents and preserves genre tag query', async () => {
  const html = '<a data-ds-appid="1"><span class="title">Test &amp; Go</span><div>-75%</div><div class="discount_original_price">¥ 279.00</div><div class="discount_final_price">¥ 69.75</div></a>'
  const m = initialize({ search: () => response({ total_count: 1, results_html: html }) })
  const r = await scan({ genre: '赛车' })
  assert.equal(r.items[0].cur, 6975)
  assert.equal(m.calls[0].url.searchParams.get('tags'), '699')
})
test('search markup change is a parsing error, not zero deals', async () => {
  initialize({ search: () => response({ total_count: 1, results_html: '<a data-ds-appid="1">unrecognized</a>' }) })
  await assert.rejects(scan({ genre: '赛车' }), /价格格式变化/)
})
test('attribution exists without any illustration; ordinary deals explicitly labeled', () => {
  const r = renderDealsCompact([{ name: 'Test', appid: 1, cur: 100, regular: 200, cut: 50, lowLabel: '普通折扣' }], {}, { showLink: true })
  assert.match(r.plain, /普通折扣/)
  assert.match(r.plain, /isthereanydeal.com/)
  assert.match(r.plain, /store.steampowered.com\/app\/1/)
  assert.match(r.bubbles.at(-1).at(-1).data.text, /isthereanydeal/)
})
test('image cache is profile media and rejects untrusted image host', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-deals-test-'))
  let downloads = 0
  const jpg = Buffer.alloc(600); jpg[0] = 255; jpg[1] = 216
  initSteam({ dataDir: dir, downloadBinary: async () => { downloads++; return { buffer: jpg } } })
  try {
    assert.equal(await internals.downloadCover('https://evil.invalid/foo.jpg', 1), null)
    const file = await internals.downloadCover('https://shared.fastly.steamstatic.com/cover.jpg', 1)
    assert.equal(file, path.join(dir, 'media/steam-deals/cover-1.jpg'))
    assert.equal(downloads, 1)
    assert.deepEqual(await fs.readFile(file), jpg)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

const result = (items = [{ appid: 1, name: '测试', cur: 100, regular: 200, cut: 50, lowLevel: 'tieLow', lowLabel: '平史低', coverPath: '/data/profile/media/steam-deals/cover-1.jpg' }]) => ({ items, stats: { candidates: 1, minReviews: 5000 }, currency: 'CNY', rate: 1, notices: [] })
function runtime({ scanDeals: scanner = async () => result(), cfg = {}, sender = {} } = {}) {
  const tools = new Map(); const messages = []
  const skill = createSkill({ scanDeals: scanner })
  skill.setup({ config: () => ({ ...base, ...cfg }), log: () => {}, registerTool: (t) => tools.set(t.id, t) })
  const ctx = { kind: 'private', chatKey: 'private:test', onebot: { kind: 'qqbot' }, session: { sent: [] },
    sender: { sendTextBatch: async (_key, texts) => { messages.push(...texts); return { sent: texts.map((text) => ({ text })), failed: [] } },
      sendMedia: async () => { throw new Error('官方 QQ 禁止混合消息') },
      sendImage: async () => { messages.push('image') }, ...sender } }
  return { tool: tools.get('deals'), ctx, messages }
}
test('official QQ uses text and separate image, records sent messages', async () => {
  let opts
  const r = runtime({ cfg: { showCover: true }, scanDeals: async (o) => { opts = o; return result() } })
  const output = await r.tool.execute(r.ctx, {})
  assert.equal(opts.coverLimit, 1)
  assert.equal(output.isError, undefined)
  assert.match(output.content, /status: ok/)
  assert.equal(r.messages.length, 2)
  assert.equal(r.ctx.session.sent.length, 2)
})
test('official QQ cover failure does not lose successfully sent text', async () => {
  const r = runtime({ cfg: { showCover: true }, sender: { sendImage: async () => { throw new Error('media error') } } })
  const out = await r.tool.execute(r.ctx)
  assert.match(out.content, /status: ok/)
  assert.match(out.content, /共 1 条/)
})
test('partial text delivery truthfully reports an error and preserves sent record', async () => {
  const r = runtime({ sender: { sendTextBatch: async () => ({ sent: [{ text: 'part one' }], failed: [{ text: 'part two' }] }) } })
  const out = await r.tool.execute(r.ctx)
  assert.equal(out.isError, true)
  assert.match(out.content, /已经发出 1 条/)
  assert.equal(r.ctx.session.sent[0].text, 'part one')
})
test('scan failure sends no speculative no-deal message', async () => {
  const r = runtime({ scanDeals: async () => { throw new Error('Steam 数据源全部失败') } })
  const out = await r.tool.execute(r.ctx)
  assert.equal(out.isError, true)
  assert.equal(r.messages.length, 0)
  assert.match(out.content, /不代表没有折扣/)
})
test('genuine zero uses no-results status, not ok zero historic lows', async () => {
  const r = runtime({ scanDeals: async () => result([]) })
  const out = await r.tool.execute(r.ctx)
  assert.match(out.content, /status: no-results/)
  assert.equal(r.messages.length, 1)
})
test('successful deduplication is not counted as a new send', async () => {
  const r = runtime({ sender: { sendTextBatch: async () => ({ sent: [{ text: 'already sent', deduped: true }], failed: [] }) } })
  const out = await r.tool.execute(r.ctx)
  assert.match(out.content, /共 0 条新消息/)
  assert.equal(r.ctx.session.sent.length, 1)
})
test('missing key avoids both fetch and send', async () => {
  let scanned = false
  const r = runtime({ cfg: { itadKey: '' }, scanDeals: async () => { scanned = true; return result() } })
  assert.equal((await r.tool.execute(r.ctx)).isError, true)
  assert.equal(scanned, false)
})
test('manifest retains all settings and masks API key', async () => {
  const m = JSON.parse(await fs.readFile(new URL('../examples/skills/steam-deals/skill.json', import.meta.url)))
  assert.equal(m.configSchema.itadKey.secret, true)
  assert.deepEqual(m.permissions, ['web_fetch'])
  for (const key of Object.keys(m.settings)) assert.ok(m.configSchema[key])
})
