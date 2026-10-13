import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PERSONAS } from '../src/personas.js';

test('maintainer whale revision is the default template, retaining the original as a separate choice', () => {
  assert.equal(PERSONAS.xiaojingyu.name, '小鲸鱼（默认）');
  assert.match(PERSONAS.xiaojingyu.text, /深海蓝渐变色的长发/);
  assert.match(PERSONAS.xiaojingyu.text, /专业问题认真回答，闲聊时可爱互动/);
  assert.match(PERSONAS.xiaojingyuOriginal.text, /常被画成闭眼\/蒙眼/);
  assert.notEqual(PERSONAS.xiaojingyu.text, PERSONAS.xiaojingyuOriginal.text);
  assert.doesNotMatch(PERSONAS.xiaojingyu.text, /https?:\/\/|\b[A-F0-9]{32}\b|\b\d{6,}\b/);
});

test('new configs use the revised default but existing global and per-chat personas are never overwritten', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-persona-default-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const run=code=>execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,QQ_AGENT_DATA_DIR:dir,QQ_AGENT_PROFILES_ROOT:'',QQ_AGENT_ACTIVE_ROBOT:'',QQ_AGENT_DOCKER:'1',QQ_AGENT_CHANNEL:'qqbot'}});
  run(`import assert from 'node:assert/strict';import {getConfig} from './src/config.js';import {PERSONAS} from './src/personas.js';assert.equal(getConfig().persona.roleText,PERSONAS.xiaojingyu.text);`);
  const saved={persona:{roleText:'SAVED_GLOBAL'},personaByChat:{'group:GROUP_TEST':{roleText:'SAVED_GROUP'}},customPersonas:[{name:'saved',text:'SAVED_CARD'}]};
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(saved));
  run(`import assert from 'node:assert/strict';import {getConfig} from './src/config.js';const c=getConfig();assert.equal(c.persona.roleText,'SAVED_GLOBAL');assert.equal(c.personaByChat['group:GROUP_TEST'].roleText,'SAVED_GROUP');assert.equal(c.customPersonas[0].text,'SAVED_CARD');`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'config.json'))),saved);
});
