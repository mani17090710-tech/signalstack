// Ingestion pipeline: SOURCE -> FETCH (paged) -> NORMALIZE -> DEDUPLICATE -> STORE -> EVENTS.
// Real public sources only: Hugging Face Hub, arXiv, GitHub releases, and lab blog RSS feeds.
// No API keys are required. Optional: HF_TOKEN / GITHUB_TOKEN raise rate limits.
//
// Behaviour worth knowing:
//  * First run of a source = "backfill": it fills the catalog (models / papers) and creates few or no
//    events, and it never sends alert emails, so a fresh deploy doesn't flood anyone.
//  * Later runs stop paging as soon as a whole page is already known, so they stay cheap.
//  * Ingested items are published immediately. Set REQUIRE_REVIEW=true to hold them for admin approval.
const crypto=require('node:crypto');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const nowIso=()=>new Date().toISOString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ts16=s=>String(s||nowIso()).replace('T',' ').slice(0,16);
const unxml=s=>String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;|&#39;/g,"'").replace(/&#(\d+);/g,(m,n)=>String.fromCharCode(+n)).replace(/&amp;/g,'&');
const httpUrl=u=>/^https?:\/\/[^\s"'<>]+$/i.test(String(u||''))?String(u):'';
const isoOf=d=>{const t=new Date(d);return isNaN(t)?nowIso():t.toISOString()};

const UA='signalstack-ingest/1.0 (+https://github.com/mani17090710-tech/signalstack)';
async function fetchRes(url,f,headers={}){
const r=await f(url,{headers:{'User-Agent':UA,...headers},signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error(url.split('?')[0]+' returned HTTP '+r.status);
return{text:await r.text(),link:(r.headers&&r.headers.get&&r.headers.get('link'))||''};
}

// ---- adapters: raw text -> normalized items ----
const TASKS=new Set(['text-generation','text2text-generation','image-text-to-text','any-to-any','text-to-image','text-to-video','image-to-text','image-to-image','image-to-video','automatic-speech-recognition','text-to-speech','text-to-audio','audio-to-audio','feature-extraction','sentence-similarity','fill-mask','question-answering','summarization','translation','text-classification','token-classification','zero-shot-classification','image-classification','object-detection','image-segmentation','depth-estimation','video-text-to-text','visual-question-answering','audio-classification','reinforcement-learning','robotics','time-series-forecasting','text-ranking']);
function parseHuggingFace(text){
const arr=JSON.parse(text);if(!Array.isArray(arr))throw new Error('Unexpected Hugging Face response');
return arr.filter(m=>m&&m.id&&!m.private).map(m=>{const tags=Array.isArray(m.tags)?m.tags.map(String):[];
return{id:'hf:'+m.id,name:String(m.id),createdAt:m.createdAt||'',likes:+m.likes||0,downloads:+m.downloads||0,
pipeline:m.pipeline_tag||tags.find(t=>TASKS.has(t))||'',tags,url:'https://huggingface.co/'+m.id}});
}
function parseGitHub(text){
const arr=JSON.parse(text);if(!Array.isArray(arr))throw new Error('Unexpected GitHub response');
return arr.filter(r=>!r.draft&&!r.prerelease).map(r=>({tag:r.tag_name,name:r.name||r.tag_name,published:r.published_at||r.created_at,url:r.html_url,body:(r.body||'').slice(0,300)}));
}
function parseArxiv(text){
const entries=[...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>m[1]);
const pick=(x,tag)=>unxml((x.match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+tag+'>'))||[,''])[1]).trim();
return entries.map(e=>{const raw=(pick(e,'id').split('/abs/')[1]||'').replace(/v\d+$/,'');if(!raw)return null;
return{id:'arxiv:'+raw,title:pick(e,'title').replace(/\s+/g,' '),summary:pick(e,'summary').replace(/\s+/g,' ').slice(0,600),published:pick(e,'published'),
cat:(e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)||[,''])[1],url:'https://arxiv.org/abs/'+raw,
authors:[...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map(m=>unxml(m[1]).trim()).slice(0,8)}}).filter(Boolean);
}
function parseFeed(text){
const blocks=[...[...text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)],...[...text.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)]].map(m=>m[1]);
const tag=(x,t)=>{const m=x.match(new RegExp('<'+t+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+t+'>'));return m?unxml(m[1]).trim():''};
return blocks.map(b=>{const href=(b.match(/<link[^>]*\shref="([^"]+)"/)||[,''])[1];
const link=httpUrl(href||tag(b,'link')||tag(b,'guid'));const title=tag(b,'title').replace(/\s+/g,' ');
return link&&title?{title,link,date:isoOf(tag(b,'pubDate')||tag(b,'published')||tag(b,'updated')||nowIso())}:null}).filter(Boolean);
}

// ---- sources ----
const REVIEW=()=>process.env.REQUIRE_REVIEW==='true'?0:1;
let lastArxiv=0;
async function arxivWait(opt){const gap=opt.arxivDelayMs??3100,w=lastArxiv+gap-Date.now();if(w>0)await sleep(w);lastArxiv=Date.now()}
const hfHeaders=()=>process.env.HF_TOKEN?{Authorization:'Bearer '+process.env.HF_TOKEN}:{};

function hfUrl(cfg,expand){const u=new URL(cfg.url||'https://huggingface.co/api/models');
u.searchParams.set('sort',cfg.sort||'createdAt');u.searchParams.set('direction','-1');u.searchParams.set('limit',String(Math.min(+cfg.limit||100,1000)));
for(const k of['pipeline_tag','filter'])if(cfg[k])u.searchParams.set(k,cfg[k]);
if(expand)for(const x of['pipeline_tag','downloads','likes','createdAt','tags'])u.searchParams.append('expand[]',x);
return u.toString()}
let hfExpandOk=true; // flips to false if Hugging Face rejects expand[] (we then use the default fields)
async function hfFetch(url,f){try{return await fetchRes(url,f,hfHeaders())}catch(e){
if(hfExpandOk&&/HTTP 400/.test(e.message)&&/expand/.test(url)){hfExpandOk=false;return fetchRes(url.replace(/[?&]expand%5B%5D=[^&]*/g,'').replace('&&','&'),f,hfHeaders())}throw e}}

async function runHF(db,src,cfg,f,first){
const known=db.prepare('select 1 from models where id=?'),pages=first?(cfg.backfillPages||10):(cfg.pages||5);
const ins=db.prepare(`insert into models(id,name,org_id,arch,params,ctx,open,price,rel,ver,uses,verified,likes,downloads,url) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
on conflict(id) do update set likes=excluded.likes,downloads=excluded.downloads,uses=excluded.uses`);
const evHas=db.prepare("select 1 from events where source=? and cat='Trending'"),insEv=db.prepare('insert into events(sev,ts,org_id,model_id,cat,summary,source) values(?,?,?,?,?,?,?)');
let prev=new Set();if(!first&&cfg.events){try{prev=new Set(JSON.parse(src.last_seen))}catch(e){}}
const evCap=first?(cfg.firstEvents||10):(cfg.maxEvents||25),ids=[];
let next=hfUrl(cfg,hfExpandOk),firstText='',total=0,created=0,evCount=0;const inserted=[];
for(let i=0;i<pages&&next;i++){
const r=await hfFetch(next,f);if(i===0)firstText=r.text;
const items=parseHuggingFace(r.text);total+=items.length;let fresh=0;
db.exec('begin');try{
for(const m of items){const isNew=!known.get(m.id);if(isNew){fresh++;created++}
const uses=[m.pipeline,...m.tags.filter(t=>t!==m.pipeline&&!/^(region:|endpoints_compatible|autotrain_compatible|text-generation-inference)/.test(t))].filter(Boolean).map(t=>t.replace(/,/g,' ')).slice(0,8).join(',');
ins.run(m.id,m.name,'hf','Unknown','Unknown','Unknown',1,'Open weights',(m.createdAt||nowIso()).slice(0,10),'',uses,REVIEW(),m.likes,m.downloads,m.url);
if(cfg.events)ids.push(m.id);
if(cfg.events&&(first||!prev.has(m.id))&&evCount<evCap&&!evHas.get(m.url)){
const sev=m.likes>=100?'Important':'Normal';const e=insEv.run(sev,ts16(m.createdAt),'hf',m.id,'Trending',`Trending on Hugging Face: ${m.name} (${m.likes} likes, ${m.downloads} downloads).`,m.url);
evCount++;if(!first)inserted.push({id:e.lastInsertRowid,sev,cat:'Trending',org_id:'hf'})}}
db.exec('commit')}catch(e){db.exec('rollback');throw e}
if(!first&&cfg.sort!=='likes'&&cfg.sort!=='trendingScore'&&items.length&&!fresh)break; // whole page already known
const nx=r.link.match(/<([^>]+)>;\s*rel="next"/);let nu=null;try{nu=nx&&new URL(nx[1]);}catch(e){}
next=nu&&nu.hostname==='huggingface.co'?nu.toString():null}
return{firstText,items:total,created,inserted,seen:cfg.events&&ids.length?JSON.stringify(ids):undefined}}

async function runArxiv(db,src,cfg,f,first,opt){
const q=cfg.query||(cfg.category?'cat:'+cfg.category:'cat:cs.CL'),per=Math.min(+cfg.limit||100,200),pages=first?(cfg.backfillPages||3):(cfg.pages||1);
const known=db.prepare('select 1 from papers where id=?'),ins=db.prepare('insert or ignore into papers(id,title,org_id,date,model_ids,arch,tldr,limits,url,verified,authors) values(?,?,?,?,?,?,?,?,?,?,?)');
const insEv=db.prepare('insert into events(sev,ts,org_id,model_id,cat,summary,source) values(?,?,?,?,?,?,?)');
let firstText='',total=0,created=0;const fresh=[];
for(let i=0;i<pages;i++){
await arxivWait(opt);
const url=`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&start=${i*per}&max_results=${per}`;
const r=await fetchRes(url,f);if(i===0)firstText=r.text;
const items=parseArxiv(r.text);total+=items.length;let n=0;
db.exec('begin');try{for(const p of items){if(known.get(p.id))continue;n++;created++;fresh.push(p);
ins.run(p.id,p.title,'arxiv',(p.published||nowIso()).slice(0,10),'',p.cat||'Not classified',p.summary,'',p.url,REVIEW(),p.authors.join(', '))}db.exec('commit')}catch(e){db.exec('rollback');throw e}
if(!items.length||(!first&&!n))break}
const inserted=[],max=cfg.maxEvents||0;
fresh.sort((a,b)=>a.published<b.published?1:-1).slice(0,max).forEach(p=>{
const e=insEv.run('Research',ts16(p.published),'arxiv',null,'Research','New paper: '+p.title,p.url);
if(!first)inserted.push({id:e.lastInsertRowid,sev:'Research',cat:'Research',org_id:'arxiv'})});
return{firstText,items:total,created,inserted}}

async function runGitHub(db,src,cfg,f,first){
const headers=process.env.GITHUB_TOKEN?{Authorization:'Bearer '+process.env.GITHUB_TOKEN}:{};
const r=await fetchRes(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases?per_page=15`,f,headers);
const items=parseGitHub(r.text),has=db.prepare("select 1 from events where source=? and cat='Open Source'"),
insEv=db.prepare('insert into events(sev,ts,org_id,model_id,cat,summary,source) values(?,?,?,?,?,?,?)'),inserted=[];let created=0;
const since=first?'':src.last_seen||'';
const list=items.filter(x=>httpUrl(x.url)&&x.published&&isoOf(x.published)>=since&&!has.get(x.url)).sort((a,b)=>a.published<b.published?-1:1);
for(const x of first?list.slice(-(cfg.backfillEvents||3)):list){
const e=insEv.run('Major',ts16(x.published),'gh',null,'Open Source',`${cfg.owner}/${cfg.repo} released ${x.name}.`,x.url);created++;
if(!first)inserted.push({id:e.lastInsertRowid,sev:'Major',cat:'Open Source',org_id:'gh'})}
return{firstText:r.text,items:items.length,created,inserted,seen:items.reduce((m,x)=>x.published&&isoOf(x.published)>m?isoOf(x.published):m,'')||undefined}}

async function runFeed(db,src,cfg,f,first){
const org=cfg.org||{id:'ext',name:'External / Unverified'};
db.prepare('insert or ignore into orgs(id,name) values(?,?)').run(org.id,org.name);
const r=await fetchRes(cfg.url,f),items=parseFeed(r.text),has=db.prepare('select 1 from events where source=?'),
insEv=db.prepare('insert into events(sev,ts,org_id,model_id,cat,summary,source) values(?,?,?,?,?,?,?)'),inserted=[];let created=0;
const since=first?'':src.last_seen||'';
const list=items.filter(x=>x.date>=since&&!has.get(x.link)).sort((a,b)=>a.date<b.date?-1:1);
for(const x of first?list.slice(-(cfg.backfillEvents||10)):list.slice(-20)){
const e=insEv.run('Important',ts16(x.date),org.id,null,'Announcement',`${org.name}: ${x.title}`,x.link);created++;
if(!first)inserted.push({id:e.lastInsertRowid,sev:'Important',cat:'Announcement',org_id:org.id})}
return{firstText:r.text,items:items.length,created,inserted,seen:items.reduce((m,x)=>x.date>m?x.date:m,'')||undefined}}

async function runSource(db,src,f,opt={}){
const cfg=JSON.parse(src.config||'{}'),kind=src.kind,first=!src.last_seen;
const fn={huggingface:runHF,github:runGitHub,arxiv:runArxiv,feed:runFeed}[kind];
if(!fn)throw new Error('Unknown source kind: '+kind);
const r=await fn(db,src,cfg,f,first,opt);
const hash=sha(r.firstText||'');
if(!first&&hash===src.last_hash&&!r.created)return{status:'unchanged',items:0,created:0,inserted:[]};
db.prepare('update sources_config set last_hash=?,last_seen=? where id=?').run(hash,r.seen||(r.items?nowIso():src.last_seen),src.id);
return{status:'ok',items:r.items,created:r.created,inserted:r.inserted,first}}

function prune(db){
const days=Math.max(30,+process.env.RETENTION_DAYS||365);
try{db.exec(`delete from models where org_id='hf' and likes<3 and downloads<50 and rel<date('now','-45 day')
and id not in (select model_id from results where model_id is not null) and id not in (select model_id from events where model_id is not null) and id not in (select model_id from watchlist);
delete from papers where date<date('now','-${days} day');
delete from ingestion_log where ts<datetime('now','-14 day');delete from sessions where expires<${Date.now()};delete from password_resets where expires<${Date.now()}`)}catch(e){console.error('Prune failed:',e.message)}}

let running=false;
async function runAll(db,f=fetch,opt={}){
if(running)return[];running=true;
try{
const sources=db.prepare('select * from sources_config where enabled=1').all(),all=[];
for(const src of sources){
const ts=nowIso();
try{
const r=await runSource(db,src,f,opt);
db.prepare('update sources_config set last_run=?,last_status=?,last_error=null where id=?').run(ts,r.status,src.id);
const msg=r.status==='unchanged'?'No new content since last check.':`${r.first?'First run (backfill): ':''}Read ${r.items} item(s), ${r.created} new.`;
db.prepare('insert into ingestion_log(source_id,ts,status,message,items) values(?,?,?,?,?)').run(src.id,ts,r.status,msg,r.items);
all.push(...r.inserted);
}catch(e){
db.prepare('update sources_config set last_run=?,last_status=?,last_error=? where id=?').run(ts,'error',e.message,src.id);
db.prepare('insert into ingestion_log(source_id,ts,status,message,items) values(?,?,?,?,0)').run(src.id,ts,'error',e.message);
}}
prune(db);return all;
}finally{running=false}}

module.exports={runAll,runSource,parseHuggingFace,parseGitHub,parseArxiv,parseFeed};
