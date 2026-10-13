import test,{after}from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';import os from'node:os';import path from'node:path';import dns from'node:dns';import https from'node:https';import{EventEmitter}from'node:events';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-safe-extension-'));process.env.QQ_AGENT_DATA_DIR=dir;
fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({security:{allowPrivateImageHosts:true}}));
let addresses=[{address:'93.184.215.14',family:4}],calls=[],route;
const originalLookup=dns.promises.lookup,originalRequest=https.request;
dns.promises.lookup=async()=>addresses;
https.request=(opts,cb)=>{calls.push(opts);const req=new EventEmitter();let closed=false;req.destroy=e=>{if(closed)return;closed=true;if(e)req.emit('error',e);req.emit('close');};req.end=()=>queueMicrotask(()=>route(opts,cb,req));return req;};
after(()=>{dns.promises.lookup=originalLookup;https.request=originalRequest;fs.rmSync(dir,{recursive:true,force:true});});
const{safeFetch,safeFetchBinary}=await import('../src/safe-fetch.js');
function response(cb,req,{status=200,headers={},chunks=[]}={}){const res=new EventEmitter();res.statusCode=status;res.headers=headers;res.resume=()=>req.destroy();res.destroy=()=>req.destroy();cb(res);for(const chunk of chunks)res.emit('data',Buffer.from(chunk));res.emit('end');req.destroy();}
test('public extension fetch validates every DNS address even with private image override',async()=>{
 calls=[];addresses=[{address:'93.184.215.14',family:4},{address:'127.0.0.1',family:4}];await assert.rejects(safeFetch('https://example.com'),/内网/);assert.equal(calls.length,0);
 await assert.rejects(safeFetchBinary('https://[fd00::1]/x',100,{publicOnly:true}),/内网/);assert.equal(calls.length,0);
});
test('public extension fetch pins checked IP and strictly bounds Chinese UTF-8 response bytes',async()=>{
 addresses=[{address:'93.184.215.14',family:4}];calls=[];route=(o,cb,req)=>response(cb,req,{headers:{'content-type':'text/html'},chunks:['中文'.repeat(100)]});
 const r=await safeFetch('https://example.com/a',{maxBytes:60});assert.equal(Buffer.byteLength(r.body),60);assert.equal(r.truncated,true);assert.equal(r.contentType,'text/html');assert.equal(calls[0].hostname,addresses[0].address);assert.equal(calls[0].headers.host,'example.com');assert.equal(calls[0].servername,'example.com');
});
test('redirect targets are revalidated before request, credentials and IPv6 blocked',async()=>{
 calls=[];route=(o,cb,req)=>response(cb,req,{status:302,headers:{location:'https://127.0.0.1/secret'}});await assert.rejects(safeFetch('https://example.com'),/内网/);assert.equal(calls.length,1);
 await assert.rejects(safeFetch('https://name:pass@example.com'),/凭据/);assert.equal(calls.length,1);
});
test('deadline includes slow responses and binary headers cannot override Host or inject cookies',async()=>{
 route=()=>{};await assert.rejects(safeFetch('https://example.com',{timeoutMs:10}),/时限/);
 calls=[];route=(o,cb,req)=>response(cb,req,{chunks:['123456']});const r=await safeFetchBinary('https://example.com',4,{publicOnly:true,headers:{Host:'bad',cookie:'secret',Referer:'https://example.com',accept:'bad\r\nInjected: yes'}});
 assert.equal(r.buffer.length,4);assert.equal(calls[0].headers.host,'example.com');assert.equal(calls[0].headers.cookie,undefined);assert.equal(calls[0].headers.Referer,'https://example.com');assert.ok(!calls[0].headers.accept.includes('\r'));
});
