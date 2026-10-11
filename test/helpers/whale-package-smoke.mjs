// Optional smoke test for an actual downloaded whale-memes ZIP. No real QQ/LLM,
// gallery requests or outbound messages: all external edges use local fixtures.
// Usage: QQ_AGENT_DOCKER=1 QQ_AGENT_DATA_DIR=<temp> node this-file.mjs <zip>
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { importZip } from '../../src/module-import.js';
import { loadPlugins } from '../../src/plugin-loader.js';
import { getTool } from '../../src/tool-registry.js';
import { skillManager } from '../../src/skills/manager.js';
import { QQBotClient } from '../../src/qqbot.js';
import { DATA_DIR } from '../../src/config.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2S0AAAAASUVORK5CYII=','base64');
globalThis.fetch=async url=>{
  if(String(url)==='https://aigengtu.com/gallery-index.json') return Response.json({gallery:{fixture:{name:'DeepSeek娘',images:[{name:'DeepSeek娘『测试』',original:'https://img.aigengtu.com/fixture.png'}]}}});
  if(String(url)==='https://img.aigengtu.com/fixture.png') return new Response(png);
  throw new Error('Unexpected network request in offline test');
};
const installed=await importZip(fs.readFileSync(process.argv[2]));
assert.equal(installed.id,'whale-memes');
await loadPlugins({log(){}});
assert.equal(skillManager.registry.get('whale-memes')?.loadError,null);
const list=getTool('whale-memes__list_memes'), send=getTool('whale-memes__send_meme');
assert.ok(list && send);
assert.ok(!(await list.execute({chatKey:'group:FIXTURE'},{})).isError);
let sent=0;
class FakeBot {
  constructor(){this.events=new Map();}
  on(name,fn){this.events.set(name,fn);}
  start(){this.events.get('ready')?.({user:{id:'fixture'}});return new Promise(r=>this.finish=r);}
  stop(){this.finish?.();}
  async sendImage(target,source){assert.deepEqual(source.buffer,png);sent++;return {message:{id:'FAKE_IMAGE'}};}
}
const client=new QQBotClient({dataDir:DATA_DIR,getOptions:()=>({appId:'111',clientSecret:'TEST'}),Bot:FakeBot,allow:()=>true,log(){}});
await client.connect();await new Promise(r=>setImmediate(r));
try {
  const result=await send.execute({chatKey:'group:FIXTURE',sender:{sendImage:(_chat,{file})=>client.sendImage('group','FIXTURE',file)}},{pick:'fixture'});
  assert.ok(!result.isError,result.content);assert.equal(sent,1);
  assert.ok(fs.existsSync(path.join(DATA_DIR,'whale-memes','state.json')));
  console.log('Actual whale-memes ZIP: ESM imports, load, two tools, catalog/cache, image buffer send and state PASS (offline, zero real QQ sends).');
} finally {client.close();}
