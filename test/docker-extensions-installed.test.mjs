import test,{after}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';
const root=path.resolve(import.meta.dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-installed-'));process.env.QQ_AGENT_DATA_DIR=dir;process.env.QQ_AGENT_DOCKER='1';globalThis.fetch=async()=>{throw Error('OFFLINE');};
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
function api(settings={}){const tools=new Map();return{tools,config:()=>settings,registerTool:t=>tools.set(t.id,t),log(){},warn(){},error(){},fetch:globalThis.fetch};}
// Same two-level layout as the real external extension directory; do not import installable source in place.
fs.mkdirSync(path.join(dir,'extensions/skills'),{recursive:true});fs.symlinkSync(path.join(root,'src'),path.join(dir,'extensions/src'),'dir');fs.writeFileSync(path.join(dir,'extensions/package.json'),' {"type":"module"}');
for(const id of ['comfy-draw','steam-deals','verify-first','whale-memes','bangumi-lookup'])test(`installed ${id}: copy clean source into external layout and register all tools`,async()=>{
 const dst=path.join(dir,'extensions/skills',id);fs.cpSync(path.join(root,'examples/skills',id),dst,{recursive:true});const m=JSON.parse(fs.readFileSync(path.join(dst,'skill.json')));const mod=await import(pathToFileURL(path.join(dst,'index.js')));const a=api(m.settings);a.safeFetchText=async()=>{throw Error('OFFLINE');};a.safeFetchBinary=async()=>{throw Error('OFFLINE');};mod.setup(a);assert.ok(a.tools.size>0);for(const t of a.tools.values()){assert.equal(typeof t.execute,'function');assert.equal(t.parameters.type,'object');}await mod.dispose?.();
});
test('whale memes: catalog cache, validated download, successful send record and failed delivery',async()=>{
 const mod=await import(pathToFileURL(path.join(dir,'extensions/skills/whale-memes/index.js')));const a=api({enabled:true,maxCount:1,maxPerHour:2,maxPerDay:3,minShortSide:0});let catalogs=0,downloads=0;
 a.safeFetchText=async()=>{catalogs++;return{statusCode:200,body:JSON.stringify({gallery:{fixture:{name:'测试角色',images:[{original:'https://example.com/fixture.png',name:'微笑'}]}}})};};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 a.safeFetchBinary=async()=>{downloads++;return{buffer:png};};mod.setup(a);
 const session={sent:[]};let sends=0;const ctx={chatKey:'group:fixture',session,sender:{sendImage:async(chat,img)=>{sends++;assert.equal(chat,'group:fixture');assert.ok(fs.readFileSync(img.file).equals(png));}}};
 const r=await a.tools.get('send_meme').execute(ctx,{pick:'fixture'});assert.notEqual(r.isError,true,r.content);assert.equal(sends,1);assert.equal(session.sent.length,1);
 await a.tools.get('list_memes').execute(ctx,{keyword:'微笑'});assert.equal(catalogs,1);assert.equal(downloads,1);
 ctx.sender.sendImage=async()=>{throw Error('delivery timeout');};const bad=await a.tools.get('send_meme').execute(ctx,{pick:'fixture'});assert.equal(bad.isError,true);assert.equal(session.sent.length,1);
});
test('bangumi: search/detail/cache/validation and API errors are honest',async()=>{
 const mod=await import('../examples/skills/bangumi-lookup/index.js');const a=api({requestIntervalMs:0,apiBase:'https://bangumi.invalid'});let calls=0,fail=false;
 a.fetch=async(url,opts)=>{calls++;assert.ok(opts.headers['User-Agent']);if(fail)return new Response('rate limit',{status:429});if(String(url).includes('/search/'))return Response.json({data:[{id:1,name:'Synthetic Anime',name_cn:'合成动画',type:2,nsfw:false,rating:{score:8}}]});return Response.json({id:1,name:'Synthetic Anime',name_cn:'合成动画',summary:'合成简介',type:2,rating:{score:8},tags:[]});};mod.setup(a);
 const search=a.tools.get('search');assert.match((await search.execute({},{keyword:'合成动画'})).content,/合成动画/);assert.equal(calls,1);await search.execute({},{keyword:'合成动画'});assert.equal(calls,1);
 assert.equal((await a.tools.get('detail').execute({},{id:'bad'})).isError,true);assert.equal(calls,1);assert.match((await a.tools.get('detail').execute({},{id:1,staff:false})).content,/合成简介/);
 fail=true;assert.equal((await search.execute({},{keyword:'different'})).isError,true);
});
