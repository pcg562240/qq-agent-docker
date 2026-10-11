import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleOriginAllowed, parseConsoleAllowedHosts } from '../src/console-auth.js';
import { dockerEnvironment } from '../src/docker-env.js';

const server = { token: 'test-only', allowedHosts: parseConsoleAllowedHosts('192.168.100.25:3210,mac-test.local:3210,[fd00::25]:3210') };
const req = (host, extra = {}) => ({ headers: { host, ...extra }, socket: {} });

test('loopback access remains available without opting into LAN', () => {
  for (const host of ['localhost:3210', '127.0.0.1:3210', '[::1]:3210']) {
    assert.equal(consoleOriginAllowed(req(host, { origin: `http://${host}` })), true);
  }
  assert.equal(consoleOriginAllowed(req('192.168.100.25:3210'), { token: 'test-only' }), false);
});

test('explicit LAN IP, mDNS and IPv6 authorities accept same-origin requests', () => {
  for (const host of server.allowedHosts) {
    assert.equal(consoleOriginAllowed(req(host, { origin: `http://${host}`, referer: `http://${host}/connection.html` }), server), true);
    assert.equal(consoleOriginAllowed(req(host), server), true);
  }
});

test('LAN access requires authentication configuration and exact host/port', () => {
  assert.equal(consoleOriginAllowed(req('192.168.100.25:3210'), { ...server, token: '' }), false);
  for (const host of ['192.168.100.26:3210', '192.168.100.25:3211', 'mac-test.local.evil.test:3210', 'evil.test:3210']) {
    assert.equal(consoleOriginAllowed(req(host), server), false);
  }
});

test('cross-origin, cross-port, cross-scheme and opaque requests are rejected', () => {
  const host = '192.168.100.25:3210';
  for (const origin of ['https://evil.test', 'http://192.168.100.25:3211', 'https://192.168.100.25:3210', 'null', '', `http://${host}/`, `http://user@${host}`]) {
    assert.equal(consoleOriginAllowed(req(host, { origin }), server), false, origin);
  }
  assert.equal(consoleOriginAllowed(req(host, { referer: 'https://evil.test/' }), server), false);
  assert.equal(consoleOriginAllowed(req(host, { origin: `http://${host}`, referer: 'https://evil.test/' }), server), false);
  assert.equal(consoleOriginAllowed(req(host, { 'sec-fetch-site': 'cross-site' }), server), false);
});

test('forwarded headers do not authorize an unknown host or origin', () => {
  assert.equal(consoleOriginAllowed(req('evil.test', { 'x-forwarded-host': '192.168.100.25:3210' }), server), false);
  assert.equal(consoleOriginAllowed(req('192.168.100.25:3210', { origin: 'https://192.168.100.25:3210', 'x-forwarded-proto': 'https' }), server), false);
});

test('invalid allowlists and Host parsing tricks fail closed', () => {
  for (const host of ['*', '*.local', 'http://192.168.100.25:3210', 'localhost/path', 'evil.test@localhost', 'localhost:65536', 'localhost\\evil', 'localhost#fragment', '127.1', '2130706433', '0x7f000001', '[::1%25en0]:3210']) {
    assert.throws(() => parseConsoleAllowedHosts(host), /QQ_AGENT_ALLOWED_HOSTS/, host);
    assert.equal(consoleOriginAllowed(req(host), server), false, host);
  }
});

test('allowlist parsing normalizes case, duplicates and default HTTP ports', () => {
  assert.deepEqual(parseConsoleAllowedHosts('Mac-Test.local:3210,mac-test.local:3210\n192.168.100.25:80'), ['mac-test.local:3210', '192.168.100.25']);
});

test('Docker allowlist is environment-only and does not mutate saved config', () => {
  const base = { server: { allowedHosts: ['saved.example:3210'] } };
  const out = dockerEnvironment(base, { QQ_AGENT_DOCKER: '1', QQ_AGENT_ALLOWED_HOSTS: '192.168.100.25:3210' });
  assert.deepEqual(out.server.allowedHosts, ['192.168.100.25:3210']);
  assert.deepEqual(base.server.allowedHosts, ['saved.example:3210']);
  assert.deepEqual(dockerEnvironment(base, { QQ_AGENT_DOCKER: '1' }).server.allowedHosts, []);
});
