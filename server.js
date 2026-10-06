// Signalstack backend. Run: node server.js  (Node 22.5+, no npm install needed)
const {DatabaseSync}=require('node:sqlite'),http=require('http'),fs=require('fs'),path=require('path'),cr=require('crypto');
const {sendMail}=require('./mailer.js'),{runAll}=require('./ingest.js');
const PORT=process.env.PORT||3000,db=new DatabaseSync(process.env.DB||'signalstack.db');
// Version/date of the Terms + Privacy Policy. Bump this when you change them materially; it is shown on both pages and recorded at signup.
const LEGAL_VERSION=process.env.LEGAL_VERSION||'2026-10-06';
db.exec(`pragma foreign_keys=on;
create table if not exists users(id integer primary key,email text unique not null,name text,pw text not null,role text default 'user',created text default current_timestamp);
create table if not exists sessions(token text primary key,user_id integer not null references users(id) on delete cascade,expires integer);
create table if not exists password_resets(email text primary key,code text,expires integer);
create table if not exists orgs(id text primary key,name text);
create table if not exists models(id text primary key,name text,org_id text references orgs(id),arch text,params text,ctx text,open integer,price text,rel text,ver text,uses text,verified integer default 1);
create table if not exists benchmarks(id text primary key,name text,ver text,cat text,descr text,meth text);
create table if not exists results(id integer primary key,model_id text references models(id),bench_id text references benchmarks(id),score real,badge text,evaluator text,date text,source text);
create table if not exists papers(id text primary key,title text,org_id text references orgs(id),date text,model_ids text,arch text,tldr text,limits text,url text,verified integer default 1);
create table if not exists events(id integer primary key,sev text,ts text,org_id text references orgs(id),model_id text references models(id),cat text,summary text,source text);
create table if not exists doc_versions(version text primary key,date text,lines text);
create table if not exists alerts(id integer primary key,user_id integer references users(id) on delete cascade,org_id text,cat text,minsev text,channel text default 'app');
create table if not exists watchlist(user_id integer references users(id) on delete cascade,model_id text references models(id),primary key(user_id,model_id));
create table if not exists sources_config(id text primary key,kind text,label text,config text,enabled integer default 1,last_seen text,last_hash text,last_run text,last_status text,last_error text);
create table if not exists ingestion_log(id integer primary key,source_id text references sources_config(id),ts text,status text,message text,items integer);
create table if not exists notification_log(id integer primary key,user_id integer references users(id) on delete cascade,channel text,status text,error text,ts text default current_timestamp);
create index if not exists ix_res on results(model_id,bench_id);create index if not exists ix_ev on events(ts);create index if not exists ix_ses on sessions(user_id);create index if not exists ix_log on ingestion_log(ts);`);
// Record when each user accepted the Terms/Privacy Policy (added in a later version, so migrate older databases).
for(const c of ['accepted_at text','accepted_version text']){try{db.exec('alter table users add column '+c)}catch(e){if(!/duplicate column/i.test(e.message))throw e}}
 
// ---- DEMO seed data (fictional). Replace with ingestion jobs for live data. ----
if(process.env.SEED_DEMO==='true'&&!db.prepare('select 1 from orgs').get()){
const ins=(t,rows)=>rows.forEach(r=>db.prepare(`insert into ${t} values(${r.map(()=>'?').join(',')})`).run(...r));
ins('orgs',[['na','Northwind AI'],['al','Aster Labs'],['ko','Kestrel Open']]);
ins('models',[
['meridian-3','Meridian 3','na','Mixture-of-Experts','Not disclosed','400K',0,'$3 / $12 per 1M tokens','2026-08-14','3.1','coding,reasoning,agents',1],
['meridian-mini','Meridian Mini','na','Dense Transformer','Not disclosed','128K',0,'$0.20 / $0.80 per 1M tokens','2026-06-02','1.2','support,extraction',1],
['aster-r2','Aster R2','al','Dense Transformer','Not disclosed','200K',0,'$2 / $10 per 1M tokens','2026-09-10','2.0','reasoning,research,vision',1],
['kestrel-70b','Kestrel 70B','ko','Dense Transformer','70B','128K',1,'Self-hosted','2026-07-21','1.1','coding,rag',1],
['kestrel-moe','Kestrel MoE 230B','ko','Mixture-of-Experts','230B (22B active)','256K',1,'Self-hosted','2026-09-22','0.9','coding,agents,rag',1],
['aster-long','Aster Long','al','Hybrid SSM','Not disclosed','2M',0,'Not disclosed','2026-09-01','0.4','rag,research',1]]);
ins('benchmarks',[['codeeval-v3','CodeEval','v3','Coding','Repository-level bug fixes with hidden tests.','pass@1, fixed scaffold'],['codeeval-v2','CodeEval','v2','Coding','Single-file synthesis (superseded).','pass@1, zero-shot'],['reasonbench','ReasonBench','v1','Reasoning','Multi-step logic puzzles.','accuracy, 5-shot'],['mathset','MathSet','v1','Mathematics','Competition problems.','accuracy, CoT']]);
ins('results',[[null,'meridian-3','codeeval-v3',71.2,'Independent','Demo Eval Group','2026-09-02','demo://evalgroup/run-118'],[null,'meridian-3','codeeval-v3',69.8,'Self-reported','Northwind AI','2026-08-14','demo://northwind/report'],[null,'meridian-3','reasonbench',84.1,'Self-reported','Northwind AI','2026-08-14','demo://northwind/report'],[null,'meridian-3','mathset',78.0,'Self-reported','Northwind AI','2026-08-14','demo://northwind/report'],[null,'meridian-mini','codeeval-v2',58.3,'Official','Northwind AI','2026-06-02','demo://northwind/mini'],[null,'aster-r2','reasonbench',87.4,'Independent','Demo Eval Group','2026-09-15','demo://evalgroup/run-131'],[null,'aster-r2','reasonbench',86.9,'Reproduced','Community repro','2026-09-18','demo://repro/aster-r2'],[null,'aster-r2','mathset',82.5,'Self-reported','Aster Labs','2026-09-10','demo://aster/report'],[null,'kestrel-70b','codeeval-v2',61.0,'Reproduced','Community repro','2026-07-30','demo://repro/k70'],[null,'kestrel-moe','codeeval-v3',66.4,'Self-reported','Kestrel Open','2026-09-22','demo://kestrel/notes'],[null,'kestrel-moe','mathset',74.2,'Estimated','Kestrel Open','2026-09-22','demo://kestrel/notes'],[null,'aster-long','reasonbench',71.5,'Self-reported','Aster Labs','2026-09-01','demo://aster/long']]);
ins('papers',[['p1','Meridian 3 Technical Report (demo)','na','2026-08-14','meridian-3,meridian-mini','Mixture-of-Experts','Sparse expert routing with agentic coding gains.','Training data undisclosed; results self-reported.','demo://northwind/report',1],['p2','Hybrid State-Space Layers for 2M Context (demo)','al','2026-09-01','aster-long','Hybrid SSM','Mixes state-space and attention layers for cheap long context.','Retrieval drops on some needle tasks.','demo://arxiv/p2',1],['p3','Open Expert Routing at 230B (demo)','ko','2026-09-22','kestrel-moe','Mixture-of-Experts','Open-weight MoE with 22B active parameters.','Early v0.9 checkpoint.','demo://arxiv/p3',1]]);
ins('events',[[null,'Critical','2026-09-28 09:12','ko','kestrel-moe','Model Release','Kestrel MoE 230B open weights published.','demo://kestrel/release'],[null,'Major','2026-09-28 08:40','al','aster-r2','Documentation','API docs changed: new reasoning_effort parameter.','demo://aster/docs'],[null,'Important','2026-09-27 21:05','na','meridian-3','Pricing','Output token price lowered.','demo://northwind/pricing'],[null,'Research','2026-09-27 14:30','al','aster-long','Research','Hybrid SSM paper detected.','demo://arxiv/p2'],[null,'Major','2026-09-26 19:00','na','meridian-3','Benchmark','CodeEval v3 independent run added (71.2).','demo://evalgroup/run-118'],[null,'Normal','2026-09-25 10:00','ko','kestrel-70b','Open Source','Quantized builds released.','demo://hf/kestrel']]);
ins('doc_versions',[['v4.1','2026-09-10','temperature: 0-2;;timeout default: 30s;;legacy_stream: supported'],['v4.2','2026-09-20','temperature: 0-2;;timeout default: 60s;;legacy_stream: supported'],['v4.3','2026-09-26','temperature: 0-2;;timeout default: 120s;;reasoning_effort: low|medium|high']]);
}
if(!db.prepare('select 1 from orgs where id=?').get('ext'))db.prepare("insert into orgs values('ext','External / Unverified')").run();
if(process.env.SEED_DEMO!=='true'){try{db.exec(`delete from results where source like 'demo://%';
delete from events where source like 'demo://%';
delete from papers where url like 'demo://%';
delete from models where id in ('meridian-3','meridian-mini','aster-r2','kestrel-70b','kestrel-moe','aster-long');
delete from benchmarks where id in ('codeeval-v3','codeeval-v2','reasonbench','mathset');
delete from doc_versions where version in ('v4.1','v4.2','v4.3');
delete from orgs where id in ('na','al','ko');`)}catch(e){console.error('Demo cleanup failed:',e.message)}}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           
 if(!db.prepare('select 1 from sources_config').get()){
const si=db.prepare('insert into sources_config(id,kind,label,config,enabled) values(?,?,?,?,1)');
si.run('hf-new-models','huggingface','Hugging Face — newest models',JSON.stringify({url:'https://huggingface.co/api/models?sort=createdAt&direction=-1&limit=20'}));
si.run('gh-transformers','github','GitHub — huggingface/transformers releases',JSON.stringify({owner:'huggingface',repo:'transformers'}));
si.run('arxiv-llm','arxiv','arXiv — recent language model papers',JSON.stringify({query:'cat:cs.CL AND abs:language model',max:10}));
}
 
// ---- helpers ----
const hash=(pw,salt=cr.randomBytes(16).toString('hex'))=>salt+':'+cr.scryptSync(pw,salt,64).toString('hex');
const check=(pw,h)=>{const[s,k]=h.split(':');return cr.timingSafeEqual(Buffer.from(k,'hex'),cr.scryptSync(pw,s,64))};
const hits={};const limited=ip=>{const n=Date.now(),a=(hits[ip]=(hits[ip]||[]).filter(t=>n-t<60000));a.push(n);return a.length>10};
const send=(res,code,obj,h={})=>{res.writeHead(code,{'Content-Type':'application/json','X-Content-Type-Options':'nosniff',...h});res.end(JSON.stringify(obj))};
const SEV={Normal:0,Important:1,Research:1,Major:2,Critical:3},MIN={All:0,'Major only':2,'Critical only':3};
const shape=m=>({...m,open:!!m.open,verified:!!m.verified,uses:m.uses?m.uses.split(',').filter(Boolean):[]});
const M='select m.*,o.name org from models m join orgs o on o.id=m.org_id';
async function notify(db,event){
const al=db.prepare(`select a.*,u.email,u.name from alerts a join users u on u.id=a.user_id where a.channel like '%email%' and (a.org_id is null or a.org_id=?) and (a.cat is null or a.cat=?)`).all(event.org_id,event.cat);
for(const a of al){if(SEV[event.sev]<MIN[a.minsev])continue;
const r=await sendMail({to:a.email,subject:`[Signalstack] ${event.sev}: ${event.summary}`,text:`${event.summary}\n\nSeverity: ${event.sev}\nCategory: ${event.cat}\nSource: ${event.source||''}\n\nManage alerts: your Signalstack account.`});
db.prepare('insert into notification_log(user_id,channel,status,error) values(?,?,?,?)').run(a.user_id,'email',r.ok?'sent':'failed',r.error||null);
}}
function diff(a,b){const A=a.split(';;'),B=b.split(';;'),k=x=>x.split(':')[0],ak=A.map(k),bk=B.map(k),out=[];
B.forEach(l=>{if(!ak.includes(k(l)))out.push({t:'added',text:l});else{const o=A.find(x=>k(x)===k(l));if(o!==l)out.push({t:'changed',text:o+' -> '+l})}});
A.forEach(l=>{if(!bk.includes(k(l)))out.push({t:'removed',text:l})});
return{changes:out,severity:out.some(c=>c.t==='removed')?'Breaking':out.length?'Important':'Informational'}}
 
http.createServer((req,res)=>{
const u=new URL(req.url,'http://x'),p=u.pathname,q=u.searchParams,ip=req.socket.remoteAddress;
const legal=p.replace(/\.html$/,'').replace(/\/$/,'');
if(legal==='/privacy'||legal==='/terms'){return fs.readFile(path.join(__dirname,'public',legal.slice(1)+'.html'),'utf8',(e,d)=>{if(e){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Not found')}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const v={OPERATOR_NAME:process.env.OPERATOR_NAME||'[set OPERATOR_NAME]',CONTACT_EMAIL:process.env.CONTACT_EMAIL||'[set CONTACT_EMAIL]',JURISDICTION:process.env.JURISDICTION||'[set JURISDICTION]',UPDATED:LEGAL_VERSION};
res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(d.replace(/\{\{(\w+)\}\}/g,(m,k)=>k in v?esc(v[k]):m))})}
if(!p.startsWith('/api')){const f=path.join(__dirname,'public','index.html');return fs.readFile(f,(e,d)=>{res.writeHead(e?404:200,{'Content-Type':'text/html; charset=utf-8'});res.end(e?'Not found':d)})}
let body='';req.on('data',c=>{body+=c;if(body.length>1e5)req.destroy()});
req.on('end',async()=>{try{
const j=body?JSON.parse(body):{},sid=(req.headers.cookie||'').match(/sid=([a-f0-9]+)/)?.[1];
const s=sid&&db.prepare('select user_id from sessions where token=? and expires>?').get(sid,Date.now());
const uid=s?.user_id,need=()=>{if(!uid){send(res,401,{error:'Please log in to continue.'});return false}return true};
const ck=t=>`sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${t?604800:0}`;
// auth
if(p==='/api/signup'&&req.method==='POST'){if(limited(ip))return send(res,429,{error:'Too many attempts. Wait a minute and try again.'});
const email=String(j.email||'').trim().toLowerCase(),password=j.password,name=j.name;if(!/^\S+@\S+\.\S+$/.test(email))return send(res,400,{error:'Enter a valid email address.'});if((password||'').length<8)return send(res,400,{error:'Password must be at least 8 characters.'});
if(j.accept!==true)return send(res,400,{error:'You must accept the Terms & Conditions and Privacy Policy to create an account.'});
if(db.prepare('select 1 from users where email=?').get(email))return send(res,409,{error:'An account with this email already exists. Try logging in.'});
const role=db.prepare('select count(*) c from users').get().c===0?'admin':'user';
const r=db.prepare('insert into users(email,name,pw,role,accepted_at,accepted_version) values(?,?,?,?,?,?)').run(email,String(name||'').slice(0,60),hash(password),role,new Date().toISOString(),LEGAL_VERSION);
const t=cr.randomBytes(24).toString('hex');db.prepare('insert into sessions values(?,?,?)').run(t,r.lastInsertRowid,Date.now()+6048e5);return send(res,201,{ok:true},{'Set-Cookie':ck(t)})}
if(p==='/api/login'&&req.method==='POST'){if(limited(ip))return send(res,429,{error:'Too many attempts. Wait a minute and try again.'});
const us=db.prepare('select * from users where email=?').get(String(j.email||'').trim().toLowerCase());
if(!us||!check(String(j.password||''),us.pw))return send(res,401,{error:'Email or password is incorrect.'});
const t=cr.randomBytes(24).toString('hex');db.prepare('insert into sessions values(?,?,?)').run(t,us.id,Date.now()+6048e5);return send(res,200,{ok:true},{'Set-Cookie':ck(t)})}
if(p==='/api/logout'){if(sid)db.prepare('delete from sessions where token=?').run(sid);return send(res,200,{ok:true},{'Set-Cookie':ck('')})}
if(p==='/api/forgot-password'&&req.method==='POST'){if(limited(ip))return send(res,429,{error:'Too many attempts. Wait a minute and try again.'});
const email=String(j.email||'').trim().toLowerCase();const us=db.prepare('select 1 from users where email=?').get(email);
if(us){const code=String(cr.randomInt(100000,999999));db.prepare('insert into password_resets(email,code,expires) values(?,?,?) on conflict(email) do update set code=excluded.code,expires=excluded.expires').run(email,code,Date.now()+600000);
const r=await sendMail({to:email,subject:'Your Signalstack reset code',text:`Your password reset code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`});
if(r.ok)console.log(`[password reset] Email send reported success to ${email}. Code was: ${code}`);
else console.log(`[password reset] Email not sent (${r.error}). Code for ${email}: ${code}`);}
// Always respond the same way whether or not the account exists, so this can't be used to check which emails have accounts.
return send(res,200,{ok:true,message:'If that email has an account, a reset code has been sent.'})}
if(p==='/api/reset-password'&&req.method==='POST'){if(limited(ip))return send(res,429,{error:'Too many attempts. Wait a minute and try again.'});
const email=String(j.email||'').trim().toLowerCase(),code=String(j.code||'').trim();
const rr=db.prepare('select * from password_resets where email=?').get(email);
if(!rr||rr.code!==code||rr.expires<Date.now())return send(res,400,{error:'That code is invalid or has expired. Request a new one.'});
if((j.password||'').length<8)return send(res,400,{error:'Password must be at least 8 characters.'});
db.prepare('update users set pw=? where email=?').run(hash(j.password),email);
db.prepare('delete from password_resets where email=?').run(email);
const u=db.prepare('select id from users where email=?').get(email);
db.prepare('delete from sessions where user_id=?').run(u.id); // log out any existing sessions for safety
return send(res,200,{ok:true})}
if(p==='/api/me'){if(!need())return;return send(res,200,db.prepare('select id,email,name,role from users where id=?').get(uid))}
const isAdmin=uid&&db.prepare('select role from users where id=?').get(uid)?.role==='admin';
const needAdmin=()=>{if(!need())return false;if(!isAdmin){send(res,403,{error:'This area is for admins only.'});return false}return true};
// data (login required)
if(!need())return;
if(p==='/api/models')return send(res,200,db.prepare(M+' order by m.rel desc').all().map(shape));
let m=p.match(/^\/api\/models\/([\w-]+)$/);
if(m){const md=db.prepare(M+' where m.id=?').get(m[1]);if(!md)return send(res,404,{error:'Model not found.'});
return send(res,200,{model:shape(md),results:db.prepare('select r.*,b.name bname,b.ver bver from results r join benchmarks b on b.id=r.bench_id where model_id=? order by date desc').all(m[1]),
papers:db.prepare("select * from papers where (','||model_ids||',') like ?").all('%,'+m[1]+',%'),events:db.prepare('select * from events where model_id=? order by ts desc').all(m[1])})}
if(p==='/api/benchmarks')return send(res,200,db.prepare('select * from benchmarks').all());
m=p.match(/^\/api\/benchmarks\/([\w-]+)$/);
if(m)return send(res,200,{benchmark:db.prepare('select * from benchmarks where id=?').get(m[1]),results:db.prepare('select r.*,mo.name mname from results r join models mo on mo.id=r.model_id where bench_id=? order by score desc').all(m[1])});
if(p==='/api/papers')return send(res,200,db.prepare('select p.*,o.name org from papers p join orgs o on o.id=p.org_id order by date desc').all().map(x=>({...x,verified:!!x.verified})));
if(p==='/api/events'){const o=q.get('org'),sv=q.get('sev');return send(res,200,db.prepare('select e.*,o.name org,mo.name model from events e join orgs o on o.id=e.org_id left join models mo on mo.id=e.model_id where (?1 is null or e.org_id=?1) and (?2 is null or e.sev=?2) order by ts desc limit ?3').all(o,sv,Math.min(+q.get('limit')||50,100)))}
if(p==='/api/orgs')return send(res,200,db.prepare('select * from orgs').all());
if(p==='/api/docs')return send(res,200,db.prepare('select version,date from doc_versions order by date desc').all());
if(p==='/api/docs/diff'){const a=db.prepare('select lines from doc_versions where version=?').get(q.get('a')),b=db.prepare('select lines from doc_versions where version=?').get(q.get('b'));if(!a||!b)return send(res,404,{error:'Version not found.'});return send(res,200,diff(a.lines,b.lines))}
if(p==='/api/search'){const t=q.get('q')||'';if(t.length<2)return send(res,200,{});const l='%'+t+'%';
return send(res,200,{models:db.prepare('select id,name from models where name like ?1 or arch like ?1 or uses like ?1').all(l),benchmarks:db.prepare('select id,name,ver from benchmarks where name like ?1 or cat like ?1').all(l),papers:db.prepare('select id,title from papers where title like ?1 or tldr like ?1 or arch like ?1').all(l),events:db.prepare('select id,summary from events where summary like ?1 or cat like ?1').all(l)})}
// personal
if(p==='/api/watchlist'){if(req.method==='POST')db.prepare('insert or ignore into watchlist values(?,?)').run(uid,j.model_id);if(req.method==='DELETE')db.prepare('delete from watchlist where user_id=? and model_id=?').run(uid,j.model_id);return send(res,200,db.prepare('select model_id from watchlist where user_id=?').all(uid).map(r=>r.model_id))}
if(p==='/api/alerts'){if(req.method==='POST'){if(!(j.minsev in MIN))return send(res,400,{error:'Choose a severity level.'});const ch=j.channel==='app+email'?'app+email':'app';db.prepare('insert into alerts(user_id,org_id,cat,minsev,channel) values(?,?,?,?,?)').run(uid,j.org_id||null,j.cat||null,j.minsev,ch)}
if(req.method==='DELETE')db.prepare('delete from alerts where id=? and user_id=?').run(j.id,uid);
const al=db.prepare('select * from alerts where user_id=?').all(uid),ev=db.prepare('select e.*,o.name org from events e join orgs o on o.id=e.org_id order by ts desc').all();
return send(res,200,{alerts:al,matches:ev.filter(e=>al.some(a=>(!a.org_id||a.org_id===e.org_id)&&(!a.cat||a.cat===e.cat)&&SEV[e.sev]>=MIN[a.minsev]))})}
// ---- admin ----
if(p==='/api/admin/summary'){if(!needAdmin())return;
return send(res,200,{users:db.prepare('select count(*) c from users').get().c,models:db.prepare('select count(*) c from models').get().c,
papers:db.prepare('select count(*) c from papers').get().c,events:db.prepare('select count(*) c from events').get().c,
pendingModels:db.prepare('select count(*) c from models where verified=0').get().c,pendingPapers:db.prepare('select count(*) c from papers where verified=0').get().c,
sources:db.prepare('select * from sources_config').all(),
emailsSent:db.prepare("select count(*) c from notification_log where status='sent'").get().c,
emailsFailed:db.prepare("select count(*) c from notification_log where status='failed'").get().c,
emailConfigured:!!process.env.SMTP_HOST})}
if(p==='/api/admin/log'){if(!needAdmin())return;return send(res,200,db.prepare('select * from ingestion_log order by ts desc limit 40').all())}
if(p==='/api/admin/pending'){if(!needAdmin())return;return send(res,200,{models:db.prepare('select * from models where verified=0').all().map(shape),papers:db.prepare('select * from papers where verified=0').all()})}
if(p==='/api/admin/review'&&req.method==='POST'){if(!needAdmin())return;const t=j.type==='paper'?'papers':'models';
if(j.action==='approve')db.prepare(`update ${t} set verified=1 where id=?`).run(j.id);else db.prepare(`delete from ${t} where id=?`).run(j.id);
return send(res,200,{ok:true})}
if(p==='/api/admin/review/bulk'&&req.method==='POST'){if(!needAdmin())return;
const types=j.type==='paper'?['papers']:j.type==='model'?['models']:['models','papers'];
let count=0;
for(const t of types){const rows=db.prepare(`select id from ${t} where verified=0`).all();
if(j.action==='approve')db.prepare(`update ${t} set verified=1 where verified=0`).run();
else db.prepare(`delete from ${t} where verified=0`).run();
count+=rows.length}
return send(res,200,{ok:true,count})}
if(p==='/api/admin/sources'&&req.method==='POST'){if(!needAdmin())return;db.prepare('update sources_config set enabled=? where id=?').run(j.enabled?1:0,j.id);return send(res,200,{ok:true})}
if(p==='/api/admin/ingest/run'&&req.method==='POST'){if(!needAdmin())return;
runAll(db).then(inserted=>{const full=inserted.map(x=>db.prepare('select * from events where id=?').get(x.id));full.forEach(e=>notify(db,e).catch(()=>{}))});
return send(res,202,{ok:true,message:'Ingestion started. Refresh the admin page in a few seconds for results.'})}
if(p==='/api/admin/users'){if(!needAdmin())return;return send(res,200,db.prepare('select id,email,name,role,created from users order by id').all())}
if(p==='/api/admin/users/role'&&req.method==='POST'){if(!needAdmin())return;db.prepare('update users set role=? where id=?').run(j.role==='admin'?'admin':'user',j.id);return send(res,200,{ok:true})}
if(p==='/api/admin/test-email'&&req.method==='POST'){if(!needAdmin())return;
const r=await sendMail({to:j.to,subject:'Signalstack test email',text:'If you are reading this, your SMTP settings are working correctly.'});
return send(res,r.ok?200:500,r)}
send(res,404,{error:'Endpoint not found.'})}catch(e){console.error(e);send(res,500,{error:'Something went wrong on our side. Try again shortly.'})}})}).listen(PORT,()=>{console.log('Signalstack running at http://localhost:'+PORT);
scheduleIngestion();});
 
function scheduleIngestion(){
const mins=Math.max(5,+process.env.INGEST_INTERVAL_MIN||30);
const tick=async()=>{try{
const inserted=await runAll(db);
const full=inserted.map(x=>db.prepare('select * from events where id=?').get(x.id));
for(const e of full)await notify(db,e).catch(err=>console.error('notify failed:',err.message));
if(inserted.length)console.log(`Ingestion: ${inserted.length} new event(s).`);
}catch(e){console.error('Ingestion run failed:',e.message)}};
setTimeout(tick,10000); // first run shortly after boot
setInterval(tick,mins*60000);
console.log(`Ingestion scheduled every ${mins} minute(s). Set INGEST_INTERVAL_MIN to change.`);
}
 
