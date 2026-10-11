import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const core = fs.readFileSync(new URL('../ui/app/00-core.js', import.meta.url), 'utf8');
const panelCode = fs.readFileSync(new URL('../ui/app/13-panels.js', import.meta.url), 'utf8');
const apiCode = core.slice(core.indexOf('async function api('), core.indexOf('\nfunction fmtTime('));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fixture(api) {
  const elements = new Map(), clicks = [];
  const get = key => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', dataset: {}, handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, querySelectorAll: () => [], click: () => clicks.push(key) });
    return elements.get(key);
  };
  const context = vm.createContext({ $: get, esc, api, setTimeout, clearTimeout,
    document: { querySelector: get, querySelectorAll: () => [] } });
  vm.runInContext(panelCode, context);
  const state = vm.runInContext('PANEL_VIEW_STATE', context);
  return { context, state, clicks, get, load: key => context.loadPanelState(key) };
}
const disabled = { key: 'affinity', name: '好感度态度层', kind: 'plugin', usable: false, reason: 'affinity：Skill 未启用' };

test('disabled panel renders its reason without a data request or automatic plugin activation', async () => {
  const requests = [], f = fixture(async (...args) => { requests.push(args); throw new Error('should not fetch'); });
  f.state.list = [disabled];
  await f.load('affinity');
  assert.equal(requests.length, 0);
  assert.match(f.get('#panels-main-box').innerHTML, /好感度态度层/);
  assert.match(f.get('#panels-main-box').innerHTML, /未启用/);
  assert.doesNotMatch(f.get('#panels-main-box').innerHTML, /HTTP 404|加载失败/);
  f.get('#panels-open-extension').handlers.click();
  assert.deepEqual(f.clicks, ['.tab[data-tab="plugins"]']);
});

test('unavailable skill details are escaped and link to the skill page', async () => {
  const f = fixture(async () => { throw new Error('should not fetch'); });
  f.state.list = [{ ...disabled, kind: 'skill', name: '<script>bad()</script>', reason: '<img src=x onerror=bad()>' }];
  await f.load('affinity');
  const html = f.get('#panels-main-box').innerHTML;
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script>|<img/);
  f.get('#panels-open-extension').handlers.click();
  assert.deepEqual(f.clicks, ['.tab[data-tab="skills"]']);
});

test('enabled panel renders fetched data and an older response cannot replace a newer unavailable selection', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  f.state.list = [{ key: 'enabled', usable: true }, disabled];
  const pending = f.load('enabled');
  await f.load('affinity');
  resolve({ data: { title: 'STALE RESULT', summary: [], sections: [] } });
  await pending;
  assert.match(f.get('#panels-main-box').innerHTML, /未启用/);
  assert.doesNotMatch(f.get('#panels-main-box').innerHTML, /STALE RESULT/);
  const next = f.load('enabled');
  resolve({ data: { title: 'LIVE RESULT', summary: [], sections: [] } });
  await next;
  assert.match(f.get('#panels-main-box').innerHTML, /LIVE RESULT/);
  assert.equal(f.state.loading, false);
});

test('API errors preserve reason-only panel/action failures, ordinary errors and HTTP fallback', async () => {
  for (const [data, message] of [[{ reason: 'affinity：Skill 未启用' }, /affinity：Skill 未启用/],
    [{ error: 'explicit error', reason: 'ignored reason' }, /explicit error/], [{}, /HTTP 404/]]) {
    const context = vm.createContext({ state: {}, CONSOLE_MARKER: '', AbortSignal, location: {},
      fetch: async () => ({ ok: false, status: 404, json: async () => data }) });
    vm.runInContext(apiCode, context);
    await assert.rejects(context.api('/api/panels/affinity'), message);
  }
});

test('all-disabled panel list opens a reason instead of making a failing detail request', async () => {
  const panels = ['affinity', 'bodystate', 'knowledge', 'meme', 'memory', 'tts'].map(key => ({
    ...disabled, key, name: key, kind: key === 'tts' ? 'skill' : 'plugin', reason: `${key}：Skill 未启用`,
  }));
  const requests = [], f = fixture(async path => { requests.push(path); return { panels }; });
  await f.context.loadPanelsView();
  for (const panel of panels) {
    await f.load(panel.key);
    assert.ok(f.get('#panels-main-box').innerHTML.includes(panel.reason));
    assert.doesNotMatch(f.get('#panels-main-box').innerHTML, /HTTP 404|加载失败/);
    f.get('#panels-open-extension').handlers.click();
    assert.equal(f.clicks.at(-1), `.tab[data-tab="${panel.kind === 'skill' ? 'skills' : 'plugins'}"]`);
  }
  assert.deepEqual(requests, ['/api/panels']);
});
