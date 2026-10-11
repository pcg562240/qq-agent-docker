// Run inside the QQ Docker container against real ComfyUI; sender is a test double.
// Nothing is sent to QQ and no real message history or credentials are read.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [skillDir, outputRoot, requestedMode = 'text'] = process.argv.slice(2);
if (!skillDir || !outputRoot) throw Error('usage: node comfy-draw-smoke.mjs SKILL_DIR TEST_DATA_DIR');
const {createSkill} = await import(pathToFileURL(path.join(skillDir,'lib/qwen21-runtime.js')));
const {DEFAULTS,imageInfo} = await import(pathToFileURL(path.join(skillDir,'lib/qwen21-engine.js')));
const settings={...DEFAULTS,notifyStart:false}, tools={}, sent=[];
const skill=createSkill({dataDir:outputRoot,downloadReference:async()=>{throw Error('This smoke test only references its own generated image');}});
skill.setup({config:()=>settings,fetch,registerTool:def=>{tools[def.id]=def;},log:console.log,warn:console.warn});
const ctx={chatKey:'private:comfy-offline-smoke',session:{id:'smoke-'+Date.now(),status:'running',trigger:[],sent:[]},sender:{
  sendImage:async(chat,ref)=>{const b=fs.readFileSync(ref.file);sent.push({chat,file:ref.file,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),...imageInfo(b)});},
  sendTextBatch:async()=>{},
}};
if (!['text','edit'].includes(requestedMode)) throw Error('mode must be text or edit');
const reportFile=path.join(outputRoot,'smoke-report.json');
const reports=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile)):[];
try {
  for(const mode of [requestedMode]) {
    const started=performance.now();
    const args=mode==='text'
      ? {prompt:'一只可爱的蓝色Q版小鲸鱼，戴黄色围巾，在粉蓝色云朵上开心地跳跃，竖版海报构图，二次元插画，干净背景，不要文字。',size:'640x960',seed:20261015}
      : {prompt:'将小鲸鱼的黄色围巾改成红色，保持蓝色鲸鱼的外形、姿势、云朵、背景和构图不变，不要增加文字。',source_job_id:path.basename(reports.find(r=>r.mode==='text').image.file,'.png')};
    ctx.session.id+='-'+mode;
    const result=await tools[mode==='text'?'local_draw':'local_edit'].execute(ctx,args);
    if(result.isError)throw Error(result.content);
    const report={mode,seconds:(performance.now()-started)/1000,prompt:args.prompt,result:result.content,image:sent.at(-1)};
    reports.push(report);console.log(JSON.stringify(report,null,2));
  }
  fs.writeFileSync(reportFile,JSON.stringify(reports,null,2));
  console.log('PASS: real Docker -> ComfyUI -> PNG download -> fake QQ sender; '+requestedMode);
} finally { skill.dispose(); }
