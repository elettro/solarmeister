import { readFile } from 'node:fs/promises';
const token=process.env.GITHUB_TOKEN;
const repo=process.env.GITHUB_REPOSITORY;
const runId=process.env.GITHUB_RUN_ID;
const branch=process.env.GITHUB_REF_NAME||'main';
const path=process.env.SYNC_REPORT_PATH||'sync-report.json';
if(!token||!repo||!runId){console.error('Missing GitHub publication context');process.exit(2)}
let original;
try{original=JSON.parse(await readFile(path,'utf8'))}catch(e){console.error('Structured sync report is missing; nothing to publish:',e.message);process.exit(0)}
const cleanText=(v,n=400)=>String(v??'').slice(0,n);
const project=x=>({product:cleanText(x.product,180),variant:cleanText(x.variant,140),check:cleanText(x.check,40),status:cleanText(x.status,70),supplier:cleanText(x.supplier,35),sourceHandle:cleanText(x.sourceHandle,150),sourcePrice:Number.isFinite(Number(x.sourcePrice))?Number(x.sourcePrice):null,currentPrice:Number.isFinite(Number(x.currentPrice))?Number(x.currentPrice):null,targetPrice:Number.isFinite(Number(x.targetPrice))?Number(x.targetPrice):null,variantsChanged:Number(x.variantsChanged)||0,action:cleanText(x.action,50),error:cleanText(x.error,240)});
const report={schemaVersion:1,runId:Number(runId),generatedAt:original.generatedAt,source:original.source,pricing:original.pricing,summary:original.summary,detailsCount:original.details?.length||0,changes:(original.changes||[]).map(project),questionable:(original.questionable||[]).map(project)};
const headers={authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','content-type':'application/json'};
const endpoint=p=>'https://api.github.com/repos/'+repo+'/contents/'+p;
async function get(p){let r=await fetch(endpoint(p)+'?ref='+encodeURIComponent(branch),{headers});if(r.status===404)return null;if(!r.ok)throw Error('GET '+p+': '+r.status+' '+(await r.text()).slice(0,300));return r.json()}
async function put(p,data,message){let existing=await get(p);let json=JSON.stringify(data,null,2)+'\n';let payload={message,content:Buffer.from(json).toString('base64'),branch};if(existing?.sha)payload.sha=existing.sha;let r=await fetch(endpoint(p),{method:'PUT',headers,body:JSON.stringify(payload)});if(!r.ok)throw Error('PUT '+p+': '+r.status+' '+(await r.text()).slice(0,500));return r.json()}
const location='dash/sync/data/reports/'+runId+'.json';
await put(location,report,'Archive BalkonStrom supplier sync report '+runId);
const indexPath='dash/sync/data/index.json';
let existing=await get(indexPath),previous=[];
if(existing?.content){try{previous=JSON.parse(Buffer.from(existing.content.replace(/\n/g,''),'base64').toString('utf8')).runs||[]}catch(e){console.warn('Could not decode previous index:',e.message)}}
const runs=[{runId:Number(runId),generatedAt:report.generatedAt,file:'data/reports/'+runId+'.json'},...previous.filter(x=>String(x.runId)!==String(runId))].sort((a,b)=>new Date(b.generatedAt)-new Date(a.generatedAt)).slice(0,120);
await put(indexPath,{schemaVersion:1,updatedAt:new Date().toISOString(),runs},'Update BalkonStrom sync report index '+runId);
console.log('Published sanitized report to '+location+'; '+runs.length+' runs indexed.');
