// Reproducible ComfyUI-only benchmark. Does not send messages to QQ.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const opts = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>v.startsWith('--')?[...a,[v.slice(2),all[i+1]]]:a,[]));
const base=opts.base || 'http://host.docker.internal:9000';
const resolution=Number(opts.resolution || 768), seed=Number(opts.seed || 20261011);
const name=opts.name || `test-${Date.now()}`;
const prompt=opts.prompt || 'A cheerful chubby blue whale mascot wearing a bright yellow scarf, cute chibi illustration, round body, tiny fins, expressive sparkling eyes, clean sky-blue background, centered square avatar, soft studio lighting, no text, no watermark.';
const dir=path.resolve('artifacts/qwen21-turbo');fs.mkdirSync(dir,{recursive:true});
async function json(route,body){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;}
const queue=await json('/queue');if(queue.queue_running?.length || queue.queue_pending?.length)throw Error('ComfyUI is busy; no benchmark submitted');
const n=(class_type,inputs)=>({class_type,inputs});
const graph={
  '1':n('UNETLoader',{unet_name:'qwen_image_2.1_turbo_bf16.safetensors',weight_dtype:'default'}),
  '2':n('CLIPLoader',{clip_name:opts.clip || 'qwen3vl_8b_int8_convrot.safetensors',type:'qwen_image',device:opts['clip-device'] || 'default'}),
  '3':n('VAELoader',{vae_name:'qwen_image_2.1_vae_bf16.safetensors'}),
  '4':n('TextEncodeQwenImage21',{clip:['2',0],prompt,negative_prompt:'',vae:['3',0],resolution}),
  '5':n('QwenImage21Cache',{model:['1',0],device:'auto',dtype:'default'}),
  '6':n('BasicGuider',{model:['5',0],conditioning:['4',0]}),
  '7':n('KSamplerSelect',{sampler_name:'euler'}),
  '8':n('ManualSigmas',{sigmas:'1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0'}),
  '9':n('RandomNoise',{noise_seed:seed}),
  '10':n('SamplerCustomAdvanced',{noise:['9',0],guider:['6',0],sampler:['7',0],sigmas:['8',0],latent_image:['4',2]}),
  '11':n('VAEDecode',{samples:['10',0],vae:['3',0]}),
  '12':n('SaveImage',{images:['11',0],filename_prefix:`qqagent_benchmark/${name}`}),
};
if(opts.input){
  const form=new FormData();form.append('image',new Blob([fs.readFileSync(opts.input)],{type:'image/png'}),`qqagent_bench_${randomUUID()}.png`);
  form.append('type','input');form.append('subfolder','qqagent_benchmark');
  const response=await fetch(base+'/upload/image',{method:'POST',body:form});const uploaded=await response.json();if(!response.ok)throw Error(JSON.stringify(uploaded));
  graph['13']=n('LoadImage',{image:[uploaded.subfolder,uploaded.name].filter(Boolean).join('/')});
  graph['4'].inputs['images.image_1']=['13',0];
}
fs.writeFileSync(path.join(dir,name+'.workflow-api.json'),JSON.stringify(graph,null,2));
const client=randomUUID(), events=[], started=performance.now();
const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws?clientId='+client);
await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
ws.on('message',(data,binary)=>{if(binary)return;try{const event=JSON.parse(data);if(['executing','execution_start','execution_success','execution_error','execution_cached','progress'].includes(event.type)){events.push({seconds:(performance.now()-started)/1000,...event});if(event.type==='executing'&&event.data.node)console.log(name,'node',event.data.node,graph[event.data.node]?.class_type);}}catch{}});
let id;
try{
  const submitted=await json('/prompt',{prompt:graph,client_id:client});id=submitted.prompt_id;
  console.log(JSON.stringify({name,promptId:id,resolution,mode:opts.input?'edit':'text',prompt}));
  const deadline=Date.now()+15*60_000;
  let history;
  while(Date.now()<deadline){history=(await json('/history/'+id))[id];if(history)break;await new Promise(r=>setTimeout(r,1000));}
  if(!history)throw Error('Timed out; prompt '+id+' may still be running; no duplicate submitted');
  const generationSeconds=(performance.now()-started)/1000;
  fs.writeFileSync(path.join(dir,name+'.history.json'),JSON.stringify(history,null,2));
  if(history.status?.status_str==='error')throw Error(JSON.stringify(history.status));
  const files=[];
  for(const im of history.outputs?.['12']?.images||[]){
    const r=await fetch(base+'/view?'+new URLSearchParams(im));if(!r.ok)throw Error('image download '+r.status);
    const file=path.join(dir,path.basename(im.filename));fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));files.push(file);
  }
  if(!files.length)throw Error('No output images');
  const report={name,model:graph['1'].inputs.unet_name,clip:graph['2'].inputs.clip_name,prompt,seed,resolution,steps:8,mode:opts.input?'edit':'text',input:opts.input||null,promptId:id,generationSeconds,totalSeconds:(performance.now()-started)/1000,files,events};
  fs.writeFileSync(path.join(dir,name+'.result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,events:undefined},null,2));
}finally{ws.close();}
