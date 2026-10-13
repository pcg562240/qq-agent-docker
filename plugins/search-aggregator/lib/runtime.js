import {aggregate,cleanItems,sanitizeQuery,bingHtml,so360Html,baiduWebHtml,sogouHtml} from './aggregate.js';
const HTML_ENGINES={bing:bingHtml,so360:so360Html,baiduWeb:baiduWebHtml,sogou:sogouHtml};
const ALIASES={bingHtml:'bing',so360Html:'so360',baiduWebHtml:'baiduWeb',sogouHtml:'sogou'};
const GPT='chatgpt2api';
function number(c,key,fallback,lo,hi) {
  const n=Number(c[key] ?? fallback);
  if(!Number.isFinite(n) || n<lo || n>hi) throw Error(`${key} 须在 ${lo}～${hi} 范围内`);
  return n;
}
export function configuration(c={}) {
  const engines=[...new Set(String(c.engines ?? 'bing,so360,baiduWeb,sogou').split(',').map(x=>x.trim()).filter(Boolean).map(x=>ALIASES[x]||x))];
  if(!engines.length || engines.some(x=>x!==GPT && !Object.hasOwn(HTML_ENGINES,x))) throw Error('引擎请选择 bing,so360,baiduWeb,sogou,chatgpt2api（逗号分隔）');
  const mode=c.chatgptMode ?? 'parallel';if(!['parallel','fallback'].includes(mode))throw Error('ChatGPT 模式须为 parallel 或 fallback');
  return {engines,mode,timeoutMs:Math.floor(number(c,'timeoutMs',8000,100,60000)),
    chatgptTimeoutMs:Math.floor(number(c,'chatgptTimeoutMs',120000,1000,600000)),
    maxResults:Math.floor(number(c,'maxResults',8,1,20)),maxPerDomain:Math.floor(number(c,'maxPerDomain',3,1,20)),
    consensusBoost:number(c,'consensusBoost',0.25,0,5),k:number(c,'rrfK',60,1,1000)};
}
// Abort and race: even a broken adapter ignoring AbortSignal cannot hold a run.
async function bounded(work,signal,timeoutMs) {
  const c=new AbortController(),combined=AbortSignal.any([signal,c.signal]);
  let timer,listener;
  try {
    if(combined.aborted)throw Error('stopped');
    const stop=new Promise((_,reject)=>{listener=()=>reject(Error('stopped'));combined.addEventListener('abort',listener,{once:true});});
    timer=setTimeout(()=>c.abort(),timeoutMs);
    return await Promise.race([Promise.resolve().then(()=>{if(combined.aborted)throw Error('stopped');return work(combined);}),stop]);
  } finally {clearTimeout(timer);combined.removeEventListener('abort',listener);c.abort();}
}
export function createAggregator({engines:adapters=HTML_ENGINES}={}) {
  let api,active=true;const pending=new Set();
  async function search({query,maxResults,signal,timeoutMs}={}) {
    const c=configuration(api.config()),q=sanitizeQuery(query);
    if(!q)throw Error('请填写搜索关键词');
    const limit=maxResults ?? c.maxResults;
    if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('maxResults 须为 1～20 的整数');
    if(timeoutMs!==undefined && (!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000))throw Error('搜索预算须为 1～600000 毫秒');
    const run=new AbortController();pending.add(run);
    const combined=signal ? AbortSignal.any([signal,run.signal]) : run.signal;
    const timer=timeoutMs===undefined ? null : setTimeout(()=>run.abort(),timeoutMs);
    const t0=Date.now(),results=[],answers=[],engineStatus=[];
    async function execute(engine) {
      if(combined.aborted || !active){engineStatus.push({engine,status:'cancelled'});return;}
      if(engine===GPT && !api.hasCapability('search.chatgpt2api')) {
        engineStatus.push({engine,status:'unavailable',reason:'请配置并启用「ChatGPT 联网搜索」技能'});return;
      }
      let value;
      try {
        value=await bounded(s=>engine===GPT
          ? api.capability('search.chatgpt2api',{query:q,maxResults:Math.min(15,limit),signal:s,summarize:false})
          : adapters[engine](q,{fetcher:api.fetch,signal:s}),combined,engine===GPT?c.chatgptTimeoutMs:c.timeoutMs);
        if(combined.aborted || !active)throw Error('stopped');
        if(engine===GPT ? !value || !Array.isArray(value.sources) : !Array.isArray(value))throw Error('invalid result');
        const items=cleanItems(engine===GPT?value.sources:value);
        const answer=engine===GPT && typeof value.answer==='string' ? value.answer.slice(0,12000).trim() : '';
        results.push({engine,items});
        if(answer)answers.push({engine,answer,hasSources:items.length>0});
        engineStatus.push({engine,status:items.length||answer?'ok':'empty'});
      } catch {
        engineStatus.push({engine,status:combined.aborted?'cancelled':'failed',reason:'请求失败、超时或返回格式异常（未重试）'});
      }
    }
    try {
      if(!active || combined.aborted)throw Error('聚合搜索已停止');
      if(c.engines.includes(GPT) && c.mode==='fallback') {
        await Promise.all(c.engines.filter(e=>e!==GPT).map(execute));
        if(results.some(r=>r.items.length))engineStatus.push({engine:GPT,status:'skipped',reason:'普通引擎已有结果，未调用 ChatGPT'});
        else await execute(GPT);
      } else await Promise.all(c.engines.map(execute));
      if(!active || combined.aborted)throw Error('聚合搜索已停止或超出调用预算');
      // Stable output regardless of completion order.
      results.sort((a,b)=>c.engines.indexOf(a.engine)-c.engines.indexOf(b.engine));
      engineStatus.sort((a,b)=>c.engines.indexOf(a.engine)-c.engines.indexOf(b.engine));
      return {results:aggregate(results,{...c,maxResults:limit}).items,answers,
        enginesUsed:results.map(x=>x.engine),engineStatus,ms:Date.now()-t0,allFailed:!results.length};
    } finally {clearTimeout(timer);pending.delete(run);run.abort();}
  }
  const stop=()=>{active=false;for(const c of pending)c.abort();};
  return {setup(a){api=a;},providers:{'search.aggregate':search},
    available(){try {const c=configuration(api?.config());
      if(c.engines.length===1 && c.engines[0]===GPT && !api?.hasCapability('search.chatgpt2api'))return {ok:false,reason:'请配置并启用「ChatGPT 联网搜索」技能'};
      return {ok:true};}catch(e){return {ok:false,reason:e.message};}},
    activate(){active=true;},deactivate:stop,dispose:stop};
}
