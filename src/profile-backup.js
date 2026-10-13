// Private current-profile backups. Jobs run BEFORE the app starts: no live writers,
// no real QQ/model calls. Archives are data, never a source of MongoDB endpoints.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { once } from 'node:events';
import { MongoClient, BSON } from 'mongodb';

export const BACKUP_LIMIT = 512 * 1024 * 1024;
const TOTAL_LIMIT = 2 * 1024 * 1024 * 1024, FILE_LIMIT = 64 * 1024 * 1024, COUNT_LIMIT = 50000;
const UUID = /^[a-f0-9-]{36}$/;
const mongoIds = ['kb-growth', 'memory-growth'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const atomic = (p, v) => { const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(v,null,2)+'\n',{mode:0o600});fs.renameSync(t,p); };
export function backupError(message, status=400) { const e=new Error(message);e.status=status;e.expose=true;return e; }
function validProfile(id) { if(!/^\d{1,32}$/.test(id)) throw backupError('请先选择一个已保存的机器人。');return id; }
function paths(root,id) {
  validProfile(id);const dir=path.join(root,'backups',id);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.realpathSync(dir)!==path.join(fs.realpathSync(root),'backups',id)) throw backupError('备份目录不能经过符号链接。');
  return {dir,profile:path.join(root,'robots',id),job:path.join(dir,'job.json')};
}
function safeName(name) {
  if(typeof name!=='string'||!name||name.length>1024||name.includes('\\')||name.includes('\0')||name.startsWith('/')||name.split('/').some(s=>!s||s==='.'||s==='..')||/^[A-Za-z]:/.test(name)) throw backupError('备份包含非法路径。');
  return name;
}
function safeId(id){if(!UUID.test(String(id)))throw backupError('备份标识无效。');return id;}
function checkIdentity(config,id) { if(!config || config.qqbot?.appId!==id)throw backupError('备份 AppID 与当前机器人不一致。'); }
function cleanRecordPath(name) {
  safeName(name);
  if(['backups','node_modules','.git'].includes(name.split('/')[0])||/(^|\/)(?:instance\.lock|qq-agent\.lock)$/.test(name))throw backupError('备份包含保留路径。');
  return name;
}
function *walk(dir,prefix='') {
  for(const name of fs.readdirSync(dir).sort()) {
    const rel=prefix?prefix+'/'+name:name, file=path.join(dir,name),st=fs.lstatSync(file);
    if(['instance.lock','qq-agent.lock'].includes(name)||(!prefix&&['backups','node_modules','.git'].includes(name)))continue;
    // Compatibility links are recreated by the extension loader. Never follow links.
    if(st.isSymbolicLink()) {
      if(/^extensions\/(?:src|node_modules)$/.test(rel)) continue;
      throw backupError('数据含非兼容符号链接，请先检查后再备份。');
    }
    if(st.isDirectory())yield *walk(file,rel);
    else if(st.isFile()){cleanRecordPath(rel);if(st.size>FILE_LIMIT)throw backupError('单个文件超过备份的 64 MiB 限制。');yield [rel,file];}
    else throw backupError('数据含特殊文件，备份已停止。');
  }
}
function targets(config) {
  return mongoIds.flatMap(id=>{
    const c=config.skills?.[id];
    if(!c?.mongoUri && !c?.enabled)return [];
    const uri=c?.mongoUri || 'mongodb://127.0.0.1:27017';
    const db=c?.mongoDb || (id==='kb-growth'?'qq_agent_kb':'qq_agent_memory');
    if(typeof uri!=='string'||!/^mongodb(?:\+srv)?:\/\//.test(uri)||!/^[-a-zA-Z0-9_]{1,63}$/.test(db)||['admin','local','config'].includes(db))throw backupError('自增长数据库配置不适合备份。');
    return [{id,uri,db}];
  });
}
// Refuse a shared database: a profile restore must not erase another bot's records.
export function assertPrivateDatabases(root, profileId, config) {
  const mine=targets(config);
  const endpoint=t=>t.uri.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^/@]+@)?/,'$1').split('?')[0].replace(/\/$/,'')+'|'+t.db;
  if(new Set(mine.map(endpoint)).size!==mine.length)throw backupError('知识库与记忆库必须使用不同数据库。');
  for(const id of fs.readdirSync(path.join(root,'robots'))) {
    if(id===profileId)continue;
    const f=path.join(root,'robots',id,'config.json');if(!fs.existsSync(f))continue;
    for(const other of targets(read(f)))if(mine.some(t=>endpoint(t)===endpoint(other)))throw backupError('检测到多个机器人共享自增长数据库，请先隔离数据库再备份。');
  }
  return mine;
}
async function connect(t){const c=new MongoClient(t.uri,{serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,maxPoolSize:2});try{await c.connect();return c;}catch{await c.close();throw backupError('自增长数据库连接失败，未生成不完整备份。',503);}}
async function *records(root, profileId) {
  const p=paths(root,profileId),config=read(path.join(p.profile,'config.json'));checkIdentity(config,profileId);
  const ts=assertPrivateDatabases(root,profileId,config), clients=[];
  try {
    for(const t of ts)clients.push({t,client:await connect(t)});
    yield {type:'header',format:'qq-agent-profile-backup',version:1,profileId,createdAt:new Date().toISOString(),databases:ts.map(t=>t.id),sharedModelsIncluded:false};
    for(const [name,file] of walk(p.profile)){const b=fs.readFileSync(file);yield {type:'file',name,size:b.length,sha256:hash(b),data:b.toString('base64')};}
    for(const {t,client} of clients) {
      const db=client.db(t.db);
      for(const meta of await db.listCollections().toArray()) {
        if(meta.name.startsWith('system.'))continue;
        if(meta.type!=='collection'||Object.keys(meta.options||{}).length)throw backupError('数据库包含特殊集合，需使用 MongoDB 原生备份工具。');
        const col=db.collection(meta.name), indexes=await col.listIndexes().toArray();
        yield {type:'collection',database:t.id,name:meta.name,indexes:BSON.serialize({indexes}).toString('base64')};
        for await(const doc of col.find({}, {raw:true}))yield {type:'document',database:t.id,collection:meta.name,data:Buffer.from(doc).toString('base64')};
      }
    }
    yield {type:'end'};
  } finally {await Promise.allSettled(clients.map(x=>x.client.close()));}
}
export async function exportProfile(root, profileId, output) {
  const tmp=output+'.partial',dest=fs.createWriteStream(tmp,{mode:0o600,flags:'wx'}),gzip=createGzip();
  const done=new Promise((resolve,reject)=>{dest.once('finish',resolve);dest.once('error',reject);dest.once('close',()=>{if(!dest.writableFinished)reject(new Error('stream closed'));});gzip.once('error',reject);});done.catch(()=>{});
  gzip.pipe(dest);let size=0,count=0;
  try{
    for await(const r of records(root,profileId)) {
      const line=JSON.stringify(r)+'\n';size+=Buffer.byteLength(line);if(size>TOTAL_LIMIT||++count>COUNT_LIMIT)throw backupError('数据超过备份容量限制。');
      if(!gzip.write(line))await once(gzip,'drain');
    }
    gzip.end();await done;
    if(fs.statSync(tmp).size>BACKUP_LIMIT)throw backupError('压缩备份超过 512 MiB 限制。');
    fs.renameSync(tmp,output);return {bytes:fs.statSync(output).size,records:count};
  }catch(e){gzip.destroy();dest.destroy();await done.catch(()=>{});fs.rmSync(tmp,{force:true});throw e;}
}
async function *lines(file) {
  if(fs.statSync(file).size>BACKUP_LIMIT)throw backupError('备份超过 512 MiB。');
  const input=fs.createReadStream(file),gz=createGunzip();input.pipe(gz);input.on('error',e=>gz.destroy(e));
  gz.setEncoding('utf8');let pending='',total=0;
  try{for await(const chunk of gz){total+=Buffer.byteLength(chunk);if(total>TOTAL_LIMIT)throw backupError('解压大小超过限制。');pending+=chunk.toString('utf8');let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(line.length>FILE_LIMIT*1.5)throw backupError('单条记录过大。');yield JSON.parse(line);}if(pending.length>FILE_LIMIT*1.5)throw backupError('单条记录过大。');}if(pending)throw backupError('备份记录不完整。');}finally{input.destroy();gz.destroy();}
}
function decode(value){if(typeof value!=='string'||value.length>FILE_LIMIT*1.5)throw backupError('备份编码损坏或过大。');const b=Buffer.from(value,'base64');if(b.length>FILE_LIMIT||b.toString('base64')!==value)throw backupError('备份编码损坏或过大。');return b;}
// Validate everything and stage files; no code execution and no database access.
export async function inspectArchive(file, profileId, stage) {
  const files=new Set(),collections=new Set(),mongo=[];let header,ended=false,count=0,bytes=0,documents=0,config;
  fs.mkdirSync(stage,{recursive:false,mode:0o700});fs.mkdirSync(path.join(stage,'profile'));fs.mkdirSync(path.join(stage,'mongo'));
  try{
    for await(const r of lines(file)) {
      if(++count>COUNT_LIMIT||ended)throw backupError('备份记录数量或顺序错误。');
      if(!header){if(r.type!=='header'||r.format!=='qq-agent-profile-backup'||r.version!==1||r.profileId!==profileId||!Array.isArray(r.databases)||r.databases.some(x=>!mongoIds.includes(x))||new Set(r.databases).size!==r.databases.length)throw backupError('备份格式或 AppID 不匹配。');header=r;continue;}
      if(r.type==='end'){ended=true;continue;}
      if(r.type==='file') {
        const name=cleanRecordPath(r.name);if(files.has(name))throw backupError('备份存在重复文件。');files.add(name);const b=decode(r.data);
        if(b.length!==r.size||hash(b)!==r.sha256)throw backupError('备份文件校验失败。');bytes+=b.length;
        const dest=path.join(stage,'profile',name);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,b,{mode:0o600,flag:'wx'});
        if(name==='config.json'){config=JSON.parse(b);checkIdentity(config,profileId);}
        if(name==='qqbot/account.json'&&JSON.parse(b).appId!==profileId)throw backupError('QQ 身份记录不匹配。');
      } else if(r.type==='collection') {
        if(!header.databases.includes(r.database)||typeof r.name!=='string'||!r.name||r.name.includes('\0')||r.name.startsWith('system.')||r.name.length>120)throw backupError('集合记录无效。');
        const key=r.database+':'+r.name;if(collections.has(key))throw backupError('重复集合记录。');collections.add(key);
        const indexes=BSON.deserialize(decode(r.indexes)).indexes;if(!Array.isArray(indexes)||indexes.some(i=>!i||typeof i.key!=='object'||!i.name))throw backupError('索引记录无效。');
        const info={database:r.database,name:r.name,indexes:r.indexes,file:String(mongo.length)+'.jsonl'};mongo.push(info);fs.writeFileSync(path.join(stage,'mongo',info.file),'',{mode:0o600});
      } else if(r.type==='document') {
        const col=mongo.find(x=>x.database===r.database&&x.name===r.collection);if(!col)throw backupError('文档缺少集合声明。');BSON.deserialize(decode(r.data));documents++;
        fs.appendFileSync(path.join(stage,'mongo',col.file),r.data+'\n');
      } else throw backupError('未知备份记录。');
    }
    if(!header||!ended||!config)throw backupError('备份不完整。');
    const result={profileId,createdAt:String(header.createdAt||''),files:files.size,bytes,documents,databases:header.databases,sharedModelsIncluded:false,mongo};
    atomic(path.join(stage,'manifest.json'),result);return result;
  }catch(e){fs.rmSync(stage,{recursive:true,force:true});throw e;}
}
function keepConnections(stage, current) {
  const f=path.join(stage,'profile','config.json'),cfg=read(f);
  // A backup cannot inject a remote DB endpoint or overwrite shared models.
  for(const key of ['api','providers','dshProviderKeys','providersSourceYaml','providersImported'])delete cfg[key];
  cfg.skills||={};for(const id of mongoIds)for(const key of ['mongoUri','mongoDb']) {
    if(current.skills?.[id]?.[key]!==undefined){cfg.skills[id]||={};cfg.skills[id][key]=current.skills[id][key];}
    else if(cfg.skills[id])delete cfg.skills[id][key];
  }
  atomic(f,cfg);
  // Do not resume an old Gateway session / re-send formerly waiting replies.
  for(const name of ['session.json'])fs.rmSync(path.join(stage,'profile','qqbot',name),{force:true});
  const sessions=path.join(stage,'profile','sessions');
  if(fs.existsSync(sessions))for(const name of fs.readdirSync(sessions))if(name.endsWith('.json')) {
    const file=path.join(sessions,name),v=read(file);
    if(['running','waiting'].includes(v.status)){v.status='aborted';v.abortReason='restored-from-backup';atomic(file,v);}
  }
}
async function restoreDatabases(stage, ts) {
  const m=read(path.join(stage,'manifest.json'));
  for(const id of m.databases) {
    const t=ts.find(x=>x.id===id);if(!t)throw backupError('当前缺少备份所需的数据库连接。');
    const c=await connect(t);
    try{
      const db=c.db(t.db);
      for(const x of await db.listCollections().toArray())if(!x.name.startsWith('system.'))await db.collection(x.name).drop();
      for(const col of m.mongo.filter(x=>x.database===id)) {
        await db.createCollection(col.name);
        // Streaming line reader avoids loading a whole collection in memory.
        const {createInterface}=await import('node:readline');const stream=fs.createReadStream(path.join(stage,'mongo',col.file));
        try{for await(const line of createInterface({input:stream,crlfDelay:Infinity}))if(line)await db.collection(col.name).insertOne(BSON.deserialize(Buffer.from(line,'base64'),{promoteValues:false}));}finally{stream.destroy();}
        for(const index of BSON.deserialize(Buffer.from(col.indexes,'base64')).indexes)if(index.name!=='_id_'){const {v,ns,...opts}=index;await db.collection(col.name).createIndexes([opts]);}
      }
    }finally{await c.close();}
  }
}
export function backupState(root,id) {
  const p=paths(root,id);if(!fs.existsSync(p.job))return {profileId:id,status:'idle'};
  const j=read(p.job);return {profileId:id,id:j.id,type:j.type,status:j.status,createdAt:j.createdAt,completedAt:j.completedAt,bytes:j.bytes,files:j.files,documents:j.documents,databases:j.databases,error:j.error,rollbackId:j.rollbackId};
}
export function backupDownload(root,id,jobId) {const p=paths(root,id),file=path.join(p.dir,safeId(jobId)+'.qqab.gz');if(!fs.existsSync(file))throw backupError('备份文件不存在。',404);return file;}
export function backupUploadPath(root,id,uploadId){return path.join(paths(root,id).dir,safeId(uploadId)+'.upload');}
export async function previewBackup(root,id,uploadId) {
  const p=paths(root,id),stage=path.join(p.dir,safeId(uploadId)+'.preview');
  const info=await inspectArchive(backupUploadPath(root,id,uploadId),id,stage);
  return {previewId:uploadId,profileId:id,createdAt:info.createdAt,files:info.files,bytes:info.bytes,documents:info.documents,databases:info.databases,sharedModelsIncluded:false};
}
export function queueBackup(root,id,type,previewId) {
  const p=paths(root,id);if(fs.existsSync(p.job)&&['queued','running','restoring','rolling-back'].includes(read(p.job).status))throw backupError('已有备份任务正在进行。',409);
  if(!['export','restore'].includes(type))throw backupError('任务类型无效。');
  if(type==='restore'){safeId(previewId);const m=read(path.join(p.dir,previewId+'.preview','manifest.json'));if(m.profileId!==id)throw backupError('预览已过期。');}
  const job={id:crypto.randomUUID(),profileId:id,type,previewId,status:'queued',createdAt:new Date().toISOString()};atomic(p.job,job);return job.id;
}
// Injection points allow offline crash/failure tests without any live service.
export async function runBackupJob(root,id,{exporter=exportProfile,restoreDb=restoreDatabases,hook=()=>{}}={}) {
  const p=paths(root,id);if(!fs.existsSync(p.job))return;
  const j=read(p.job);if(!['queued','running','restoring','rolling-back'].includes(j.status))return;
  const save=()=>atomic(p.job,j),clean=stage=>fs.rmSync(stage,{recursive:true,force:true});
  const resultFile=path.join(p.dir,j.id+'.qqab.gz'),stage=path.join(p.dir,j.id+'.restore');
  const rollbackStage=path.join(p.dir,j.id+'.rollback'),oldDir=path.join(p.dir,j.id+'.old-profile');
  const currentConfig=()=>read(path.join(fs.existsSync(oldDir)?oldDir:p.profile,'config.json'));
  async function rollback(){j.status='rolling-back';save();clean(rollbackStage);await inspectArchive(backupDownload(root,id,j.rollbackId),id,rollbackStage);await restoreDb(rollbackStage,j.targets);if(fs.existsSync(oldDir)){clean(p.profile);fs.renameSync(oldDir,p.profile);}j.status='failed';j.error='恢复中断，已恢复操作前的数据。';save();}
  try{
    if(['restoring','rolling-back'].includes(j.status)){await rollback();return;}
    j.status='running';save();
    if(j.type==='export') {
      fs.rmSync(resultFile+'.partial',{force:true});const result=await exporter(root,id,resultFile);Object.assign(j,result);
    } else {
      clean(stage);await inspectArchive(backupUploadPath(root,id,j.previewId),id,stage);
      const current=currentConfig(),ts=assertPrivateDatabases(root,id,current),m=read(path.join(stage,'manifest.json'));
      if(JSON.stringify([...m.databases].sort())!==JSON.stringify(ts.map(t=>t.id).sort()))throw backupError('备份与当前数据库范围不一致，请先配置专属数据库。');
      j.rollbackId=crypto.randomUUID();await exporter(root,id,path.join(p.dir,j.rollbackId+'.qqab.gz'));
      keepConnections(stage,current);j.targets=ts;j.status='restoring';save();await hook('before-db');
      await restoreDb(stage,ts);await hook('after-db');
      fs.renameSync(p.profile,oldDir);fs.renameSync(path.join(stage,'profile'),p.profile);await hook('after-files');
      j.files=m.files;j.documents=m.documents;j.databases=m.databases;
    }
    j.status='complete';j.completedAt=new Date().toISOString();delete j.targets;save();
    clean(stage);clean(rollbackStage);clean(oldDir);
    if(j.previewId){fs.rmSync(backupUploadPath(root,id,j.previewId),{force:true});clean(path.join(p.dir,j.previewId+'.preview'));}
  }catch(e){
    if(['restoring','rolling-back'].includes(j.status)){
      try{await rollback();}catch{j.status='rolling-back';j.error='自动回退尚未完成，保留全部备份，停止启动机器人。';save();throw backupError(j.error,503);}
    }else{j.status='failed';j.error=e?.status?e.message:'备份处理失败，未替换运行数据。';save();}
  }
}
