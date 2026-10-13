// Write-side counterpart of the official settingsView masking policy.
// Never persist UI masks as credentials, or transfer masked keys between endpoints.
const SECRET_NAME = /key|token|secret|password|cookie/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const endpointFields = ['baseUrl', 'baseURL', 'url', 'endpoint'];
const sameEndpoint = (a, b) => endpointFields.every(k => String(a?.[k] ?? '').trim() === String(b?.[k] ?? '').trim());
const publicPart = item => Object.fromEntries(Object.entries(item).filter(([k]) => !SECRET_NAME.test(k))
  .sort(([a], [b]) => a.localeCompare(b)));

export function skillSettingsPatch(input, current = {}, schema = {}, defaults = {}) {
  const allowed = new Set([...Object.keys(schema), ...Object.keys(defaults)]);
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!allowed.has(key)) continue;
    const secret = schema[key]?.secret || (SECRET_NAME.test(key) && typeof current[key] === 'string');
    if (secret && (value === '******' || String(value ?? '').trim() === '')) continue;
    if (!Array.isArray(value)) { out[key] = value; continue; }
    const old = Array.isArray(current[key]) ? current[key] : [];
    out[key] = value.map(item => {
      if (!object(item)) return item;
      const next = { ...item };
      const masks = Object.keys(item).filter(k => SECRET_NAME.test(k) && item[k] === '******');
      if (!masks.length) return next;
      // Stable IDs survive reordering. Never use array index as credential identity.
      const matches = old.filter(previous => object(previous) && (item.id != null
        ? String(previous.id) === String(item.id)
        : JSON.stringify(publicPart(previous)) === JSON.stringify(publicPart(item))));
      if (matches.length !== 1) throw new Error('账号身份不明确，请重新填写密钥后保存。');
      for (const field of masks) {
        next[field] = sameEndpoint(item, matches[0]) ? (matches[0][field] ?? '') : '';
      }
      return next;
    });
  }
  return out;
}
