import fs from 'node:fs';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { BACKUP_LIMIT, backupError, backupState, backupDownload, backupUploadPath, previewBackup, queueBackup } from './profile-backup.js';

export function createProfileBackupRoutes({profiles, readBody, restart, isBusy}) {
  let uploading=false;
  const current=()=>{if(!profiles||profiles.active==='setup')throw backupError('备份功能需要 Docker 官方 QQ 通道及已保存的机器人。',409);profiles.assertWritable();return {root:profiles.root,id:profiles.active};};
  return [
    {method:'GET',pattern:'/api/backups',handler:async({res,json})=>{const {root,id}=current();json(res,200,backupState(root,id));}},
    {method:'GET',pattern:/^\/api\/backups\/download\/([a-f0-9-]{36})$/,handler:async({res,match})=>{
      const {root,id}=current(),file=backupDownload(root,id,match[1]);
      res.writeHead(200,{'content-type':'application/gzip','content-disposition':`attachment; filename="qq-agent-${id}-${match[1]}.qqab.gz"`,'content-length':fs.statSync(file).size,'cache-control':'no-store','x-content-type-options':'nosniff'});
      const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
    }},
    {method:'POST',pattern:'/api/backups/upload',handler:async({req,res,json})=>{
      const {root,id}=current();if(uploading)throw backupError('另一个备份文件正在校验。',409);
      if(Number(req.headers['content-length']||0)>BACKUP_LIMIT)throw backupError('备份不能超过 512 MiB。',413);
      uploading=true;const uploadId=crypto.randomUUID(),file=backupUploadPath(root,id,uploadId);let out;
      try{
        out=fs.createWriteStream(file,{flags:'wx',mode:0o600});let bytes=0;
        const done=new Promise((resolve,reject)=>{out.once('finish',resolve);out.once('error',reject);});done.catch(()=>{});
        for await(const chunk of req){bytes+=chunk.length;if(bytes>BACKUP_LIMIT)throw backupError('备份不能超过 512 MiB。',413);if(!out.write(chunk))await once(out,'drain');}
        out.end();await done;if(!bytes)throw backupError('备份文件为空。');
        const preview=await previewBackup(root,id,uploadId);json(res,200,preview);
      }catch(e){out?.destroy();fs.rmSync(file,{force:true});throw backupError(e?.status?e.message:'备份文件损坏或格式不支持。',e?.status||400);}finally{uploading=false;}
    }},
    ...['export','restore'].map(type=>({method:'POST',pattern:'/api/backups/'+type,handler:async({req,res,json})=>{
      const {root,id}=current(),b=await readBody(req,{maxBytes:4096});
      if(b?.confirmAppId!==id)throw backupError('确认的 AppID 不匹配。');
      if(type==='restore'&&b.confirmTrust!==true)throw backupError('请确认备份来源可信，并同意覆盖当前机器人的数据。');
      if(uploading||isBusy())throw backupError('机器人正在处理消息或记忆任务，请稍后重试；不会中断当前回复。',409);
      const jobId=queueBackup(root,id,type,b.previewId);restart(res);
      json(res,202,{ok:true,id:jobId,restarting:true});
    }})),
  ];
}
