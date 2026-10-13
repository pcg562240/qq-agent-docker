// kb-retrieve.js —— 混合检索（从宿主 kb-retrieve.js 提炼；tokens 倒排预筛 + 向量余弦 + 关键词分融合）
import { tokenize, round } from './kb-util.js';

export async function retrieveFromKb(mongoHandle, opts = {}) {
  const db = mongoHandle.db;
  const t0 = Date.now();
  const { tenant, query, topK = 5 } = opts;
  const qTokens = tokenize(query);
  const retrieve = opts;

  // 服务端聚合：tokens 倒排预筛（$match + tenant_tokens 索引）+ $setIntersection 算命中数
  let hits = [];
  try {
    hits = await db.collection('knowledge_chunks').aggregate([
      { $match: { tenant_id: tenant, status: 'active', tokens: { $in: qTokens } } },
      { $addFields: { hit_count: { $size: { $setIntersection: ['$tokens', qTokens] } } } },
      { $sort: { hit_count: -1 } },
      { $limit: 120 },
    ]).toArray();
  } catch { return { confidence: 0, hits: [], ms: Date.now() - t0 }; }

  // 应用侧：top-K 补取向量 → 余弦 → 融合
  // No query embedding is supplied: normalize the available lexical component to [0,1].
  const scored = hits.map((h) => {
    const kwScore = h.hit_count / Math.max(1, qTokens.length);

    const conf = round(Math.min(1, Math.max(0, kwScore)));
    return { ...h, _conf: conf, retrieval: 'lexical' };
  }).filter(h => h._conf >= (retrieve.hardMinConfidence ?? 0.58)).sort((a, b) => b._conf - a._conf).slice(0, topK);

  const maxConf = scored[0]?._conf ?? 0;
  const hardMin = retrieve.hardMinConfidence ?? 0.58;
  if (maxConf < hardMin) return { confidence: 0, hits: [], ms: Date.now() - t0 };
  return { confidence: maxConf, hits: scored, ms: Date.now() - t0 };
}

export function buildKbContext(hits, maxChars = 2600) {
  const parts = [];
  let budget = maxChars;
  for (const h of hits) {
    const line = '【' + (h.title ?? h.topic ?? '') + '】 ' + (h.content ?? '').slice(0, 400) + '（来源：' + (h.source_url ?? '-') + '）';
    if (budget - line.length < 0 && parts.length) break;
    parts.push(line);
    budget -= line.length;
  }
  return parts.join('\n');
}
