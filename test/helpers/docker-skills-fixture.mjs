// Replace only the marketplace boundary; never contact the real marketplace/QQ.
import fs from 'node:fs';
import { moduleZip } from './module-zip.mjs';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const u = String(url);
  if (u === 'https://www.kondius.cn/api/community/install/verify') {
    return Response.json({ results: [{ code: 'SKILL1', ok: true, type: 'skill', id: 'code-fixture' }] });
  }
  if (u === 'https://www.kondius.cn/api/community/install/SKILL1/download') return new Response(moduleZip('code-fixture'));
  if (u === 'https://www.kondius.cn/api/community/install/PLUGIN1/download') return new Response(moduleZip('plugin-fixture', 'plugin'));
  if (u === 'https://www.kondius.cn/api/community/market/publish') {
    fs.writeFileSync(process.env.TEST_PUBLISHED_ZIP, Buffer.from(await options.body.get('file').arrayBuffer()));
    return Response.json({ ok: true, item: { id: 'code-fixture' } });
  }
  return realFetch(url, options);
};
await import('./docker-profiles-fixture.mjs');
