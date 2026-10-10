'use strict';
// Ingestion pipeline: SOURCE -> FETCH (paged) -> NORMALIZE -> DEDUPLICATE -> ENTITY EXTRACTION -> CLASSIFY -> STORE -> SIGNALS.
// Real public sources only: Hugging Face Hub, arXiv, GitHub releases, and lab blog RSS feeds.
// No API keys are required. Optional: HF_TOKEN / GITHUB_TOKEN raise rate limits.
//
// Behaviour worth knowing:
//  * The first run of a source is a "backfill": it fills the catalog, creates only a few signals, and never
//    triggers alert emails, so a fresh deploy does not flood anyone.
//  * Later runs stop paging as soon as a whole page is already known, so they stay cheap.
//  * Every record keeps where it came from (source URL, source type, when we last retrieved it) and a
//    verification level: verified = from the original publisher, community = open to anyone to publish.
//  * Items are published immediately. Set REQUIRE_REVIEW=true to hold them for admin approval instead.
const crypto = require('node:crypto');
const { byHandle, byGithubOwner, byId, mentions } = require('./lib/companies');
const { categorize, tagInfo, parseParams, pipelineOf, typeLabel, formatCount } = require('./lib/classify');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts16 = s => String(s || nowIso()).replace('T', ' ').slice(0, 16);
const unxml = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const httpUrl = u => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');
const isoOf = d => { const t = new Date(d); return isNaN(t) ? nowIso() : t.toISOString(); };
const verificationOf = tier => (tier === 'primary' ? 'verified' : tier === 'secondary' ? 'reported' : 'community');
const REVIEW = () => (process.env.REQUIRE_REVIEW === 'true' ? 0 : 1);

const UA = 'signalstack-ingest/1.0 (+https://github.com/mani17090710-tech/signalstack)';
async function fetchRes(url, f, headers = {}) {
  const r = await f(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(url.split('?')[0] + ' returned HTTP ' + r.status);
  return { text: await r.text(), link: (r.headers && r.headers.get && r.headers.get('link')) || '' };
}

// ---------- adapters: raw text -> normalized items ----------
function parseHuggingFace(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('Unexpected Hugging Face response');
  return arr.filter(m => m && m.id && !m.private).map(m => {
    const tags = Array.isArray(m.tags) ? m.tags.map(String) : [];
    const name = String(m.id);
    return {
      id: 'hf:' + name, name, creator: name.includes('/') ? name.split('/')[0] : '',
      createdAt: m.createdAt || '', likes: +m.likes || 0, downloads: +m.downloads || 0,
      pipeline: pipelineOf(m.pipeline_tag, tags), library: m.library_name || '', tags, gated: m.gated ? 1 : 0,
      url: 'https://huggingface.co/' + name,
    };
  });
}
function parseGitHub(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('Unexpected GitHub response');
  return arr.filter(r => !r.draft && !r.prerelease).map(r => ({
    tag: r.tag_name, name: r.name || r.tag_name, published: r.published_at || r.created_at, url: r.html_url, body: (r.body || '').slice(0, 300),
  }));
}
function parseArxiv(text) {
  const entries = [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const pick = (x, tag) => unxml((x.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>')) || [, ''])[1]).trim();
  return entries.map(e => {
    const raw = (pick(e, 'id').split('/abs/')[1] || '').replace(/v\d+$/, '');
    if (!raw) return null;
    return {
      id: 'arxiv:' + raw, title: pick(e, 'title').replace(/\s+/g, ' '), summary: pick(e, 'summary').replace(/\s+/g, ' ').slice(0, 600),
      published: pick(e, 'published'), cat: (e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [, ''])[1], url: 'https://arxiv.org/abs/' + raw,
      authors: [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map(m => unxml(m[1]).trim()).slice(0, 8),
    };
  }).filter(Boolean);
}
function parseFeed(text) {
  const blocks = [...[...text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)], ...[...text.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)]].map(m => m[1]);
  const tag = (x, t) => { const m = x.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + t + '>')); return m ? unxml(m[1]).trim() : ''; };
  return blocks.map(b => {
    const href = (b.match(/<link[^>]*\shref="([^"]+)"/) || [, ''])[1];
    const link = httpUrl(href || tag(b, 'link') || tag(b, 'guid'));
    const title = tag(b, 'title').replace(/\s+/g, ' ');
    return link && title ? { title, link, date: isoOf(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || nowIso()) } : null;
  }).filter(Boolean);
}

// ---------- shared writers ----------
function addEvent(db, e) {
  const r = db.prepare(`insert into events(sev,ts,org_id,model_id,cat,summary,source,title,detail,source_type,verification,meta,company_id,retrieved_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    e.sev, e.ts, e.org_id, e.model_id || null, e.cat, e.summary, e.source, e.title || null, e.detail || null,
    e.source_type, e.verification, e.meta ? JSON.stringify(e.meta) : null, e.company_id || null, nowIso());
  return { id: r.lastInsertRowid, sev: e.sev, cat: e.cat, org_id: e.org_id };
}

const UPSERT_MODEL = `insert into models(id,name,org_id,arch,params,ctx,open,price,rel,ver,uses,verified,likes,downloads,url,creator,company_id,released_at,license,pipeline,library,cats,arxiv,param_count,params_label,gated,verification,source_type,retrieved_at)
  values($id,$name,'hf','',$params,'',1,'',$rel,'',$uses,$verified,$likes,$downloads,$url,$creator,$company,$released,$license,$pipeline,$library,$cats,$arxiv,$pc,$pl,$gated,$verification,'huggingface',$now)
  on conflict(id) do update set likes=excluded.likes,downloads=excluded.downloads,uses=excluded.uses,cats=excluded.cats,license=excluded.license,
    pipeline=excluded.pipeline,library=excluded.library,arxiv=excluded.arxiv,creator=excluded.creator,company_id=excluded.company_id,
    verification=excluded.verification,gated=excluded.gated,retrieved_at=excluded.retrieved_at,
    released_at=coalesce(models.released_at,excluded.released_at),param_count=coalesce(models.param_count,excluded.param_count),
    params_label=coalesce(models.params_label,excluded.params_label)`;

// Turns one normalized Hugging Face item into the columns we store (classification + entity extraction).
function describeModel(m) {
  const co = byHandle(m.creator), c = categorize({ name: m.name, pipeline: m.pipeline, tags: m.tags }), ti = tagInfo(m.tags), pp = parseParams(m.name);
  const uses = [m.pipeline, ...m.tags.filter(t => t !== m.pipeline && !/^(region:|endpoints_compatible|autotrain_compatible|text-generation-inference|deploy:|license:|arxiv:)/.test(t))]
    .filter(Boolean).map(t => t.replace(/,/g, ' ')).slice(0, 8).join(',');
  return { co, cats: ',' + c.cats.join(',') + ',', type: c.type, license: ti.license, arxiv: ti.arxiv.join(','), pp, uses };
}
function saveModel(db, m) {
  const d = describeModel(m);
  db.prepare(UPSERT_MODEL).run({
    id: m.id, name: m.name, params: d.pp ? d.pp.label : '', rel: (m.createdAt || nowIso()).slice(0, 10), uses: d.uses, verified: REVIEW(),
    likes: m.likes, downloads: m.downloads, url: m.url, creator: m.creator, company: d.co ? d.co.id : null, released: m.createdAt || nowIso(),
    license: d.license || null, pipeline: m.pipeline || null, library: m.library || null, cats: d.cats, arxiv: d.arxiv || null,
    pc: d.pp ? d.pp.count : null, pl: d.pp ? d.pp.label : null, gated: m.gated, verification: d.co ? 'verified' : 'community', now: nowIso(),
  });
  return d;
}
const modelSentence = (m, d) => `${d.type}${d.pp ? `, ${d.pp.label} parameters` : ''}${d.license ? `, ${d.license} license` : ''}.`;

// ---------- Hugging Face ----------
function hfUrl(cfg) {
  const u = new URL(cfg.url || 'https://huggingface.co/api/models');
  u.searchParams.set('sort', cfg.sort || 'createdAt');
  u.searchParams.set('direction', '-1');
  u.searchParams.set('limit', String(Math.min(+cfg.limit || 100, 1000)));
  for (const k of ['author', 'pipeline_tag', 'filter']) if (cfg[k]) u.searchParams.set(k, cfg[k]);
  return u.toString();
}
const hfHeaders = () => (process.env.HF_TOKEN ? { Authorization: 'Bearer ' + process.env.HF_TOKEN } : {});

async function runHF(db, src, cfg, f, first) {
  const pages = first ? cfg.backfillPages || 10 : cfg.pages || 5;
  const known = db.prepare('select 1 from models where id=?');
  const hasEv = db.prepare('select 1 from events where source=? and cat=?');
  const setTrend = db.prepare('update models set trend_rank=?,trend_at=? where id=?');
  let prev = new Set();
  if (!first && cfg.events === 'trending') { try { prev = new Set(JSON.parse(src.last_seen)); } catch (e) { /* first value */ } }
  const evCap = first ? cfg.backfillEvents || 5 : cfg.maxEvents || 25;
  const ids = [], inserted = [];
  let next = hfUrl(cfg), firstText = '', total = 0, created = 0, evCount = 0, rank = 0;

  for (let i = 0; i < pages && next; i++) {
    const r = await fetchRes(next, f, hfHeaders());
    if (i === 0) firstText = r.text;
    const items = parseHuggingFace(r.text);
    total += items.length;
    let fresh = 0;
    db.exec('begin');
    try {
      for (const m of items) {
        const isNew = !known.get(m.id);
        if (isNew) { fresh++; created++; }
        const d = saveModel(db, m);
        rank++;
        if (cfg.trending) setTrend.run(rank, nowIso(), m.id);
        ids.push(m.id);

        let want = null;
        if (cfg.events === 'release' && isNew) want = 'Model Release';
        if (cfg.events === 'trending' && (first || !prev.has(m.id))) want = 'Trending';
        if (want && evCount < evCap && !hasEv.get(m.url, want)) {
          const lab = d.co;
          const sev = want === 'Model Release' ? (lab ? 'Major' : 'Important') : (m.likes >= 100 ? 'Important' : 'Normal');
          const summary = want === 'Model Release'
            ? `New model${lab ? ' from ' + lab.name : ''}: ${m.name}.`
            : `Trending on Hugging Face: ${m.name} (${m.likes} likes, ${m.downloads} downloads).`;
          const ev = addEvent(db, {
            sev, ts: ts16(m.createdAt), org_id: 'hf', model_id: m.id, cat: want, summary, title: m.name, detail: modelSentence(m, d),
            source: m.url, source_type: 'huggingface', verification: lab ? 'verified' : verificationOf(cfg.tier), company_id: lab ? lab.id : null,
          });
          evCount++;
          if (!first) inserted.push(ev);
        }
      }
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    // Stop once a whole page is already known. Sorted-by-popularity feeds are re-read in full because their order changes.
    if (!first && cfg.sort === 'createdAt' && items.length && !fresh) break;
    const nx = r.link.match(/<([^>]+)>;\s*rel="next"/);
    let nu = null;
    try { nu = nx && new URL(nx[1]); } catch (e) { /* ignore a malformed link header */ }
    next = nu && nu.hostname === 'huggingface.co' ? nu.toString() : null;
  }
  return { firstText, items: total, created, inserted, seen: cfg.events === 'trending' && ids.length ? JSON.stringify(ids) : undefined };
}

// ---------- arXiv ----------
let lastArxiv = 0;
async function arxivWait(opt) {
  const gap = opt.arxivDelayMs ?? 3100, w = lastArxiv + gap - Date.now();
  if (w > 0) await sleep(w);
  lastArxiv = Date.now();
}
async function runArxiv(db, src, cfg, f, first, opt) {
  const q = cfg.query || (cfg.category ? 'cat:' + cfg.category : 'cat:cs.CL');
  const per = Math.min(+cfg.limit || 100, 200), pages = first ? cfg.backfillPages || 3 : cfg.pages || 1;
  const known = db.prepare('select 1 from papers where id=?');
  const ins = db.prepare(`insert or ignore into papers(id,title,org_id,date,model_ids,arch,tldr,limits,url,verified,authors,published_at,entities,verification,source_type,retrieved_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let firstText = '', total = 0, created = 0;
  const fresh = [];
  for (let i = 0; i < pages; i++) {
    await arxivWait(opt);
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&start=${i * per}&max_results=${per}`;
    const r = await fetchRes(url, f);
    if (i === 0) firstText = r.text;
    const items = parseArxiv(r.text);
    total += items.length;
    let n = 0;
    db.exec('begin');
    try {
      for (const p of items) {
        if (known.get(p.id)) continue;
        n++; created++;
        p.entities = mentions(p.title + ' ' + p.summary);
        fresh.push(p);
        ins.run(p.id, p.title, 'arxiv', (p.published || nowIso()).slice(0, 10), '', p.cat || 'Not classified', p.summary, '', p.url, REVIEW(),
          p.authors.join(', '), p.published ? isoOf(p.published) : nowIso(), JSON.stringify(p.entities), 'verified', 'arxiv', nowIso());
      }
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    if (!items.length || (!first && !n)) break;
  }
  // Only papers that name a tracked lab or model family become signals; the rest stay searchable in Research.
  const inserted = [], cap = first ? cfg.backfillEvents || 5 : cfg.maxEvents || 10;
  fresh.filter(p => p.entities.length).sort((a, b) => (a.published < b.published ? 1 : -1)).slice(0, cap).forEach(p => {
    const ev = addEvent(db, {
      sev: 'Research', ts: ts16(p.published), org_id: 'arxiv', cat: 'Research', summary: 'New paper: ' + p.title, title: p.title,
      detail: p.summary.slice(0, 240), source: p.url, source_type: 'arxiv', verification: 'verified', company_id: p.entities[0],
      meta: { paper: p.id, mentions: p.entities },
    });
    if (!first) inserted.push(ev);
  });
  return { firstText, items: total, created, inserted };
}

// ---------- GitHub releases ----------
async function runGitHub(db, src, cfg, f, first) {
  const headers = process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {};
  const r = await fetchRes(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases?per_page=15`, f, headers);
  const items = parseGitHub(r.text), has = db.prepare("select 1 from events where source=? and cat='Open Source'"), inserted = [];
  let created = 0;
  const co = byGithubOwner(cfg.owner), since = first ? '' : src.last_seen || '';
  const list = items.filter(x => httpUrl(x.url) && x.published && isoOf(x.published) >= since && !has.get(x.url)).sort((a, b) => (a.published < b.published ? -1 : 1));
  for (const x of first ? list.slice(-(cfg.backfillEvents || 3)) : list) {
    const ev = addEvent(db, {
      sev: 'Major', ts: ts16(x.published), org_id: 'gh', cat: 'Open Source', summary: `${cfg.owner}/${cfg.repo} released ${x.name}.`,
      title: `${cfg.repo} ${x.name}`, detail: x.body.replace(/\s+/g, ' ').slice(0, 240), source: x.url, source_type: 'github-release',
      verification: verificationOf(cfg.tier), company_id: co ? co.id : null, meta: { repo: `${cfg.owner}/${cfg.repo}`, tag: x.tag },
    });
    created++;
    if (!first) inserted.push(ev);
  }
  return { firstText: r.text, items: items.length, created, inserted, seen: items.reduce((m, x) => (x.published && isoOf(x.published) > m ? isoOf(x.published) : m), '') || undefined };
}

// ---------- lab blog feeds ----------
async function runFeed(db, src, cfg, f, first) {
  const org = cfg.org || { id: 'ext', name: 'External / Unverified' };
  db.prepare('insert or ignore into orgs(id,name) values(?,?)').run(org.id, org.name);
  const r = await fetchRes(cfg.url, f), items = parseFeed(r.text), has = db.prepare('select 1 from events where source=?'), inserted = [];
  let created = 0;
  const since = first ? '' : src.last_seen || '';
  const list = items.filter(x => x.date >= since && !has.get(x.link)).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const x of first ? list.slice(-(cfg.backfillEvents || 10)) : list.slice(-20)) {
    const ev = addEvent(db, {
      sev: 'Important', ts: ts16(x.date), org_id: org.id, cat: 'Announcement', summary: `${org.name}: ${x.title}`, title: x.title,
      source: x.link, source_type: 'blog', verification: verificationOf(cfg.tier), company_id: cfg.company || null, meta: { tier: cfg.tier || 'community' },
    });
    created++;
    if (!first) inserted.push(ev);
  }
  return { firstText: r.text, items: items.length, created, inserted, seen: items.reduce((m, x) => (x.date > m ? x.date : m), '') || undefined };
}

// ---------- run one source / all sources ----------
async function runSource(db, src, f, opt = {}) {
  const cfg = JSON.parse(src.config || '{}'), kind = src.kind, first = !src.last_seen;
  const fn = { huggingface: runHF, github: runGitHub, arxiv: runArxiv, feed: runFeed }[kind];
  if (!fn) throw new Error('Unknown source kind: ' + kind);
  const r = await fn(db, src, cfg, f, first, opt);
  const hash = sha(r.firstText || '');
  if (!first && hash === src.last_hash && !r.created) return { status: 'unchanged', items: 0, created: 0, inserted: [] };
  db.prepare('update sources_config set last_hash=?,last_seen=? where id=?').run(hash, r.seen || (r.items ? nowIso() : src.last_seen), src.id);
  return { status: 'ok', items: r.items, created: r.created, inserted: r.inserted, first };
}

function prune(db) {
  const days = Math.max(30, +process.env.RETENTION_DAYS || 365);
  try {
    db.exec(`delete from models where org_id='hf' and company_id is null and likes<3 and downloads<50 and rel<date('now','-45 day')
      and id not in (select model_id from results where model_id is not null) and id not in (select model_id from events where model_id is not null) and id not in (select model_id from watchlist);
      delete from papers where date<date('now','-${days} day');
      delete from events where ts<datetime('now','-120 day') and model_id is null;
      delete from ingestion_log where ts<datetime('now','-14 day');
      delete from sessions where expires<${Date.now()};delete from password_resets where expires<${Date.now()}`);
  } catch (e) { console.error('Prune failed:', e.message); }
}

let running = false;
async function runAll(db, f = fetch, opt = {}) {
  if (running) return [];
  running = true;
  try {
    const sources = db.prepare('select * from sources_config where enabled=1').all(), all = [];
    for (const src of sources) {
      const ts = nowIso();
      try {
        const r = await runSource(db, src, f, opt);
        db.prepare('update sources_config set last_run=?,last_status=?,last_error=null where id=?').run(ts, r.status, src.id);
        const msg = r.status === 'unchanged' ? 'No new content since last check.' : `${r.first ? 'First run (backfill): ' : ''}Read ${r.items} item(s), ${r.created} new.`;
        db.prepare('insert into ingestion_log(source_id,ts,status,message,items) values(?,?,?,?,?)').run(src.id, ts, r.status, msg, r.items);
        all.push(...r.inserted);
      } catch (e) {
        db.prepare('update sources_config set last_run=?,last_status=?,last_error=? where id=?').run(ts, 'error', e.message, src.id);
        db.prepare('insert into ingestion_log(source_id,ts,status,message,items) values(?,?,?,?,0)').run(src.id, ts, 'error', e.message);
      }
    }
    prune(db);
    return all;
  } finally { running = false; }
}

// ---------- on-demand enrichment of one model (called when someone opens its page) ----------
// The listing API does not include the exact parameter count or last-modified date; the model's own endpoint does.
const enrichFailed = new Map();
async function enrichModel(db, id, f = fetch) {
  if (!String(id).startsWith('hf:')) return false;
  if ((enrichFailed.get(id) || 0) > Date.now()) return false;
  try {
    const name = id.slice(3);
    const r = await fetchRes('https://huggingface.co/api/models/' + name.split('/').map(encodeURIComponent).join('/'), f, hfHeaders());
    const j = JSON.parse(r.text);
    const st = j.safetensors && +j.safetensors.total > 0 ? +j.safetensors.total : null;
    const arch = j.config && Array.isArray(j.config.architectures) && j.config.architectures[0] ? String(j.config.architectures[0]) : null;
    const lic = j.cardData && typeof j.cardData.license === 'string' ? j.cardData.license : null;
    db.prepare(`update models set updated_at=coalesce(?,updated_at),param_count=coalesce(?,param_count),params_label=coalesce(?,params_label),
      params=coalesce(?,params),arch=coalesce(?,arch),license=coalesce(license,?),gated=?,detail_at=? where id=?`)
      .run(j.lastModified || null, st, st ? formatCount(st) : null, st ? formatCount(st) : null, arch, lic, j.gated ? 1 : 0, nowIso(), id);
    return true;
  } catch (e) {
    enrichFailed.set(id, Date.now() + 10 * 60000);
    return false;
  }
}

module.exports = { runAll, runSource, enrichModel, parseHuggingFace, parseGitHub, parseArxiv, parseFeed, describeModel };
