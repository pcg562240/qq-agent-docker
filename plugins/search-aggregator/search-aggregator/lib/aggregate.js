// Pure result parsing/fusion and bounded, permission-injected HTML adapters.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
export function sanitizeQuery(query) {
  return typeof query === 'string' ? query.replace(/\[CQ:[^\]]*\]/gi,' ').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,3000) : '';
}
export function normalizeUrl(value) {
  try {
    const u=new URL(String(value ?? '').trim());
    if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.href.length>2048) return '';
    u.hash='';
    for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key) || /^(fbclid|gclid)$/i.test(key)) u.searchParams.delete(key);
    return u.href;
  } catch { return ''; }
}
export function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function entities(text) {
  return String(text ?? '').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#\d+|#x[\da-f]+);/gi, s=>{
    const named={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' ','&#39;':"'"};
    if (named[s.toLowerCase()]) return named[s.toLowerCase()];
    const n=parseInt(s.slice(s[2].toLowerCase()==='x'?3:2,-1),s[2].toLowerCase()==='x'?16:10);
    return n>0 && n<=0x10ffff && !(n>=0xd800 && n<=0xdfff) ? String.fromCodePoint(n) : '';
  });
}
const text = (s,n) => entities(String(s ?? '').replace(/<[^>]*>/g,' ')).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
function resultUrl(value, base) {
  try {
    let u=new URL(entities(value),base);
    // Decode only known transparent redirects; never fetch result URLs here.
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname==='/ck/a') {
      const encoded=u.searchParams.get('u');
      if (encoded?.startsWith('a1')) u=new URL(Buffer.from(encoded.slice(2),'base64url').toString('utf8'));
    }
    const host=hostOf(base);
    if (u.hostname===host && /^\/(search|s|web|account|preferences|images|videos)(\/|$)/.test(u.pathname)) return '';
    return normalizeUrl(u.href);
  } catch { return ''; }
}
/** Only result headings, not every link in a navigation/login/captcha page. */
export function parseResults(html, base) {
  const body=String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  const headings=[...body.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)];
  const out=[];
  for (let i=0;i<headings.length && out.length<20;i++) {
    const h=headings[i], a=h[1].match(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url=resultUrl(a[2],base),title=text(a[3],300);
    if (!url || !title || out.some(x=>x.url===url)) continue;
    const tail=body.slice(h.index+h[0].length,Math.min(headings[i+1]?.index ?? body.length,h.index+h[0].length+2000));
    const snippet=tail.match(/<(?:p|div|span)\b[^>]*(?:class\s*=\s*["'][^"']*(?:abstract|summary|desc|c-abstract|str_info)[^"']*["'])[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i)?.[1]
      ?? tail.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '';
    out.push({url,title,snippet:text(snippet,1000)});
  }
  return out;
}
async function fetchResults(base, query, {fetcher=globalThis.fetch,signal}={}) {
  const url=new URL(base);url.searchParams.set(base.includes('baidu')?'wd':base.includes('sogou')?'query':'q',query.slice(0,120));
  const res=await fetcher(url.href,{headers:{'user-agent':UA,'accept-language':'zh-CN,zh;q=0.9'},redirect:'error',signal});
  if (!res.ok) {await res.body?.cancel();throw Error('搜索 HTTP 状态异常');}
  const max=2*1048576;
  if (Number(res.headers.get('content-length'))>max) {await res.body?.cancel();throw Error('搜索页面过大');}
  const reader=res.body?.getReader();if (!reader) throw Error('搜索页面为空');
  const parts=[];let length=0;
  try {for (;;) {const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>max)throw Error('搜索页面过大');parts.push(Buffer.from(value));}}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  return parseResults(Buffer.concat(parts).toString('utf8'),base);
}
export const bingHtml=(q,o)=>fetchResults('https://cn.bing.com/search',q,o);
export const so360Html=(q,o)=>fetchResults('https://www.so.com/s',q,o);
export const baiduWebHtml=(q,o)=>fetchResults('https://www.baidu.com/s',q,o);
export const sogouHtml=(q,o)=>fetchResults('https://www.sogou.com/web',q,o);
export function cleanItems(items) {
  const out=[],seen=new Set();
  for (const item of (Array.isArray(items)?items:[]).slice(0,100)) {
    const url=normalizeUrl(item?.url);if(!url || seen.has(url))continue;seen.add(url);
    out.push({url,title:text(item.title,300)||url,snippet:text(item.snippet,1000)});
  }
  return out;
}
export function aggregate(engineResults, {k=60,consensusBoost=0.25,maxPerDomain=3,maxResults=8}={}) {
  const byUrl=new Map(),seenEngines=new Set();
  for (const {engine,items} of engineResults) {
    if(seenEngines.has(engine))continue;seenEngines.add(engine);
    cleanItems(items).forEach((item,rank)=>{
      const r=byUrl.get(item.url)||{...item,engines:[],rrf:0};
      r.engines.push(engine);r.rrf+=1/(k+rank+1);
      if(!r.snippet)r.snippet=item.snippet;
      byUrl.set(item.url,r);
    });
  }
  const ranked=[...byUrl.values()].map(r=>({...r,score:r.rrf*(1+consensusBoost*(r.engines.length-1))})).sort((a,b)=>b.score-a.score);
  const perDomain=new Map(),items=[];
  for(const {rrf,...r} of ranked) {
    const host=hostOf(r.url),n=perDomain.get(host)||0;if(n>=maxPerDomain)continue;
    perDomain.set(host,n+1);items.push({...r,score:Math.round(r.score*10000)/10000});if(items.length>=maxResults)break;
  }
  return {items};
}
