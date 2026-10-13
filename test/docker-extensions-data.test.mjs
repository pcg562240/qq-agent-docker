import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-extension-data-'));
process.env.QQ_AGENT_DATA_DIR=dir; process.env.QQ_AGENT_DOCKER='1';
globalThis.fetch=async()=>{throw Error('OFFLINE');};
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const A='A1'.repeat(16),B='B2'.repeat(16),G='group:'+('C3'.repeat(16));
function api(c={}){return {config:()=>c,log(){},warn(){},error(){},hasCapability:()=>false,capability:()=>undefined};}
// Mongo-shaped deterministic store: validates filters, operator semantics and operation ordering.
function database(){
 const tables={},events=[];let n=0;
 const match=(r,q)=>Object.entries(q).every(([k,v])=>{if(k==='$or')return v.some(x=>match(r,x));const a=r[k];if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Date))return Object.entries(v).every(([op,x])=>op==='$in'?x.includes(a):op==='$ne'?a!==x:op==='$lt'?a<x:op==='$lte'?a<=x:op==='$exists'?(a!==undefined)===x:false);return a===v;});
 const db={tables,events,collection(name){const rows=tables[name]||=[];
 const update=(q,u,{upsert=false}={})=>{let r=rows.find(r=>match(r,q));let fresh=false;if(!r&&upsert){r={...q,_id:++n};rows.push(r);fresh=true;}if(!r)return {matchedCount:0,modifiedCount:0};if(fresh)Object.assign(r,u.$setOnInsert);Object.assign(r,u.$set);for(const [k,v]of Object.entries(u.$inc||{}))r[k]=(r[k]||0)+v;for(const[k,v]of Object.entries(u.$max||{}))r[k]=Math.max(r[k]??-Infinity,v);for(const[k,v]of Object.entries(u.$push||{}))(r[k]||=[]).push(v);return{matchedCount:1,modifiedCount:1};};
 return {find(q){let found=rows.filter(r=>match(r,q));return{project(){return this;},sort(){return this;},limit(n){found=found.slice(0,n);return this;},toArray:async()=>structuredClone(found)};},findOne:async q=>structuredClone(rows.find(r=>match(r,q))||null),insertOne:async r=>{events.push(['insert',name]);rows.push({...structuredClone(r),_id:++n});return{insertedId:n};},updateOne:async(q,u,o)=>{events.push(['update',name]);return update(q,u,o);},updateMany:async(q,u)=>{let n=0;for(const r of rows.filter(r=>match(r,q))){update({_id:r._id},u);n++;}return{modifiedCount:n};},deleteOne:async q=>{const i=rows.findIndex(r=>match(r,q));if(i>=0)rows.splice(i,1);return{deletedCount:i>=0?1:0};},deleteMany:async q=>{events.push(['delete',name]);const old=rows.length;for(let i=rows.length-1;i>=0;i--)if(match(rows[i],q))rows.splice(i,1);return{deletedCount:old-rows.length};},countDocuments:async q=>rows.filter(r=>match(r,q)).length};}};return db;
}
const {ingestCandidates,extractMemories}=await import('../plugins/memory-growth/lib/mg-extract.js');
const {reviewCandidate,forgetOne,archiveOne,undoPromote}=await import('../plugins/memory-growth/lib/mg-review.js');
test('memory: extract real model JSON shape, privacy before model and candidate validation',async()=>{
 const db=database();let body;
 const result=await extractMemories(db,{}, {chatKey:G,entries:[{senderId:A,text:'我们约好周末去旅行'},{senderId:B,text:'密码 secret'},{senderId:B,text:'mail me foo@example.com'}],llm:async r=>{body=r;return{message:{content:JSON.stringify([{kind:'event',content:'我们约好周末去旅行',subject_id:A,confidence:.9},{kind:'event',content:'虚构他人说的话语',subject_id:B,confidence:.9},{kind:'bad',content:'not a valid kind',subject_id:A}])}};}});
 assert.equal(result.newCount,1);assert.ok(!JSON.stringify(body).includes('secret'));assert.ok(!JSON.stringify(body).includes('foo@example.com'));assert.equal(db.tables.memory_candidates[0].status,'pending');assert.equal(db.tables.memory_candidates[0].subject_id,A);
 await assert.rejects(extractMemories(db,{}, {chatKey:G,entries:[{text:'hello world',senderId:A}],llm:async()=>({message:{content:'not json'}})}));
});
test('memory: promotion, embeddings, duplicate counts and same-chat/subject isolation',async()=>{
 const db=database(),c={tenantId:'fixture',autoApproveEnabled:true};const raw={kind:'event',content:'我们约好周末去旅行',subject_id:A,confidence:.99};
 await ingestCandidates(db,c,[raw],G);let item=db.tables.memory_items[0];assert.ok(item);assert.equal(item.status,'active');assert.equal(item.embed_provider,'local-hash');assert.ok(item.embedding.length);const tenant=item.tenant_id,id=item.memory_id;
 await ingestCandidates(db,c,[raw],G);assert.equal(item.mention_count,2);assert.equal(db.tables.memory_items.length,1);
 await ingestCandidates(db,c,[raw],G+'other');assert.equal(db.tables.memory_items.length,2);
 assert.equal((await reviewCandidate(db,c,{action:'approve',memoryId:id,tenant,chatKey:'group:wrong'})).ok,false);
 assert.equal((await undoPromote(db,tenant,id,'group:wrong')).ok,false);assert.equal(db.tables.memory_items.length,2);
 const p=await archiveOne(db,c,{tenant,chatKey:G,memoryIds:[id]});assert.equal(p.applied,false);assert.equal(item.archived,undefined);
 assert.equal((await archiveOne(db,c,{tenant,chatKey:G,memoryIds:[id],confirm:true})).count,1);assert.equal(item.archived,true);
 await forgetOne(db,tenant,[id],G);assert.equal(db.tables.memory_items.length,1);const audit=db.events.findIndex(([op,n])=>op==='insert'&&n==='memory_audit');assert.ok(audit<db.events.findIndex(([op])=>op==='delete'));
});
test('memory: rejected candidates stay rejected when reReviewAfter=0; audit failure prevents deletion',async()=>{
 const db=database();await ingestCandidates(db,{reReviewAfter:0},[{kind:'event',content:'我们约好周末去旅行'}],G);let row=db.tables.memory_candidates[0];row.status='rejected';
 await ingestCandidates(db,{reReviewAfter:0},[{kind:'event',content:'我们约好周末去旅行'}],G);assert.equal(row.status,'rejected');
 const original=db.collection.bind(db);db.collection=n=>n==='memory_audit'?{insertOne:async()=>{throw Error('disk full');}}:original(n);
 await assert.rejects(forgetOne(db,row.tenant_id,[row.memory_id],G),/disk full/);assert.equal(db.tables.memory_candidates.length,1);
});
test('knowledge queue retains failed writes and deduplicates concurrent flushes',async()=>{
 const{IngestQueue}=await import('../plugins/kb-growth/lib/kb-ingest.js');let fail=true,calls=0;
 const queue=new IngestQueue({onFlush:async rows=>{calls++;assert.equal(rows.length,1);if(fail)throw Error('offline');}});
 await queue.enqueue({taskId:'one',tenantId:'a',kind:'query',payload:{query:'fixture'}});await assert.rejects(queue.flush());assert.equal(queue.size,1);fail=false;
 await Promise.all([queue.flush(),queue.flush()]);assert.equal(queue.size,0);assert.equal(calls,2);
});
test('knowledge audit writes profile dir, disabled mode works, failure retains buffer',async()=>{
 const{AuditLogger}=await import('../plugins/kb-growth/lib/kb-audit.js');const off=new AuditLogger({enabled:false});off.log('none');await off.flush();off.close();
 const a=new AuditLogger();a.log('fixture');await a.flush();assert.match(fs.readFileSync(path.join(dir,'kb-growth/audit.jsonl'),'utf8'),/fixture/);a.close();
 const f=path.join(dir,'kb-growth/audit.jsonl');fs.unlinkSync(f);fs.mkdirSync(f);const b=new AuditLogger();b.log('pending');await assert.rejects(b.flush());assert.equal(b.buffer.length,1);clearInterval(b.timer);fs.rmdirSync(f);await b.flush();b.close();
});
test('affinity: each batch member receives own feedback, search OpenID, flat settings, durable reset',async()=>{
 const mod=await import('../plugins/affinity/index.js');mod.setup(api({enabled:true,inject:true,toolWrite:true,rebirthEnabled:true,rebirthBuffMult:2}));await mod.activate();
 // Compare hook accounting against direct provider for the same individual text.
 const pa=mod.providers['affinity.inbound']({personId:A,text:'谢谢你',chatKey:G});
 mod.hooks['before-context']({chatKey:G,sessionId:'batch',triggerEntries:[{senderId:B,text:'hello'},{senderId:'12345',text:'谢谢你'}]});
 mod.hooks['before-llm-messages']({sessionId:'batch',messages:[{role:'system',content:'base'}]});
 mod.providers['affinity.adjust']({personId:A,delta:5,reason:'fixture'});
 const rows=JSON.parse(fs.readFileSync(path.join(dir,'affinity/affinity-state.json')));assert.equal(rows.find(r=>r.person_id===B).events.length,0);assert.equal(rows.find(r=>r.person_id==='12345').events.length,pa.applied?1:0);
 const found=mod.providers['affinity.people']({q:A});assert.ok(JSON.stringify(found).includes(A));assert.ok(!JSON.stringify(found).includes(B));
 const rebirth=mod.providers['affinity.rebirth']({personId:A,confirm:true});assert.equal(rebirth.ok,true);assert.equal(mod.providers['affinity.query']({personId:A}).rebirth.buffMult,2);
 await mod.deactivate();await mod.activate();assert.equal(mod.providers['affinity.query']({personId:A}).rebirth.count,1);await mod.deactivate();
});
test('affinity store timers belong to each instance; failed flush never reports success',async()=>{
 const{AffinityStore}=await import('../plugins/affinity/lib/aff-store.js');const a=new AffinityStore({dataDir:path.join(dir,'aff-a')}),b=new AffinityStore({dataDir:path.join(dir,'aff-b')});a.getState(A);b.getState(B);a.close();assert.ok(b.writeTimer);b.close();assert.ok(fs.existsSync(b.stateFile));
 assert.throws(()=>b.getState('bad'));b.getState(A);fs.mkdirSync(b.stateFile+'.tmp');assert.throws(()=>b.flush());fs.rmdirSync(b.stateFile+'.tmp');b.close();
});
test('knowledge media reader forbids paths outside profile and symlink escapes, bounds data images',async()=>{
 const{readLocalImage,imagesFromMessage,downloadImage}=await import('../skills/knowledge-verify/lib/image-source.js');const png=Buffer.from('89504e470d0a1a0a0000000049454e44','hex');const f=path.join(dir,'test.png');fs.writeFileSync(f,png);assert.ok(readLocalImage(f));assert.equal(readLocalImage(f,4),null);
 const outside=path.join(os.tmpdir(),'qa-image-'+process.pid+'.png');fs.writeFileSync(outside,png);try{fs.symlinkSync(outside,path.join(dir,'link.png'));assert.equal(readLocalImage(outside),null);assert.equal(readLocalImage(path.join(dir,'link.png')),null);}finally{fs.unlinkSync(outside);}
 assert.ok(await downloadImage('https://example.com',{fetchImpl:async()=>({buffer:png,contentType:'image/png'})}));assert.equal(await downloadImage('https://example.com',{fetchImpl:async()=>({buffer:Buffer.from('<html>not image')})}),null);
 assert.equal((await imagesFromMessage({chatKey:G,store:{findByMid:()=>({media:[{kind:'image',url:'data:image/png;base64,'+png.toString('base64')} ]})}},'fixture',{maxBytes:4})).length,0);
});
test('owner and speaker identity accept complete OpenIDs without treating nicknames as identities',async()=>{
 const owner=await import('../plugins/owner-identity/index.js');assert.deepEqual(owner.normalizeOwnerIds([A,'12345','a nickname']),[A,'12345']);assert.equal(owner.isOwnerId(A,[A]),true);assert.equal(owner.isOwnerId(B,[A]),false);
 const speaker=await import('../plugins/speaker-identity/index.js');assert.equal(speaker.stripSpeakerTags('hello (QQ:'+A+')'),'hello');
});
test('role tool replacement preserves following persona sections and dispose cancels delayed writes',async t=>{
 const mod=await import('../plugins/角色卡工具同步/index.js');const s=mod.syncRoleToolsSection('## 人设\nhello\n## 可用工具\nold\n## 限制\npreserve me',['send_message']);assert.match(s,/preserve me/);assert.ok(!s.includes('\nold\n'));mod.setup(api());t.mock.timers.enable({apis:['setTimeout']});mod.activate();mod.deactivate();t.mock.timers.tick(3000);assert.equal(fs.existsSync(path.join(dir,'config.json')),false);
});
test('proactive burst windows count sent messages, isolate groups, clear on disable',async()=>{
 const mod=await import('../plugins/proactive-chat/index.js');mod.setup(api({enabled:true,minGapSec:20,maxConsecutive:3}));await mod.activate();assert.equal(mod.proactiveStatus({chatKey:G}).shouldProactive,true);
 mod.hooks['after-tool']({chatKey:G,session:{id:'s',sent:[]}});assert.equal(mod.proactiveStatus({chatKey:G}).shouldProactive,true);
 mod.hooks['after-tool']({chatKey:G,session:{id:'s',sent:[{}]}});assert.equal(mod.proactiveStatus({chatKey:G}).shouldProactive,false);assert.equal(mod.proactiveStatus({chatKey:'group:other'}).shouldProactive,true);await mod.deactivate();assert.equal(mod.proactiveStatus({chatKey:G}).shouldProactive,true);
});
test('meme search never fills unmatched cue results with arbitrary items',async()=>{
 const mod=await import('../skills/meme-lib/index.js');let tool;const caps={'meme.data':async()=>({ok:true,items:[{text:'fixture meme',tags:[]}]}),'meme.cue':async()=>({cues:[]})};mod.setup({...api(),hasCapability:n=>n in caps,capability:(n,a)=>caps[n]?.(a),registerTool:t=>{if(t.id==='meme_search')tool=t;}});assert.match((await tool.execute({},{query:'unrelated'})).content,/没有相关条目/);
});
test('knowledge and memory shutdown release inactive workers, without implicit extraction',async()=>{
 const{IngestWorker}=await import('../plugins/kb-growth/lib/kb-worker.js');const w=new IngestWorker({mongo:null,config:()=>({})});await w.start();await w.stop();assert.equal(w.running,false);assert.equal(w.timer,null);assert.equal(w.promoteTimer,null);assert.ok(w.firstTimer._destroyed);assert.ok(w.indexTimer._destroyed);
 const mod=await import('../plugins/memory-growth/index.js');mod.setup(api());assert.equal((await mod.providers['memory.extraction']({chatKey:G})).ok,false);assert.equal((await mod.providers['memory.recall']({chatKey:G,query:'fixture'})).degraded,true);await mod.deactivate();
});
test('memory deactivate does not clear a later Mongo activation after slow close',async t=>{
 const{MongoHandle}=await import('../plugins/memory-growth/lib/mg-mongo.js');const mod=await import('../plugins/memory-growth/index.js');let first,unblock;
 t.mock.method(MongoHandle.prototype,'connect',async function(){this.db={collection:()=>({createIndexes:async()=>{}})};first ||= this;});
 t.mock.method(MongoHandle.prototype,'close',function(){return this===first?new Promise(r=>{unblock=r;}):Promise.resolve();});
 mod.setup(api({semanticEmbedEnabled:false}));await mod.activate();const closing=mod.deactivate();await mod.activate();unblock();await closing;assert.equal(mod.available().reason,'Mongo 已连接');await mod.deactivate();
});
