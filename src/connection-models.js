// Simplified connection-page model management. Uses the same shared provider
// catalog as the full console; never returns stored keys to the browser.
import { randomUUID } from 'node:crypto';
import { getConfig, updateConfig } from './config.js';
import { resolveApiKey } from './llm.js';
import { fetchModelsFrom, testModelChat } from './providers.js';

const error = message => Object.assign(new Error(message), { expose: true, status: 400 });
const trim = value => String(value ?? '').trim();
const key = value => trim(value) === '******' ? '' : trim(value);
export function modelEndpoint(value) {
  const raw = trim(value);
  let url;
  try { url = new URL(raw); } catch { throw error('请填写完整的 HTTP / HTTPS API Base URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || raw.length > 2048) {
    throw error('Base URL 只接受 HTTP / HTTPS 地址，不含用户名、密码、查询参数或片段。');
  }
  const base = url.href.replace(/\/+$/, '');
  if (/\/(?:models|chat\/completions)$/i.test(base)) throw error('Base URL 请去掉末尾的 /models 或 /chat/completions。');
  return base;
}
function canonical(value) { try { return modelEndpoint(value); } catch { return trim(value).replace(/\/+$/, ''); } }
function modelId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw error('请填写有效的模型 ID。');
  return value.trim();
}
function providerKey(p, cfg) { return key(cfg.dshProviderKeys?.[p.id]) || key(p.apiKey); }
function ids(p) { return (p.models || []).map(m => typeof m === 'string' ? m : m?.id).filter(m => typeof m === 'string' && m); }

export function connectionModelCatalog(cfg = getConfig()) {
  const a = cfg.api || {};
  const items = (cfg.providers || []).flatMap(p => ids(p).map(model => ({
    providerId: p.id, providerName: p.displayName || p.id, model,
    name: p.modelNames?.[model] || model, baseUrl: p.baseURL || '', hasKey: Boolean(providerKey(p, cfg)),
    active: a.provider === p.id && a.model === model && canonical(a.baseUrl) === canonical(p.baseURL)
  })));
  let current = items.find(m => m.active);
  if (!current) {
    current = { providerId: '', providerName: '当前手动配置', model: a.model || '', name: a.model || '',
      baseUrl: a.baseUrl || '', hasKey: Boolean(resolveApiKey(cfg)), active: true, legacy: true };
    if (current.model && current.baseUrl) items.unshift(current);
  }
  return { items, current, shared: Boolean(process.env.QQ_AGENT_PROFILES_ROOT) };
}

// Stored credentials are eligible ONLY for their exact, normalized endpoint.
// A newly edited URL never inherits the active provider's key as a fallback.
export function resolveConnectionModel(input, cfg = getConfig()) {
  const baseUrl = modelEndpoint(input.baseUrl);
  const providerId = trim(input.providerId);
  const explicit = key(input.apiKey);
  if (typeof input.apiKey !== 'undefined' && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192)) throw error('API Key 格式不正确。');
  let p;
  if (providerId) {
    p = (cfg.providers || []).find(p => p.id === providerId);
    if (!p || canonical(p.baseURL) !== baseUrl) throw error('所选模型服务与 Base URL 不一致，请重新选择或新增模型。');
  } else if (input.useCurrent === true) {
    if (canonical(cfg.api?.baseUrl) !== baseUrl) throw error('当前服务地址已变化，请重新选择模型或填写新服务的 API Key。');
  } else {
    const matches = (cfg.providers || []).filter(p => canonical(p.baseURL) === baseUrl);
    if (matches.length === 1) p = matches[0];
    else if (matches.length > 1 && !explicit) throw error('该地址有多个已保存服务，请从模型列表选择服务，或填写本次使用的 API Key。');
  }
  const apiKey = explicit || (p ? providerKey(p, cfg)
    : canonical(cfg.api?.baseUrl) === baseUrl ? resolveApiKey(cfg) : '');
  return { baseUrl, apiKey, providerId: p?.id || '', model: trim(input.model) ? modelId(input.model) : '' };
}
function cloneCatalog(cfg) {
  const providers = structuredClone(cfg.providers || []), keys = { ...cfg.dshProviderKeys };
  for (const p of providers) {
    const saved = providerKey(p, cfg);
    if (saved) keys[p.id] = saved;
    delete p.apiKey;
    p.models = ids(p);
  }
  return { providers, keys };
}
function addModel(catalog, { baseUrl, apiKey, providerId, model }) {
  let p = providerId ? catalog.providers.find(p => p.id === providerId) : null;
  if (!p) p = catalog.providers.find(p => canonical(p.baseURL) === baseUrl && key(catalog.keys[p.id]) === apiKey);
  if (!p) {
    p = { id: `custom_${randomUUID()}`, displayName: new URL(baseUrl).host, api: 'openai', baseURL: baseUrl, models: [], modelNames: {} };
    catalog.providers.push(p);
  }
  if (!p.models.includes(model)) p.models.push(model);
  p.modelNames = { ...p.modelNames, [model]: p.modelNames?.[model] || model };
  catalog.keys[p.id] = apiKey;
  return p;
}
function preserveCurrent(catalog, cfg) {
  if (!cfg.api?.baseUrl || !cfg.api?.model) return;
  let baseUrl, model;
  try { baseUrl = modelEndpoint(cfg.api.baseUrl); model = modelId(cfg.api.model); } catch { return; }
  // Saving the old manual slot before selection makes it possible to switch
  // back without ever exposing or retyping its stored key.
  addModel(catalog, { baseUrl, apiKey: resolveApiKey(cfg), model,
    providerId: catalog.providers.find(p => p.id === cfg.api.provider && canonical(p.baseURL) === canonical(cfg.api.baseUrl))?.id });
}
function commit(catalog, active) {
  const patch = { providers: catalog.providers, dshProviderKeys: { __replace__: catalog.keys } };
  if (active) patch.api = { provider: active.providerId, baseUrl: active.baseUrl, model: active.model, apiKey: '' };
  updateConfig(patch); // One write of shared model settings; preserves advanced settings.
  return connectionModelCatalog();
}
export function saveConnectionModel(input) {
  const cfg = getConfig(), resolved = resolveConnectionModel(input, cfg);
  resolved.model = modelId(input.model);
  const catalog = cloneCatalog(cfg);
  if (input.activate === true) preserveCurrent(catalog, cfg);
  const p = addModel(catalog, resolved);
  const selected = { providerId: p.id, model: resolved.model, baseUrl: resolved.baseUrl };
  return { ...commit(catalog, input.activate === true ? selected : null), saved: selected, activated: input.activate === true };
}
export function selectConnectionModel(input) {
  const cfg = getConfig(), model = modelId(input.model);
  const p = (cfg.providers || []).find(p => p.id === input.providerId);
  if (!p || !ids(p).includes(model)) throw error('请选择已保存的模型；当前列表可能已变化，请刷新。');
  const baseUrl = modelEndpoint(p.baseURL), catalog = cloneCatalog(cfg);
  preserveCurrent(catalog, cfg);
  return { ...commit(catalog, { providerId: p.id, model, baseUrl }), activated: true };
}

function redact(value, cfg, submitted = '') {
  let text = String(value ?? '');
  const secrets = [submitted, cfg.api?.apiKey, ...Object.values(cfg.dshProviderKeys || {}), ...(cfg.providers || []).map(p => p.apiKey)]
    .filter(s => typeof s === 'string' && s && s !== '******').sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text.slice(0, 1500);
}
export function createConnectionModelRoutes(readBody) {
  return [
    { method: 'GET', pattern: '/api/connection/models', handler: async ({ res, json }) => json(res, 200, connectionModelCatalog()) },
    ...['fetch', 'test', 'save', 'select'].map(action => ({ method: 'POST', pattern: `/api/connection/models/${action}`,
      handler: async ({ req, res, json }) => {
        let body, resolved; const cfg = getConfig();
        try {
          body = await readBody(req, { maxBytes: 16384 });
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw error('无效的模型请求。');
          if (action === 'save') return json(res, 200, { ok: true, ...saveConnectionModel(body) });
          if (action === 'select') return json(res, 200, { ok: true, ...selectConnectionModel(body) });
          resolved = resolveConnectionModel(body, cfg);
          if (action === 'fetch') {
            const models = await fetchModelsFrom(resolved.baseUrl, resolved.apiKey);
            return json(res, 200, { ok: true, models });
          }
          const result = await testModelChat({ ...resolved, model: modelId(body.model) });
          return json(res, 200, { ok: true, result: { ...result, note: redact(result.note, cfg, resolved.apiKey) } });
        } catch (e) {
          return json(res, e.status || 502, { ok: false, error: redact(e.message, cfg, resolved?.apiKey || body?.apiKey) });
        }
      } }))
  ];
}
