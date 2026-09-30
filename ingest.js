// Ingestion pipeline: SOURCE -> FETCH -> NORMALIZE -> DEDUPLICATE -> CHANGE DETECTION -> CLASSIFY -> DATABASE.
// Uses real public APIs (Hugging Face, GitHub Releases, arXiv). No API keys required for the defaults below,
// though GitHub's unauthenticated rate limit is low (60 req/hr) — set GITHUB_TOKEN to raise it.
const crypto=require('node:crypto');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const nowIso=()=>new Date().toISOString();

async function fetchText(url,f,headers={}){
const r=await f(url,{headers:{'User-Agent':'signalstack-ingest/1.0',...headers},signal:AbortSignal.timeout(15000)});
if(!r.ok)throw new Error(url+' returned HTTP '+r.status);
return r.text();
}

// ---- adapters: each returns {items:[...normalized]} from raw text ----
function parseHuggingFace(text){
const arr=JSON.parse(text);
return arr.map(m=>({id:'hf:'+m.id,name:m.id,createdAt:m.createdAt||'',likes:m.likes||0,downloads:m.downloads||0,url:'https://huggingface.co/'+m.id}));
}
function parseGitHub(text){
const arr=JSON.parse(text);
return arr.map(r=>({tag:r.tag_name,name:r.name||r.tag_name,published:r.published_at,url:r.html_url,body:(r.body||'').slice(0,300)}));
}
function parseArxiv(text){
const entries=[...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>m[1]);
const pick=(x,tag)=>(x.match(new RegExp('<'+tag+'>([\\s\\S]*?)<\\/'+tag+'>'))||[,''])[1].trim();
return entries.map(e=>({id:'arxiv:'+pick(e,'id').split('/abs/')[1],title:pick(e,'title').replace(/\s+/g,' '),summary:pick(e,'summary').replace(/\s+/g,' ').slice(0,400),published:pick(e,'published'),url:pick(e,'id')}));
}

async function runSource(db,src,f){
const cfg=JSON.parse(src.config);
let url,parser,kind=src.kind;
if(kind==='huggingface')url=cfg.url;
else if(kind==='github')url=`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases?per_page=10`;
else if(kind==='arxiv')url=`http://export.arxiv.org/api/query?search_query=${encodeURIComponent(cfg.query)}&sortBy=submittedDate&sortOrder=descending&max_results=${cfg.max||10}`;
else throw new Error('Unknown source kind: '+kind);

const headers=kind==='github'&&process.env.GITHUB_TOKEN?{Authorization:'Bearer '+process.env.GITHUB_TOKEN}:{};
const text=await fetchText(url,f,headers);
const hash=sha(text);
if(hash===src.last_hash)return{status:'unchanged',items:0,inserted:[]};

const items=kind==='huggingface'?parseHuggingFace(text):kind==='github'?parseGitHub(text):parseArxiv(text);
const inserted=[];
const insEvent=db.prepare('insert into events(sev,ts,org_id,model_id,cat,summary,source) values(?,?,?,?,?,?,?)');

if(kind==='huggingface'){
const lastSeen=src.last_seen||'';
const fresh=items.filter(m=>m.createdAt>lastSeen).sort((a,b)=>a.createdAt<b.createdAt?-1:1);
for(const m of fresh){
db.prepare('insert or ignore into models(id,name,org_id,arch,params,ctx,open,price,rel,ver,uses,verified) values(?,?,?,?,?,?,?,?,?,?,?,0)')
.run(m.id,m.name,'ext','Not disclosed','Not disclosed','Not disclosed',1,'Not disclosed',m.createdAt.slice(0,10)||nowIso().slice(0,10),'Not disclosed','');
const sev=m.likes>=50?'Major':'Normal';
const r=insEvent.run(sev,nowIso().replace('T',' ').slice(0,16),'ext',m.id,'Model Release',`New model on Hugging Face: ${m.name} (${m.likes} likes).`,m.url);
inserted.push({id:r.lastInsertRowid,sev,cat:'Model Release',org_id:'ext'});
}
if(fresh.length)db.prepare('update sources_config set last_seen=? where id=?').run(fresh[fresh.length-1].createdAt,src.id);
}
if(kind==='github'){
const lastSeen=src.last_seen||'';
const fresh=items.filter(r=>r.published>lastSeen).sort((a,b)=>a.published<b.published?-1:1);
for(const r of fresh){
const ev=insEvent.run('Major',nowIso().replace('T',' ').slice(0,16),'ext',null,'Open Source',`${cfg.owner}/${cfg.repo} released ${r.name}.`,r.url);
inserted.push({id:ev.lastInsertRowid,sev:'Major',cat:'Open Source',org_id:'ext'});
}
if(fresh.length)db.prepare('update sources_config set last_seen=? where id=?').run(fresh[fresh.length-1].published,src.id);
}
if(kind==='arxiv'){
const lastSeen=src.last_seen||'';
const fresh=items.filter(p=>p.published>lastSeen).sort((a,b)=>a.published<b.published?-1:1);
for(const p of fresh){
db.prepare('insert or ignore into papers(id,title,org_id,date,model_ids,arch,tldr,limits,url,verified) values(?,?,?,?,?,?,?,?,?,0)')
.run(p.id,p.title,'ext',p.published.slice(0,10),'','Not classified',p.summary,'Not yet reviewed — auto-ingested.',p.url);
const ev=insEvent.run('Research',nowIso().replace('T',' ').slice(0,16),'ext',null,'Research',`New paper detected: ${p.title}`,p.url);
inserted.push({id:ev.lastInsertRowid,sev:'Research',cat:'Research',org_id:'ext'});
}
if(fresh.length)db.prepare('update sources_config set last_seen=? where id=?').run(fresh[fresh.length-1].published,src.id);
}

db.prepare('update sources_config set last_hash=? where id=?').run(hash,src.id);
return{status:'ok',items:items.length,inserted};
}

async function runAll(db,f=fetch){
const sources=db.prepare('select * from sources_config where enabled=1').all();
const allInserted=[];
for(const src of sources){
const ts=nowIso();
try{
const r=await runSource(db,src,f);
db.prepare('update sources_config set last_run=?,last_status=?,last_error=null where id=?').run(ts,r.status,src.id);
db.prepare('insert into ingestion_log(source_id,ts,status,message,items) values(?,?,?,?,?)').run(src.id,ts,r.status,r.status==='unchanged'?'No new content since last check.':`Found ${r.items} item(s), ${r.inserted.length} new.`,r.items);
allInserted.push(...r.inserted);
}catch(e){
db.prepare('update sources_config set last_run=?,last_status=?,last_error=? where id=?').run(ts,'error',e.message,src.id);
db.prepare('insert into ingestion_log(source_id,ts,status,message,items) values(?,?,?,?,0)').run(src.id,ts,'error',e.message);
}
}
return allInserted;
}

module.exports={runAll,runSource,parseHuggingFace,parseGitHub,parseArxiv};
