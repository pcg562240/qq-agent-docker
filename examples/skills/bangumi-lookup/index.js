// 番剧资料查询（bangumi-lookup）。
//
// ── 为什么是技能（skills/）而不是插件（plugins/） ──────────────────────────
// 「群友这句话是不是在问番剧」「要不要顺手报一下评分」只能靠模型理解人话，
// 凑不出一条能写死的触发条件。插件（确定性型）的定义是"条件满足**必然**执行"，
// 而这里的触发条件本身就是模糊的 —— 所以做成技能：注册工具进 function 列表，
// 用不用、什么时候用，由模型自己判断。
//
// ── 数据来源：Bangumi（bgm.tv）公开 API，不需要任何 Key ────────────────────
//   POST /v0/search/subjects          搜作品条目（动画/书籍/音乐/游戏/三次元）
//   POST /v0/search/characters        搜角色
//   POST /v0/search/persons           搜声优 / 制作人
//   GET  /v0/subjects/{id}            条目详情（简介、评分、排名、集数、标签）
//   GET  /v0/subjects/{id}/persons    制作阵容
//   GET  /v0/subjects/{id}/characters 登场角色 + 声优
//   GET  /v0/episodes?subject_id=     剧集与播出日期
//   GET  /calendar                    每日放送表（旧版接口，仍是官方唯一入口）
//
// ⚠️ 下面三条是**会静默失效**的地方，少一条就表现为"查不到"（不报错、没反应）：
//
//   1. **必须带规范 User-Agent**。格式 `{开发者}/{应用名}/{版本} (项目地址)`，
//      Bangumi 会直接拦掉默认库 UA（undici / node-fetch 那种）—— 而且不带 UA
//      的请求在部分网络下连 TLS 都握不上。这是本技能最容易踩的坑，所以写死在
//      DEFAULT_UA 里，只在设置里留了覆盖口子。
//
//   2. **必须限频**。官方建议 0.5s 一次。这里所有请求走**同一条串行队列**：
//      并发打过去会被限流（429），而 429 在界面上看起来就是"这个技能不好使"。
//
//   3. **NSFW 默认过滤**。v0 的 nsfw 字段要 OAuth 才能读，筛掉最省事，
//      也顺手不让成人向条目流进群里。
//
// ── 省 token 的两件事（这个项目对成本敏感）────────────────────────────────
//   · 只回给模型群里问得到的字段，不整段回淌 API 原始 JSON
//   · 内存缓存（搜索 10 分钟／详情 30 分钟／制作阵容 1 小时／放送表 6 小时），
//     同一个番被连着问三次不会打三次 Bangumi
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（本技能无状态，
//    不写任何文件，所以没有"更新后丢数据"的问题）。

/* ── 数据源：官方源 + 社区镜像，连不上时自动换源 ───────────────────────────
 *
 * ⚠️ 这是本技能第二个"会静默失效"的地方（用户实机复现）：
 *    `api.bgm.tv` 挂在 Cloudflare 上、回源海外，**大陆网络直连基本是超时**；
 *    图片 CDN `lain.bgm.tv` 同理。表现不是报错，而是「这个技能查不到东西」。
 *
 * 对策：默认走 `bangumi.vip` —— 社区做的 bgm.tv 全域名反代。2026-10 实测：
 *    GET /v0/subjects/{id}、/persons、/characters、/episodes、/calendar → 200
 *    POST /v0/search/subjects → 200（没被人机验证挡），旧版 /search/subject 也通
 *    响应里的封面地址已被它改写成 lain.bangumi.vip —— 图片一并解决
 *
 * 但镜像域名会换（bangumi.pro → bangumi.vip，论坛帖里写着"存活25days"），
 * 所以**不写死一个域名**，而是候选列表 + 自动转移：
 *   · 连通后"粘住"，后续请求不再探测（省一次往返）
 *   · 只在**网络层**失败时换源（超时 / DNS / TLS / 连接重置 / 5xx / CF 挑战页）
 *   · 429、403、404 这类**业务错误换源没用**，直接如实报给模型
 *   · 判死的源进冷却期，避免每个请求都先去撞一遍坏域名
 */
const BASE_CANDIDATES = [
  'https://api.bangumi.vip',   // 社区镜像：大陆可直连（首选）
  'https://api.bgm.tv'         // 官方源：海外 / 有代理时更权威
];
const BASE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Bangumi 强制要求规范 UA，默认库 UA 会被拦。
 * 格式：{开发者}/{应用名}/{版本} (项目地址)
 * 官方明确拒绝的写法：通用的 `database`、只有版本号的 `Bangumi/1.0`。
 */
const DEFAULT_UA = 'Kondius/qq-agent-bangumi-skill/1.0 (https://github.com/Kondius/qq-agent)';

/** 条目类型（filter.type 的取值固定，别改） */
const SUBJECT_TYPES = { 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' };

/** 让模型能用自然说法指定类型 —— 别逼它记住数字编码 */
const TYPE_ALIAS = {
  anime: 2, '动画': 2, '番剧': 2, '动漫': 2, '新番': 2,
  book: 1, '书籍': 1, '漫画': 1, '小说': 1, '轻小说': 1,
  music: 3, '音乐': 3,
  game: 4, '游戏': 4,
  real: 6, '三次元': 6, '真人': 6, '日剧': 6
};

/** 剧集类型：0=本篇 1=SP 2=OP 3=ED */
const EP_TYPES = { '0': '本篇', '1': 'SP', '2': 'OP', '3': 'ED', '本篇': 0, '正片': 0, 'sp': 1, 'op': 2, 'ed': 3 };

/** 制作阵容里优先展示的岗位（按这个顺序挑人，剩下的才按原顺序补） */
const KEY_RELATIONS = ['原作', '导演', '监督', '系列构成', '脚本', '人物设定', '总作画监督', '作画监督', '音乐', '美术监督', '色彩设计', '摄影监督', '剪辑', '音响监督', '动画制作', '制作'];

/** 角色类型：1=主角 2=配角 3=客串 4=闲角 */
const CHAR_TYPE = { 1: '主角', 2: '配角', 3: '客串', 4: '闲角' };

const TTL = {
  search: 10 * 60 * 1000,
  detail: 30 * 60 * 1000,
  staff: 60 * 60 * 1000,
  episodes: 30 * 60 * 1000,
  calendar: 6 * 60 * 60 * 1000
};

let skillApi = null;
let cfg = () => ({});
let doFetch = null;

let activeBase = null;            // 当前选中的源；通了就粘住
const baseDeadUntil = new Map();  // base -> 冷却截止时间戳

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));

/* ── 请求层：串行队列 + 缓存 + 超时 ────────────────────────────────────────
 *
 * 为什么是"串行队列"而不是每个请求自己 sleep：
 * 模型一轮里可能连着调 search + detail + episodes 三个工具，各自 sleep 只保证
 * 单个请求"不快"，三个并发打过去照样触发限流。串到一条链上，才真的守住 0.5s。
 * 队列里一个请求失败**不能毒化后面的**（所以 queue = run.then(空成功, 空失败)）。
 */
let lastRequestAt = 0;
let queue = Promise.resolve();

function enqueue(fn) {
  const run = queue.then(async () => {
    const gap = Math.max(0, intervalMs() - (Date.now() - lastRequestAt));
    if (gap) await sleep(gap);
    lastRequestAt = Date.now();
    return fn();
  });
  queue = run.then(() => {}, () => {});
  return run;
}

const cache = new Map();   // key -> { data, exp }

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) { cache.delete(key); return null; }
  // LRU：命中后挪到队尾，淘汰时先丢最久没用的
  cache.delete(key); cache.set(key, e);
  return e.data;
}

function cacheSet(key, data, ttl) {
  if (cache.size > 200) {
    for (const k of cache.keys()) { cache.delete(k); if (cache.size <= 120) break; }
  }
  cache.set(key, { data, exp: Date.now() + ttl });
}

function intervalMs() {
  // ⚠️ 这里不能写成 `Number(x) || 600`：设成 0（明确表示"不限频"）会被 0 是假值
  //    这条规则吃掉、悄悄变回 600 —— 用户改了半天配置、行为一点没变。
  const raw = Number((cfg() || {}).requestIntervalMs);
  if (!Number.isFinite(raw)) return 600;
  return clamp(raw, 0, 10000);
}

const hostOf = (base) => { try { return new URL(base).host; } catch { return String(base); } };

/** 用户显式指定了接口域名就**只用它** —— 明确配置优先于自动，不自作主张 */
function forcedBase() {
  const raw = String((cfg() || {}).apiBase || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

const isDead = (base) => Number(baseDeadUntil.get(base) || 0) > Date.now();
const markDead = (base) => { baseDeadUntil.set(base, Date.now() + BASE_COOLDOWN_MS); };

/** 依次要试的源：当前在用的排第一，其余按候选顺序兜底 */
function orderedBases() {
  const f = forcedBase();
  if (f) return [{ base: f, forced: true }];
  const out = [];
  if (activeBase) out.push({ base: activeBase, forced: false });
  for (const b of BASE_CANDIDATES) if (b !== activeBase) out.push({ base: b, forced: false });
  return out;
}

/**
 * 这个错是"源不可用"还是"这次查询本身不成立"？只有前者值得换源。
 * 判错方向的代价是不对称的：
 *   把业务错误当源故障 → 白试一遍下一个源（慢一点，结论仍对）；
 *   把源故障当业务错误 → 直接告诉群里"查不到"，功能静默失效。
 * 所以这里倾向于"宁可多试一次"。
 */
function isBaseFailure(e) {
  if (!e) return false;
  if (e.timeout) return true;               // 超时
  if (e.badPayload) return true;            // 返回不是 JSON（多半是挑战页/错误页）
  if (e.status === undefined) return true;  // fetch 直接抛：DNS / TLS / 连接被重置
  if (e.status >= 500) return true;         // 5xx、Cloudflare 52x
  // 带 HTML 的 403/429：人机验证页，不是 Bangumi 在回答我们 —— 换个源可能就通了
  if ((e.status === 403 || e.status === 429)
    && /<html|cloudflare|challenge|just a moment/i.test(String(e.body || ''))) return true;
  return false;
}

/** 往一个指定的源打一条请求（不含换源逻辑） */
async function requestOnce(base, pathname, { method = 'GET', body = null } = {}) {
  if (typeof doFetch !== 'function') {
    throw new Error('本技能没有拿到 fetch（清单里缺少 web_fetch 权限）');
  }
  const c = cfg() || {};
  const ua = String(c.userAgent || '').trim() || DEFAULT_UA;
  const ms = clamp(Number(c.timeoutMs) || 12000, 3000, 60000);
  const ctrl = new AbortController();
  // ⚠️ 这里**不** unref：请求卡住时定时器要能把事件循环撑住，
  //    否则 Node 可能直接退出，超时反而永远不触发。
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await doFetch(`${base}${pathname}`, {
      method,
      headers: {
        'User-Agent': ua,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`HTTP ${res.status}${text ? `：${String(text).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
      e.status = res.status;
      e.body = text;
      throw e;
    }
    try {
      return await res.json();
    } catch {
      const e = new Error('返回的不是 JSON（像是被中间层的拦截/挑战页顶掉了）');
      e.badPayload = true;
      throw e;
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error(`请求超时（${ms}ms）`);
      e.timeout = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 挑一个能用的源把这条请求发出去；业务错误原样抛（换源没用） */
async function withBase(pathname, opts) {
  const all = orderedBases();
  const live = all.filter((x) => x.forced || !isDead(x.base));
  const tries = live.length ? live : all.slice(0, 1);   // 全在冷却期也得试一个，否则永远起不来
  let lastErr = null;
  const tried = [];
  for (const { base } of tries) {
    tried.push(hostOf(base));
    try {
      // 限频放在**每次真实网络调用**上，而不是每次逻辑查询上
      const data = await enqueue(() => requestOnce(base, pathname, opts));
      activeBase = base;
      baseDeadUntil.delete(base);
      return { data, base };
    } catch (e) {
      lastErr = e;
      if (/web_fetch|没有拿到 fetch/.test(String(e?.message || ''))) throw e;   // 缺权限，换源无意义
      if (!isBaseFailure(e)) throw e;                                          // 业务错误：别浪费时间换源
      markDead(base);
      if (activeBase === base) activeBase = null;
    }
  }
  const e = new Error(`依次试过 ${tried.join(' → ')}，都失败了；最后一个是「${String(lastErr?.message ?? lastErr).slice(0, 120)}」`);
  e.basesDown = true;
  throw e;
}

/**
 * 打一个 Bangumi 接口。返回 { data, cached }。
 * 抛错时带上 .status / .timeout，方便上面区分"被限流"和"网络不通"。
 */
async function fetchJson(pathname, { method = 'GET', body = null, ttl = 0, cacheKey = null } = {}) {
  const key = cacheKey || `${method} ${pathname}`;
  if (ttl) {
    const hit = cacheGet(key);
    if (hit) return { data: hit, cached: true };
  }
  const { data } = await withBase(pathname, { method, body });
  if (ttl) cacheSet(key, data, ttl);
  return { data, cached: false };
}

/* ── 查询层 ─────────────────────────────────────────────────────────────── */

function resolveType(raw, fallback = 2) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  return TYPE_ALIAS[s.toLowerCase()] ?? TYPE_ALIAS[s] ?? fallback;
}

/**
 * 搜作品条目。
 * v0 的 POST /v0/search/subjects 是主路；它若挂了/被拦，落回旧版
 * GET /search/subject/{kw} —— 旧版接口仍在服务，多一条命总比直接告诉群里
 * "查不到"好。两条路的返回结构不同，所以在这里**归一化**，上面只管用。
 */
let lastSearchError = null;

async function searchSubjects(keyword, typeNum, limit, allowNsfw) {
  lastSearchError = null;
  try {
    const { data } = await fetchJson('/v0/search/subjects', {
      method: 'POST',
      body: { keyword, sort: 'match', filter: { type: [typeNum], nsfw: allowNsfw } },
      ttl: TTL.search,
      cacheKey: `s:${typeNum}:${allowNsfw ? 1 : 0}:${keyword}`
    });
    const list = Array.isArray(data?.data) ? data.data : [];
    if (list.length) return { list, total: Number(data?.total) || list.length, via: 'v0' };
    // v0 返回空：不急着落旧版，先看旧版有没有 —— 两边索引覆盖略有差异
  } catch (err) {
    lastSearchError = err;
  }
  try {
    const { data } = await fetchJson(
      `/search/subject/${encodeURIComponent(keyword)}?type=${typeNum}&responseGroup=large&max_results=${limit}`,
      { ttl: TTL.search, cacheKey: `s0:${typeNum}:${keyword}` }
    );
    const raw = Array.isArray(data?.list) ? data.list : [];
    const list = allowNsfw ? raw : raw.filter((x) => x?.nsfw !== true);
    return { list, total: Number(data?.results) || list.length, via: 'legacy' };
  } catch (err) {
    // 旧版也挂了：把 v0 的错（更可能是真原因）抛出去，别用旧版的错盖掉
    throw lastSearchError || err;
  }
}

async function searchByKind(kind, keyword, limit, allowNsfw) {
  const path = kind === 'character' ? '/v0/search/characters'
    : (kind === 'person' ? '/v0/search/persons' : null);
  if (!path) throw new Error(`不认识的 kind：${kind}`);
  const { data } = await fetchJson(path, {
    method: 'POST',
    body: { keyword, filter: { nsfw: allowNsfw } },
    ttl: TTL.search,
    cacheKey: `k:${kind}:${allowNsfw ? 1 : 0}:${keyword}`
  });
  return Array.isArray(data?.data) ? data.data : [];
}

const getSubject = (id) => fetchJson(`/v0/subjects/${id}`, { ttl: TTL.detail, cacheKey: `d:${id}` }).then((r) => r.data);
const getStaff = (id) => fetchJson(`/v0/subjects/${id}/persons`, { ttl: TTL.staff, cacheKey: `p:${id}` }).then((r) => r.data);
const getCast = (id) => fetchJson(`/v0/subjects/${id}/characters`, { ttl: TTL.staff, cacheKey: `c:${id}` }).then((r) => r.data);
const getCalendar = () => fetchJson('/calendar', { ttl: TTL.calendar, cacheKey: 'cal' }).then((r) => r.data);

async function getEpisodes(subjectId, typeNum, limit, offset) {
  const q = new URLSearchParams({ subject_id: String(subjectId), limit: String(limit), offset: String(offset) });
  if (typeNum !== null) q.set('type', String(typeNum));
  const { data } = await fetchJson(`/v0/episodes?${q.toString()}`, {
    ttl: TTL.episodes,
    cacheKey: `e:${subjectId}:${typeNum}:${limit}:${offset}`
  });
  return { list: Array.isArray(data?.data) ? data.data : [], total: Number(data?.total) || 0 };
}

/* ── 归一化与排版 ───────────────────────────────────────────────────────── */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 接口源 → 图片 CDN 的换算：镜像就是按 `api.X` → `lain.X` 反代的 */
function cdnHostFor(base) {
  try {
    const h = new URL(base).host.replace(/^api\./, '');
    return h ? `lain.${h}` : '';
  } catch { return ''; }
}

/**
 * 把封面地址换成"当前这个源取得到图"的地址。
 * 官方源给 lain.bgm.tv、镜像给 lain.bangumi.vip —— 前者在大陆拿不到，
 * 模型照样会把链接发出去，群里就是一张裂图。
 * 顺带把 http 提成 https（旧版搜索接口返回的是 http）。
 * 只动 `lain.*` 这种图片 CDN，别碰返回里其它链接。
 */
function fixImageUrl(raw) {
  const s = clean(raw);
  if (!s || !/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    if (!/^lain\./i.test(u.host)) return s;
    const want = cdnHostFor(activeBase);
    if (want) u.host = want;
    u.protocol = 'https:';
    return u.toString();
  } catch { return s; }
}

/**
 * 把接口返回抹平成数组。
 *
 * ⚠️ 这个函数是自测逼出来的：`/v0/subjects/{id}/persons` 与 `/characters`
 * 文档上写的是裸数组，实际返回的是 `{ data: [...] }` —— 直接当数组遍历会
 * 得到 0 条，**不报错**，只是制作阵容和声优表整段消失（自测里这两项全红）。
 * 两种形状都认，比赌哪一个对便宜得多。
 */
function asList(resp) {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.data)) return resp.data;
  return [];
}

/** v0 和旧版搜索的字段名不一样（date/air_date、rating 的形状也不同），在这里抹平 */
function normSubject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rating = raw.rating || {};
  return {
    id: raw.id,
    type: Number(raw.type) || 0,
    name: clean(raw.name),
    nameCn: clean(raw.name_cn),
    date: clean(raw.date || raw.air_date),
    platform: clean(raw.platform),
    eps: Number(raw.eps || raw.total_episodes) || 0,
    score: Number(rating.score) || 0,
    rank: Number(rating.rank ?? raw.rank) || 0,
    voters: Number(rating.total ?? rating.count) || 0,
    cover: fixImageUrl(raw.images?.large || raw.images?.common || raw.images?.medium || raw.images?.grid),
    summary: clean(raw.summary),
    nsfw: raw.nsfw === true
  };
}

function titleOf(s) {
  if (s.nameCn && s.name && s.nameCn !== s.name) return `${s.nameCn}（${s.name}）`;
  return s.nameCn || s.name || '未命名';
}

function num(n, digits = 1) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v.toFixed(digits) : '';
}

/** 列表项：一行够用，别把 summary 也塞进去（那是 detail 的事，省 token） */
function fmtSubjectLine(s) {
  const out = [`[id=${s.id}] ${SUBJECT_TYPES[s.type] || '条目'}《${titleOf(s)}》`];
  const meta = [s.date && `${s.date} 开播`, s.eps && `全 ${s.eps} 集`, s.platform].filter(Boolean);
  if (meta.length) out.push(`　${meta.join(' ｜ ')}`);
  const rate = [num(s.score) && `评分 ${num(s.score)}`, s.rank && `排名 #${s.rank}`, s.voters && `${s.voters} 人评`].filter(Boolean);
  if (rate.length) out.push(`　${rate.join(' ｜ ')}`);
  if (s.cover) out.push(`　封面 ${s.cover}`);
  return out.join('\n');
}

function fmtSubjectDetail(d) {
  const s = normSubject(d);
  const out = [`【${SUBJECT_TYPES[s.type] || '条目'}】${titleOf(s)}`, `id=${s.id}`];
  const meta = [s.date && `${s.date} 开播`, s.eps && `全 ${s.eps} 集`, s.platform].filter(Boolean);
  if (meta.length) out.push(meta.join(' ｜ '));
  const rate = [num(s.score) && `评分 ${num(s.score)}`, s.rank && `排名 #${s.rank}`, s.voters && `${s.voters} 人评`].filter(Boolean);
  if (rate.length) out.push(rate.join(' ｜ '));

  const col = d?.collection || {};
  const colParts = [col.wish && `想看 ${col.wish}`, col.doing && `在看 ${col.doing}`, col.collect && `看过 ${col.collect}`].filter(Boolean);
  if (colParts.length) out.push(`收藏：${colParts.join(' / ')}`);

  const tags = (Array.isArray(d?.tags) ? d.tags : [])
    .map((t) => `${clean(t?.name)}${t?.count ? `(${t.count})` : ''}`)
    .filter((t) => t && !t.startsWith('('))
    .slice(0, 10);
  if (tags.length) out.push(`标签：${tags.join('、')}`);

  if (s.summary) {
    const brief = s.summary.length > 420 ? `${s.summary.slice(0, 420)}…（简介已截断）` : s.summary;
    out.push(`简介：${brief}`);
  }
  if (s.cover) out.push(`封面 ${s.cover}`);
  return out.join('\n');
}

function fmtCast(list, limit = 8) {
  const arr = Array.isArray(list) ? list : [];
  // 主角排在配角前面：这个番被问"谁是谁"时，主角才是答案
  const sorted = [...arr].sort((a, b) => (Number(a?.type) || 9) - (Number(b?.type) || 9));
  const seen = new Set();
  const lines = [];
  for (const c of sorted) {
    const name = clean(c?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const actors = (Array.isArray(c?.actors) ? c.actors : []).map((a) => clean(a?.name)).filter(Boolean).slice(0, 3);
    const rel = CHAR_TYPE[Number(c?.type)] || '';
    lines.push(`· ${name}${rel ? `（${rel}）` : ''}　声优：${actors.length ? actors.join('、') : '暂缺'}`);
    if (lines.length >= limit) break;
  }
  return lines;
}

function fmtStaff(list, limit = 10) {
  const arr = Array.isArray(list) ? list.filter((p) => p && clean(p.relation) && clean(p.name)) : [];
  const rank = (r) => {
    const i = KEY_RELATIONS.findIndex((k) => r.includes(k));
    return i < 0 ? KEY_RELATIONS.length + 1 : i;
  };
  const sorted = [...arr].sort((a, b) => rank(clean(a.relation)) - rank(clean(b.relation)));
  const lines = [];
  const used = new Set();
  for (const p of sorted) {
    const relation = clean(p.relation);
    const name = clean(p.name);
    if (used.has(relation) && lines.length >= 6) continue;   // 同一岗位(如"作画监督"几十号人)别刷屏
    used.add(relation);
    lines.push(`· ${relation}：${name}`);
    if (lines.length >= limit) break;
  }
  return lines;
}

/** 本地日期字符串，用于算"播到第几集" —— 这个减法交给代码，别让模型算 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const err = (content) => ({ content, isError: true });

/** 把各种失败翻译成"模型看得懂、能自救"的一句话 */
function explain(err0, what) {
  const msg = String(err0?.message ?? err0);
  if (err0?.basesDown) {
    return `${what}失败：Bangumi 的接口一个都连不上（${msg.slice(0, 160)}）。`
      + '这几乎总是**本机网络到 Bangumi 不通** —— 官方 api.bgm.tv 挂在 Cloudflare，大陆直连常超时，'
      + '所以本技能默认走镜像 api.bangumi.vip；镜像域名偶尔会换或失效。'
      + '处理办法：让用户到「番剧资料查询」设置里看「接口域名」一栏（留空=自动，先试镜像再试官方），'
      + '也可以自己填一个当时能打开的镜像域名。**不要**因此凭印象编资料：'
      + '需要的话用 web_search 兜底，或者如实说这次查不到。';
  }
  if (err0?.status === 429) return `${what}失败：Bangumi 限流了（HTTP 429）。稍等几秒再试一次；如果反复出现，让用户把「番剧资料查询」设置里的「请求最小间隔」调到 1200。`;
  if (err0?.status === 403) return `${what}失败：Bangumi 拒绝了请求（HTTP 403），通常是 User-Agent 不合规被拦。让用户检查「番剧资料查询」设置里的 User-Agent（留空即用内置值）。`;
  if (err0?.timeout) return `${what}失败：请求超时（Bangumi 响应太慢）。可以重试一次，或者改用 web_search。`;
  if (/未声明 web_fetch|没有拿到 fetch/.test(msg)) return `${what}失败：本技能没有联网权限（清单里缺少 web_fetch）。让用户在「插件/技能」页把「番剧资料查询」重装或检查权限声明。`;
  return `${what}失败：${msg.slice(0, 140)}。可以改用 web_search 兜底；不要凭印象编资料。`;
}

const NO_HIT = [
  '别硬编。下一步：用 web_search 搜「作品名 动画」或「作品名 评分」，有结果再回答；',
  '还是查不到就如实说「没查到」，或者用玩笑把话带过去。'
].join('');

/* ── 工具 ───────────────────────────────────────────────────────────────── */

export function setup(api) {
  skillApi = api;
  cfg = api.config;
  doFetch = api.fetch;

  /* 1) 搜作品 / 角色 / 人物 ------------------------------------------------ */
  api.registerTool({
    id: 'search',
    name: '搜番剧/角色/人物',
    description: '在 Bangumi（bgm.tv）里搜索动画、漫画、轻小说、游戏、音乐等作品条目，也可以搜角色或声优/制作人。群友提到某个番、某个角色、某个声优时，先用它拿到 **id**，需要详情再调详情工具。参数 keyword 填作品名或人名（中日文都行；越接近官方名越准，「芙莉莲」比「那个精灵魔法师番」准得多）。',
    category: 'web',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要搜的作品名/角色名/人名，例如「葬送的芙莉莲」「Frieren」' },
        kind: { type: 'string', enum: ['subject', 'character', 'person'], description: '搜什么：subject=作品条目（默认）｜character=角色｜person=声优/制作人' },
        type: { type: 'string', description: '仅 kind=subject 时有效：anime（动画，默认）/ book（书籍·漫画·轻小说）/ game / music / real（三次元）' },
        limit: { type: 'number', description: '返回几条，1~10，默认用设置里的值' }
      },
      required: ['keyword']
    },
    async execute(_ctx, args) {
      const c = cfg() || {};
      const keyword = clean(args?.keyword);
      if (!keyword) return err('缺少 keyword：告诉我要搜什么。');
      const kind = String(args?.kind || 'subject').toLowerCase();
      if (!['subject', 'character', 'person'].includes(kind)) {
        return err(`不认识的 kind=${kind}，只能是 subject / character / person。`);
      }
      const limit = clamp(Number(args?.limit) || Number(c.defaultLimit) || 5, 1, 10);
      const allowNsfw = c.allowNsfw === true;

      try {
        if (kind === 'subject') {
          const typeNum = resolveType(args?.type, 2);
          const { list, total, via } = await searchSubjects(keyword, typeNum, limit, allowNsfw);
          const normalized = (Array.isArray(list) ? list : []).map(normSubject).filter((s) => s && s.id);
          const items = (allowNsfw ? normalized : normalized.filter((s) => !s.nsfw)).slice(0, limit);
          // 过滤掉了几条要说清楚：否则"匹配 5 条、只列 3 条"看起来像工具出错了
          const blocked = normalized.length - (allowNsfw ? normalized.length : normalized.filter((s) => !s.nsfw).length);
          if (!items.length) {
            return {
              content: `Bangumi 里没搜到「${keyword}」相关的${SUBJECT_TYPES[typeNum] || ''}条目`
                + (blocked ? `（有 ${blocked} 条成人向结果被设置过滤掉了）` : '')
                + `。${NO_HIT}`
            };
          }
          const head = `Bangumi 匹配到 ${total || normalized.length} 条${SUBJECT_TYPES[typeNum] || '条目'}`
            + `（来自 Bangumi${via === 'legacy' ? '·旧接口' : ''}），这里列出 ${items.length} 条：`
            + (blocked ? `\n（另有 ${blocked} 条成人向结果已按设置过滤，不在下面。）` : '');
          return {
            content: `${head}\n\n${items.map(fmtSubjectLine).join('\n\n')}\n\n`
              + '（要讲剧情/评分/制作阵容就用 detail 工具带上面的 id 去查；'
              + '如果列表里的信息已经够回答群友，就不用再调了。）'
          };
        }

        const list = await searchByKind(kind, keyword, limit, allowNsfw);
        if (!list.length) {
          return { content: `Bangumi 里没搜到「${keyword}」这个${kind === 'character' ? '角色' : '人物'}。${NO_HIT}` };
        }
        const lines = list.slice(0, limit).map((raw) => {
          const name = clean(raw?.name);
          const id = raw?.id;
          if (kind === 'character') {
            const actors = (Array.isArray(raw?.actors) ? raw.actors : []).map((a) => clean(a?.name)).filter(Boolean).slice(0, 3);
            const from = clean(raw?.relation);
            return `[id=${id}] 角色「${name}」`
              + (actors.length ? `　声优：${actors.join('、')}` : '')
              + (from ? `　（关联：${from}）` : '');
          }
          const career = (Array.isArray(raw?.career) ? raw.career : []).map(clean).filter(Boolean).slice(0, 5);
          return `[id=${id}] 人物「${name}」${career.length ? `　职业：${career.join('、')}` : ''}`;
        });
        return {
          content: `搜到 ${list.length} 个${kind === 'character' ? '角色' : '人物'}（列出前 ${lines.length} 个）：\n${lines.join('\n')}\n\n`
            + '（想看这个人的详细资料，用 detail 工具带 kind=' + kind + ' 和上面的 id。）'
        };
      } catch (e) {
        return err(explain(e, `搜索「${keyword}」`));
      }
    }
  });

  /* 2) 详情 ---------------------------------------------------------------- */
  api.registerTool({
    id: 'detail',
    name: '番剧/角色详情',
    description: '按 id 查 Bangumi 的详细资料。kind=subject：简介、评分排名、集数、放送日期、标签、收藏数，并附**主要制作阵容**；把 characters 打开还能拿到**登场角色与声优**（问「声优是谁」时才开，会多一次请求）。kind=character / person：角色或声优·制作人的资料。id 必须来自「搜番剧/角色/人物」工具，不要自己编。',
    category: 'web',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'], description: 'Bangumi 条目 id（从 search 工具拿到的 id 原样填）' },
        kind: { type: 'string', enum: ['subject', 'character', 'person'], description: '查什么：subject=作品（默认）｜character=角色｜person=声优/制作人' },
        staff: { type: 'boolean', description: '仅 kind=subject：是否附主要制作阵容（制作公司、监督、脚本等），默认 true。' },
        characters: { type: 'boolean', description: '仅 kind=subject：是否附登场角色与声优，默认 false。只在群友问「声优是谁」「有哪些角色」时打开。' }
      },
      required: ['id']
    },
    async execute(_ctx, args) {
      const raw = String(args?.id ?? '').trim();
      if (!/^\d+$/.test(raw)) {
        return err(`id 必须是数字（拿到的是「${raw || '空'}」）。id 要从 search 工具的结果里原样取，不能自己编。`);
      }
      const id = Number(raw);
      const kind = String(args?.kind || 'subject').toLowerCase();

      try {
        if (kind === 'character' || kind === 'person') {
          const d = await fetchJson(`/v0/${kind === 'character' ? 'characters' : 'persons'}/${id}`, {
            ttl: TTL.detail,
            cacheKey: `x:${kind}:${id}`
          }).then((r) => r.data);
          const name = clean(d?.name);
          if (!name) return { content: `Bangumi 上没有 id=${id} 的${kind === 'character' ? '角色' : '人物'}。${NO_HIT}` };
          const out = [`【${kind === 'character' ? '角色' : '人物'}】${name}`, `id=${id}`];
          const career = (Array.isArray(d?.career) ? d.career : []).map(clean).filter(Boolean);
          if (career.length) out.push(`职业：${career.join('、')}`);
          const summary = clean(d?.summary);
          if (summary) out.push(`简介：${summary.length > 400 ? `${summary.slice(0, 400)}…` : summary}`);
          return { content: out.join('\n') };
        }

        const d = await getSubject(id);
        if (!d || !clean(d.name)) {
          return { content: `Bangumi 上没有 id=${id} 的条目（id 可能填错了）。${NO_HIT}` };
        }
        const blocks = [fmtSubjectDetail(d)];

        // 制作阵容：单独一个接口，失败不该拖垮整条详情
        if (args?.staff !== false) {
          try {
            const lines = fmtStaff(asList(await getStaff(id)));
            if (lines.length) blocks.push(`主要制作阵容：\n${lines.join('\n')}`);
          } catch { /* 缺阵容不算失败 */ }
        }
        // 声优表：只有明确要才拉，省一次请求
        if (args?.characters === true) {
          try {
            const lines = fmtCast(asList(await getCast(id)));
            if (lines.length) blocks.push(`登场角色与声优：\n${lines.join('\n')}`);
          } catch { /* 缺声优表不算失败 */ }
        }

        blocks.push('（用你自己的话讲给群里，挑群友问的那几个点说；'
          + '不要把 id、字段名、封面链接整段念出来。想发封面图可以用 send_image，记得先 preview。）');
        return { content: blocks.join('\n\n') };
      } catch (e) {
        return err(explain(e, `查 id=${id} 的详情`));
      }
    }
  });

  /* 3) 剧集与更新进度 ------------------------------------------------------ */
  api.registerTool({
    id: 'episodes',
    name: '剧集与更新进度',
    description: '列出某部番的剧集和各自播出日期，并**自动算出已经播到第几集**（这个减法已由工具做好，直接照抄，别自己算日期）。群友问「更新到哪了」「这周更没更」「还剩几集完结」时用。subjectId 必须来自搜索工具。',
    category: 'web',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        subjectId: { type: ['integer', 'string'], description: '作品 id（从 search 工具拿到的 id 原样填）' },
        type: { type: 'string', description: '剧集类型：本篇（默认）/ SP / OP / ED；填 all 表示不限。' },
        limit: { type: 'number', description: '最多列出几集，1~30，默认 12（列出的是**最近已播出**的几集）。' }
      },
      required: ['subjectId']
    },
    async execute(_ctx, args) {
      const raw = String(args?.subjectId ?? '').trim();
      if (!/^\d+$/.test(raw)) {
        return err(`subjectId 必须是数字（拿到的是「${raw || '空'}」）。它要从 search 工具的结果里取。`);
      }
      const subjectId = Number(raw);
      const t = args?.type === undefined || args?.type === null || args?.type === '' ? 0
        : (String(args.type).toLowerCase() === 'all' ? null : EP_TYPES[String(args.type)] ?? EP_TYPES[String(args.type).toLowerCase()] ?? 0);
      const limit = clamp(Number(args?.limit) || 12, 1, 30);

      try {
        const { list, total } = await getEpisodes(subjectId, t, 100, 0);
        const all = Array.isArray(list) ? list : [];
        if (!all.length) {
          return { content: `Bangumi 上没有 id=${subjectId} 的剧集记录（可能填错了 id，或者这部还没登记集数）。${NO_HIT}` };
        }
        const today = todayStr();
        const aired = all.filter((e) => e?.airdate && String(e.airdate) <= today);
        const upcoming = all.filter((e) => e?.airdate && String(e.airdate) > today)
          .sort((a, b) => String(a.airdate).localeCompare(String(b.airdate)));
        const label = t === null ? '全部' : (EP_TYPES[String(t)] || '本篇');

        const out = [`kind=${label}，共登记 ${total || all.length} 集，其中**已播出 ${aired.length} 集**（对比日期：${today}）。`];
        const shown = aired.slice(-limit);
        if (shown.length) {
          out.push(`最近已播出：\n${shown.map((e) => {
            const no = e.ep || e.sort || '';
            const name = clean(e.name_cn) || clean(e.name);
            return `· 第 ${no} 集${name ? `「${name}」` : ''}　${e.airdate}`;
          }).join('\n')}`);
        }
        if (upcoming.length) {
          const next = upcoming[0];
          out.push(`下一集：第 ${next.ep || next.sort || '?'} 集　${next.airdate}`);
        } else if (aired.length && aired.length >= (total || all.length)) {
          out.push('这部已经全部播完（没有待播集）。');
        }
        out.push('（上面这些数字照抄即可，不要自己推算或改动。已播出集数=工具按本机日期算好的。）');
        return { content: out.join('\n\n') };
      } catch (e) {
        return err(explain(e, `查 id=${subjectId} 的剧集`));
      }
    }
  });

  /* 4) 放送表 ------------------------------------------------------------- */
  api.registerTool({
    id: 'calendar',
    name: '今日/本周放送表',
    description: 'Bangumi 的每日放送表：某一天更新哪些番。群友问「今天有什么番更新」「这季有什么新番」「周三更什么」时用。weekday 默认 today，也可以填 0~6（0=周一，6=周日）或「周三」这种说法。',
    category: 'web',
    icon: '📅',
    parameters: {
      type: 'object',
      properties: {
        weekday: { type: 'string', description: '哪一天：today（默认）/ 0~6（0=周一）/ 「周三」等中文说法' },
        limit: { type: 'number', description: '最多列几部，1~30，默认 15。' }
      }
    },
    async execute(_ctx, args) {
      const c = cfg() || {};
      const limit = clamp(Number(args?.limit) || 15, 1, 30);
      const CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      const rawWd = clean(args?.weekday) || 'today';
      let idx;
      if (rawWd === 'today' || rawWd === '今天') {
        // JS: 0=周日 .. 6=周六；放送表: 0=周一 .. 6=周日
        idx = (new Date().getDay() + 6) % 7;
      } else if (/^[0-6]$/.test(rawWd)) {
        idx = Number(rawWd);
      } else if (rawWd === '明天') {
        idx = (new Date().getDay() + 6) % 7 + 1;
        if (idx > 6) idx -= 7;
      } else {
        const cn = CN.findIndex((d) => rawWd.includes(d.replace('周', '')));
        if (cn < 0) return err(`weekday 只能是 today / 0~6 / 「周三」这类写法（拿到的是「${rawWd}」）。`);
        idx = cn;
      }

      try {
        const cal = await getCalendar();
        const day = Array.isArray(cal) ? cal[idx] : null;
        const items = Array.isArray(day?.items) ? day.items : [];
        const allowNsfw = c.allowNsfw === true;
        const shown = items.filter((x) => allowNsfw || x?.nsfw !== true).slice(0, limit);
        if (!shown.length) {
          return { content: `Bangumi 放送表里，${CN[idx]}没有登记更新的番（也可能是接口这次没返回数据）。可以改用 web_search 查「本季新番表」。` };
        }
        const lines = shown.map((x) => {
          const name = clean(x?.name_cn) || clean(x?.name);
          const extra = [clean(x?.name_cn) && clean(x?.name) && clean(x?.name) !== clean(x?.name_cn) ? clean(x.name) : '',
            x?.rating?.score ? `评分 ${num(x.rating.score)}` : ''].filter(Boolean);
          return `· 《${name}》（id=${x?.id}）${extra.length ? `　${extra.join(' ｜ ')}` : ''}`;
        });
        return {
          content: `${CN[idx]}更新 ${items.length} 部（列出前 ${lines.length} 部）：\n${lines.join('\n')}\n\n`
            + `（用你自己的话报给群里，别把 id 念出来；想查某一部的详情，拿它的 id 用 detail 工具。）`
        };
      } catch (e) {
        return err(explain(e, `查${CN[idx]}的放送表`));
      }
    }
  });

  api.log('已就绪：4 个工具（search / detail / episodes / calendar），数据源 %s（自动转移）',
    forcedBase() || `${BASE_CANDIDATES.map(hostOf).join(' → ')}`);
}

/** 无 Key 依赖，永远可用。 */
export function available() { return { ok: true }; }

/** 自测用：不注册工具，直接调这些。 */
export const internals = {
  normSubject,
  asList,
  fmtSubjectLine,
  fmtSubjectDetail,
  fmtCast,
  fmtStaff,
  resolveType,
  todayStr,
  explain,
  fixImageUrl,
  cdnHostFor,
  isBaseFailure,
  orderedBases,
  withBase,
  hostOf,
  BASE_CANDIDATES,
  internals_getActiveBase: () => activeBase,
  internals_setCfg: (fn) => { cfg = fn; },
  internals_setFetch: (fn) => { doFetch = fn; },
  /** 隔断用例之间的相互影响：源会"粘住"、判死的源会进冷却期，都是跨 setup 的模块级状态 */
  internals_resetBases: () => { activeBase = null; baseDeadUntil.clear(); },
  cache
};
