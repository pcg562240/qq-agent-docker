// Optional manifest/UI extension. A saved secret belongs to one service address.
function endpoint(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.href.replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch { return String(value || '').trim(); }
}
export function bindSkillSecrets(patch, current, schema) {
  const out = { ...patch };
  for (const [key, rule] of Object.entries(schema)) {
    if (!rule?.secret || typeof rule.boundTo !== 'string') continue;
    const field = rule.boundTo;
    if (Object.hasOwn(out, field) && endpoint(out[field]) !== endpoint(current[field]) && !Object.hasOwn(out, key)) out[key] = '';
  }
  return out;
}

export function skillModelRoutes(manager) {
  return ['GET','POST'].map(method => ({
    method, pattern:/^\/api\/skills\/([^/]+)\/model-catalog$/,
    handler:async ({res,json,match}) => {
      const skill = manager.registry.get(decodeURIComponent(match[1]));
      if (!skill || typeof skill.modelCatalog !== 'function') return json(res,404,{ok:false,error:'该技能没有模型目录功能'});
      try {
        const value = await skill.modelCatalog({refresh:method === 'POST'});
        // Do not forward arbitrary fields returned by an extension into the UI.
        const models = (Array.isArray(value?.models) ? value.models : []).filter(x => typeof x === 'string' && x.length <= 200).slice(0,1000);
        return json(res,200,{ok:true,models,updatedAt:typeof value?.updatedAt === 'string' ? value.updatedAt.slice(0,40) : null});
      } catch {
        return json(res,400,{ok:false,error:'获取模型失败：请先保存本技能的正确地址和 Key，并检查服务连接。旧列表和已选模型保持不变，可手填 ID。'});
      }
    }
  }));
}
