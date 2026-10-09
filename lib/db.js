'use strict';
// Database: schema, migrations, reference data and the list of live sources.
const { DatabaseSync } = require('node:sqlite');
const { COMPANIES, byHandle } = require('./companies');
const { categorize, tagInfo, parseParams } = require('./classify');

const SCHEMA = `pragma foreign_keys=on;
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
create table if not exists notification_log(id integer primary key,user_id integer references users(id) on delete cascade,channel text,status text,error text,ts text default current_timestamp);`;

// Columns added after the first release. Added one by one so existing databases are upgraded in place.
const COLUMNS = [
  ['users', 'accepted_at text'], ['users', 'accepted_version text'],
  ['models', 'likes integer default 0'], ['models', 'downloads integer default 0'], ['models', 'url text'],
  ['models', 'creator text'], ['models', 'company_id text'], ['models', 'released_at text'], ['models', 'updated_at text'],
  ['models', 'license text'], ['models', 'pipeline text'], ['models', 'library text'], ['models', 'cats text'],
  ['models', 'arxiv text'], ['models', 'param_count real'], ['models', 'params_label text'], ['models', 'gated integer default 0'],
  ['models', "verification text default 'community'"], ['models', "source_type text default 'huggingface'"], ['models', 'retrieved_at text'],
  ['models', 'trend_rank integer'], ['models', 'trend_at text'], ['models', 'detail_at text'],
  ['papers', 'authors text'], ['papers', 'published_at text'], ['papers', 'entities text'],
  ['papers', "verification text default 'verified'"], ['papers', "source_type text default 'arxiv'"], ['papers', 'retrieved_at text'],
  ['events', 'title text'], ['events', 'detail text'], ['events', 'source_type text'], ['events', 'verification text'],
  ['events', 'meta text'], ['events', 'company_id text'], ['events', 'retrieved_at text'],
];
const INDEXES = `create index if not exists ix_res on results(model_id,bench_id);
create index if not exists ix_ev on events(ts);create index if not exists ix_ev_cat on events(cat,ts);
create index if not exists ix_ses on sessions(user_id);create index if not exists ix_log on ingestion_log(ts);
create index if not exists ix_mrel on models(rel);create index if not exists ix_mlikes on models(likes);
create index if not exists ix_mcreator on models(creator);create index if not exists ix_mcompany on models(company_id);
create index if not exists ix_mreleased on models(released_at);create index if not exists ix_mtrend on models(trend_at);
create index if not exists ix_pdate on papers(date);create index if not exists ix_ppub on papers(published_at)`;

// ---- live sources ----
// tier: primary = straight from the original publisher, community = open to anyone to publish.
// Rows carry "v":3. A row you edit and keep at v:3 is never overwritten by later upgrades.
const SRC_VERSION = 3;
const org = (id, name) => ({ id, name });
const BASE_SOURCES = [
  ['hf-new-models', 'huggingface', 'Hugging Face — newest models', { sort: 'createdAt', limit: 100, pages: 5, backfillPages: 10, tier: 'community' }],
  ['hf-top-liked', 'huggingface', 'Hugging Face — most-liked models', { sort: 'likes', limit: 100, pages: 5, backfillPages: 5, tier: 'community' }],
  ['hf-trending', 'huggingface', 'Hugging Face — trending models', { sort: 'trendingScore', limit: 50, pages: 1, events: 'trending', maxEvents: 25, trending: true, tier: 'community' }],
  ['arxiv-llm', 'arxiv', 'arXiv — language model papers', { query: 'cat:cs.CL AND abs:language model', limit: 100, maxEvents: 10, tier: 'primary' }],
  ['arxiv-cs-cl', 'arxiv', 'arXiv — cs.CL (language)', { category: 'cs.CL', limit: 100, backfillPages: 3, maxEvents: 10, tier: 'primary' }],
  ['arxiv-cs-lg', 'arxiv', 'arXiv — cs.LG (machine learning)', { category: 'cs.LG', limit: 100, backfillPages: 3, maxEvents: 10, tier: 'primary' }],
  ['arxiv-cs-ai', 'arxiv', 'arXiv — cs.AI', { category: 'cs.AI', limit: 100, backfillPages: 3, maxEvents: 10, tier: 'primary' }],
  ['arxiv-cs-cv', 'arxiv', 'arXiv — cs.CV (vision)', { category: 'cs.CV', limit: 100, backfillPages: 3, maxEvents: 10, tier: 'primary' }],
  ['gh-transformers', 'github', 'GitHub — huggingface/transformers', { owner: 'huggingface', repo: 'transformers', tier: 'primary' }],
  ['gh-llamacpp', 'github', 'GitHub — ggml-org/llama.cpp', { owner: 'ggml-org', repo: 'llama.cpp', tier: 'primary' }],
  ['gh-vllm', 'github', 'GitHub — vllm-project/vllm', { owner: 'vllm-project', repo: 'vllm', tier: 'primary' }],
  ['gh-ollama', 'github', 'GitHub — ollama/ollama', { owner: 'ollama', repo: 'ollama', tier: 'primary' }],
  ['gh-diffusers', 'github', 'GitHub — huggingface/diffusers', { owner: 'huggingface', repo: 'diffusers', tier: 'primary' }],
  ['gh-openai-python', 'github', 'GitHub — openai/openai-python', { owner: 'openai', repo: 'openai-python', tier: 'primary' }],
  ['gh-anthropic-sdk', 'github', 'GitHub — anthropics/anthropic-sdk-python', { owner: 'anthropics', repo: 'anthropic-sdk-python', tier: 'primary' }],
  ['feed-openai', 'feed', 'OpenAI — news', { url: 'https://openai.com/news/rss.xml', org: org('openai', 'OpenAI'), company: 'openai', tier: 'primary' }],
  ['feed-deepmind', 'feed', 'Google DeepMind — blog', { url: 'https://deepmind.google/blog/rss.xml', org: org('deepmind', 'Google DeepMind'), company: 'google', tier: 'primary' }],
  ['feed-hf-blog', 'feed', 'Hugging Face — blog', { url: 'https://huggingface.co/blog/feed.xml', org: org('hfblog', 'Hugging Face Blog'), tier: 'community' }],
];
// One source per official Hugging Face namespace: every new model from these labs becomes a "new model" signal.
const LAB_SOURCES = COMPANIES.flatMap(c => c.hf.map(h => [
  'hf-org-' + h.toLowerCase(), 'huggingface', `Hugging Face — ${h} (${c.name})`,
  { author: h, sort: 'createdAt', limit: 50, pages: 2, backfillPages: 4, events: 'release', backfillEvents: 3, company: c.id, tier: 'primary' },
]));
const SOURCES = [...BASE_SOURCES, ...LAB_SOURCES];

function openDb(file) {
  const db = new DatabaseSync(file || 'signalstack.db');
  db.exec(SCHEMA);
  for (const [t, c] of COLUMNS) {
    try { db.exec(`alter table ${t} add column ${c}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  db.exec(INDEXES);

  for (const o of [['ext', 'External / Unverified'], ['hf', 'Hugging Face Hub'], ['arxiv', 'arXiv'], ['gh', 'GitHub releases']]) {
    db.prepare('insert or ignore into orgs values(?,?)').run(...o);
  }
  // Fictional sample rows from older versions are removed; SignalStack shows real data only.
  try {
    db.exec(`delete from results where source like 'demo://%';
      delete from events where source like 'demo://%';
      delete from papers where url like 'demo://%';
      delete from models where id in ('meridian-3','meridian-mini','aster-r2','kestrel-70b','kestrel-moe','aster-long');
      delete from benchmarks where id in ('codeeval-v3','codeeval-v2','reasonbench','mathset');
      delete from doc_versions where version in ('v4.1','v4.2','v4.3');
      delete from orgs where id in ('na','al','ko');`);
  } catch (e) { console.error('Demo cleanup failed:', e.message); }

  for (const [id, kind, label, cfg] of SOURCES) {
    const c = JSON.stringify({ v: SRC_VERSION, ...cfg });
    db.prepare('insert or ignore into sources_config(id,kind,label,config,enabled) values(?,?,?,?,1)').run(id, kind, label, c);
    db.prepare(`update sources_config set kind=?,label=?,config=? where id=? and config not like '%"v":${SRC_VERSION}%'`).run(kind, label, c, id);
  }
  backfillModels(db);
  return db;
}

// Rows saved by earlier versions lack the new fields. Fill them from what those rows already hold.
function backfillModels(db) {
  const rows = db.prepare("select id,name,uses,rel from models where org_id='hf' and (cats is null or creator is null or released_at is null)").all();
  if (!rows.length) return;
  const upd = db.prepare('update models set creator=?,company_id=?,verification=?,released_at=coalesce(released_at,?),cats=?,pipeline=?,license=coalesce(license,?),arxiv=coalesce(arxiv,?),param_count=coalesce(param_count,?),params_label=coalesce(params_label,?) where id=?');
  db.exec('begin');
  try {
    for (const r of rows) {
      const tags = (r.uses || '').split(',').filter(Boolean);
      const creator = String(r.name || '').split('/')[0];
      const co = byHandle(creator), c = categorize({ name: r.name, pipeline: '', tags }), ti = tagInfo(tags), pp = parseParams(r.name);
      upd.run(creator, co ? co.id : null, co ? 'verified' : 'community', r.rel ? r.rel + 'T00:00:00.000Z' : null,
        ',' + c.cats.join(',') + ',', c.pipeline || null, ti.license || null, ti.arxiv.join(',') || null, pp ? pp.count : null, pp ? pp.label : null, r.id);
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
}

module.exports = { openDb, SOURCES, SRC_VERSION };
