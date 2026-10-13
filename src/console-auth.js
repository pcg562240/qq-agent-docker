import { timingSafeEqual } from 'node:crypto';

// Accept explicitly chosen passwords; docker:init still generates 64 random
// hexadecimal characters. Keep the cookie/header-safe alphabet and upper bound.
export function validConsoleToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(value);
}

// Explicit authorities (host[:port]), never wildcards or arbitrary LAN ranges.
// Restrict the syntax before URL normalization so credentials, paths, escapes,
// ambiguous numeric IP forms and DNS-rebinding domains cannot slip through.
function authority(value) {
  if (typeof value !== 'string' || !/^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/i.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    const rawHost = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0];
    if (url.hostname !== rawHost.toLowerCase()) return null;
    return { host: url.host, hostname: url.hostname };
  } catch { return null; }
}

export function parseConsoleAllowedHosts(value = '') {
  const values = Array.isArray(value) ? value : String(value).split(/[\s,]+/).filter(Boolean);
  return [...new Set(values.map(item => {
    const parsed = authority(item);
    if (!parsed) throw new Error('QQ_AGENT_ALLOWED_HOSTS 只接受明确的主机:端口，不含协议、路径或通配符');
    return parsed.host;
  }))];
}

export function consoleOriginAllowed(req, server = {}) {
  const parsed = authority(req.headers.host);
  if (!parsed) return false;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  // Non-loopback access is opt-in and may never inherit password-free desktop mode.
  if (!local && (!server.token || !Array.isArray(server.allowedHosts) || !server.allowedHosts.includes(parsed.host))) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const scheme = req.socket?.encrypted ? 'https:' : 'http:';
  const expected = new URL(`${scheme}//${req.headers.host}`).origin;
  for (const name of ['origin', 'referer']) {
    const value = req.headers[name];
    if (value === undefined) continue; // Token-authenticated non-browser clients.
    if (typeof value !== 'string' || value.trim() !== value) return false;
    try {
      const url = new URL(value);
      if (url.origin !== expected || url.username || url.password) return false;
      if (name === 'origin' && value !== url.origin) return false;
    } catch { return false; }
  }
  // Deliberately ignore forwarded host/proto headers: no trusted proxy is configured.
  return true;
}

export function tokenEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length > 0 && aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function consoleAuthorized(req, token) {
  if (!token) return true; // Retain local desktop behavior.
  const url = new URL(req.url, 'http://127.0.0.1');
  const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim())
    .find(x => x.startsWith('qq_agent_console='))?.slice('qq_agent_console='.length);
  return [req.headers['x-console-token'], cookie, url.searchParams.get('token')]
    .some(value => tokenEqual(value, token));
}
