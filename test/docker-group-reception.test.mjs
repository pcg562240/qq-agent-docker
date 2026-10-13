import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrateQQGroupReception } from '../src/qq-group-reception.js';

const old = () => ({ channel: { type: 'qqbot' }, qqbot: { requireMention: true, appId: '123456', markdown: false },
  allow: { groups: ['GROUP_A'] }, api: { model: 'keep-model' }, skills: { fixture: { enabled: false } },
  store: { unifiedTier: false, contextSliderPos: 95, contextTier: 4, historyCount: 37,
    groupSliderPos: { GROUP_A: 99, GROUP_B: 60 }, groupPeakPos: { GROUP_A: { peak: 75, valley: 99 } },
    peakSchedule: { enabled: true, peak: { start: '09:00', end: '18:00', sliderPos: 70 }, valley: { sliderPos: 95 } } } });

test('legacy @-only reception migrates to visible response sliders, preserving all unrelated settings', () => {
  const input = old(), before = structuredClone(input);
  const next = migrateQQGroupReception(input, { official: true });
  assert.deepEqual(input, before); assert.equal(next.qqbot.requireMention, undefined);
  assert.equal(next.store.contextTier, 1); assert.equal(next.store.contextSliderPos, 5);
  assert.equal(next.store.historyCount, 37); assert.equal(next.store.unifiedTier, false);
  assert.deepEqual(next.store.groupSliderPos, { GROUP_A: 5, GROUP_B: 5 });
  assert.deepEqual(next.store.groupPeakPos, { GROUP_A: { peak: 5, valley: 5 } });
  assert.deepEqual(next.store.peakSchedule.peak, { start: '09:00', end: '18:00', sliderPos: 5 });
  assert.equal(next.store.peakSchedule.valley.sliderPos, 5); assert.equal(next.store.peakSchedule.enabled, true);
  for (const key of ['api', 'allow', 'skills', 'channel']) assert.deepEqual(next[key], before[key]);
  assert.equal(next.qqbot.appId, before.qqbot.appId); assert.equal(next.qqbot.markdown, false);
  assert.equal(migrateQQGroupReception(next, { official: true }), next, 'migration is idempotent');
  next.store.contextSliderPos = 95;
  assert.equal(migrateQQGroupReception(next, { official: true }).store.contextSliderPos, 95, 'future slider edits win');
});

test('legacy all-message mode preserves tiers; missing legacy setting and OneBot do not migrate', () => {
  const input = old(); input.qqbot.requireMention = false;
  const next = migrateQQGroupReception(input, { official: true });
  assert.deepEqual(next.store, input.store); assert.equal(next.qqbot.requireMention, undefined);
  const fresh = { qqbot: {}, store: { contextTier: 4 } };
  assert.equal(migrateQQGroupReception(fresh, { official: true }), fresh);
  assert.equal(migrateQQGroupReception(input, { official: false }), input);
});

test('loading migration is read-only, saving retires alias and a stale form cannot reset new per-group tiers', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-reception-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(old()));
  const run = code => execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(),
    env: { ...process.env, QQ_AGENT_DATA_DIR: dir, QQ_AGENT_PROFILES_ROOT: '', QQ_AGENT_ACTIVE_ROBOT: '', QQ_AGENT_DOCKER: '1', QQ_AGENT_CHANNEL: 'qqbot', QQBOT_APP_ID: '', QQBOT_APP_SECRET: '' } });
  run(`import fs from 'node:fs'; import assert from 'node:assert/strict';
    import { getConfig, updateConfig, storeConfigForChat } from './src/config.js';
    const file=process.env.QQ_AGENT_DATA_DIR+'/config.json', before=fs.readFileSync(file,'utf8');
    assert.equal(getConfig().qqbot.requireMention,undefined);
    assert.equal(storeConfigForChat('group:GROUP_A').contextTier,1);
    assert.equal(storeConfigForChat('group:GROUP_B').contextTier,1);
    assert.equal(fs.readFileSync(file,'utf8'),before);
    updateConfig({qqbot:{requireMention:true},store:{peakSchedule:{enabled:false},groupSliderPos:{GROUP_A:95}}});
    assert.equal(storeConfigForChat('group:GROUP_A').contextTier,4);
    assert.equal(storeConfigForChat('group:GROUP_B').contextTier,1);
    assert.equal(getConfig().qqbot.requireMention,undefined);`);
  const saved = JSON.parse(fs.readFileSync(file)); assert.equal(saved.qqbot.requireMention, undefined);
  run(`import assert from 'node:assert/strict'; import { storeConfigForChat } from './src/config.js';
    assert.equal(storeConfigForChat('group:GROUP_A').contextTier,4);
    assert.equal(storeConfigForChat('group:GROUP_B').contextTier,1);`);
});

test('connection UI describes storage versus triggers and never submits the retired reception gate', () => {
  const html=fs.readFileSync(new URL('../ui/connection.html',import.meta.url),'utf8');
  const js=fs.readFileSync(new URL('../ui/connection.js',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="requireMention"/); assert.doesNotMatch(js,/requireMention/);
  assert.match(html,/均会存档/); assert.match(html,/响应档位/); assert.match(html,/旧版/);
});
