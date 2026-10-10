'use strict';
// Signalstack backend. Run: node server.js  (Node 22.5+, no npm install needed)
const http = require('http'), fs = require('fs'), path = require('path'), cr = require('crypto'), zlib = require('zlib');
const { openDb } = require('./lib/db');
const { COMPANIES, byId: COMPANY } = require('./lib/companies');
const byId = id => COMPANY[id] || null;
const { CATEGORY_LABELS } = require('./lib/classify');
const { scoreSignal, SIGNIFICANT } = require('./lib/score');
const { sendMail } = require('./mailer');
const { runAll, enrichModel } = require('./ingest');

const PORT = process.env.PORT || 3000;
const db = openDb(process.env.DB || 'signalstack.db');
const PUBLIC = path.join(__dirname, 'public');
// Version/date of the Terms + Privacy Policy. Bump when they change materially; it is shown on both pages and recorded at signup.
const LEGAL_VERSION = process.env.LEGAL_VERSION || '2026-10-06';

// ---------- small helpers ----------
const hashPw = (pw, salt = cr.randomBytes(16).toString('hex')) => salt + ':' + cr.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, h) => { const [s, k] = h.split(':'); return cr.timingSafeEqual(Buffer.from(k, 'hex'), cr.scryptSync(pw, s, 64)); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const likeOf = t => '%' + String(t).replace(/[\\%_]/g, '\\$&') + '%';
const pageOf = q => ({ limit: Math.min(Math.max(+q.get('limit') || 50, 1), 200), offset: Math.max(+q.get('offset') || 0, 0) });

// Per-IP rate limits: a tight one for auth, a loose one for everything else under /api.
const buckets = new Map();
function limited(key, max, ms = 60000) {
  const n = Date.now(), a = (buckets.get(key) || []).filter(t => n - t < ms);
  a.push(n); buckets.set(key, a);
  return a.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, a] of buckets) if (!a.some(t => n - t < 60000)) buckets.delete(k); }, 300000).unref();

const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function send(req, res, code, obj, h = {}) {
  let body = Buffer.from(JSON.stringify(obj));
  const head = { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY, ...h };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body); head['Content-Encoding'] = 'gzip'; head.Vary = 'Accept-Encoding'; }
  res.writeHead(code, head); res.end(body);
}
// Public reads may be cached briefly by the browser; anything per-user or write is never cached.
const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' };

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const fileCache = new Map();
function serveStatic(req, res, p) {
  const legal = p.replace(/\.html$/, '').replace(/\/$/, '');
  if (legal === '/privacy' || legal === '/terms') return serveLegal(res, legal.slice(1));
  let rel = decodeURIComponent(p);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // single-page app: every route is the shell
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  let st;
  try { st = fs.statSync(file); if (!st.isFile()) throw new Error('not a file'); } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const etag = '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
  const ext = path.extname(file);
  const head = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, ...SECURITY, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300, must-revalidate' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
  let c = fileCache.get(file);
  if (!c || c.etag !== etag) {
    const raw = fs.readFileSync(file);
    c = { etag, raw, gz: /\.(html|js|css|svg|json|webmanifest)$/.test(ext) ? zlib.gzipSync(raw) : null };
    fileCache.set(file, c);
  }
  if (c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { head['Content-Encoding'] = 'gzip'; head.Vary = 'Accept-Encoding'; res.writeHead(200, head); return res.end(c.gz); }
  res.writeHead(200, head); res.end(c.raw);
}
function serveLegal(res, name) {
  fs.readFile(path.join(PUBLIC, name + '.html'), 'utf8', (e, d) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const v = { OPERATOR_NAME: process.env.OPERATOR_NAME || '[set OPERATOR_NAME]', CONTACT_EMAIL: process.env.CONTACT_EMAIL || '[set CONTACT_EMAIL]', JURISDICTION: process.env.JURISDICTION || '[set JURISDICTION]', UPDATED: LEGAL_VERSION };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY });
    res.end(d.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? esc(v[k]) : m)));
  });
}

// ---------- data shaping ----------
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const WINDOWS = { '1h': '-1 hour', '6h': '-6 hours', '24h': '-1 day', '7d': '-7 days', '30d': '-30 days' };
// Hide events about models/papers an admin has not approved (only matters when REQUIRE_REVIEW=true).
const EV_OK = "(e.model_id is null or e.model_id in (select id from models where verified=1)) and not exists(select 1 from papers pp where pp.url=e.source and pp.verified=0)";
const SEV = { Normal: 0, Important: 1, Research: 1, Major: 2, Critical: 3 }, MIN = { All: 0, 'Major only': 2, 'Critical only': 3 };

function modelOut(m) {
  const co = m.company_id ? byId(m.company_id) : null;
  return {
    id: m.id, name: m.name, creator: m.creator || '', company_id: m.company_id || null, company: co ? co.name : null,
    released_at: m.released_at || m.rel || null, updated_at: m.updated_at || null, retrieved_at: m.retrieved_at || null,
    license: m.license || null, pipeline: m.pipeline || null, library: m.library || null, arch: m.arch || null,
    cats: (m.cats || '').split(',').filter(Boolean), params: m.params_label || null, param_count: m.param_count || null,
    gated: !!m.gated, likes: m.likes || 0, downloads: m.downloads || 0, url: m.url || null, arxiv: m.arxiv || null,
    verification: m.verification || 'community', source_type: m.source_type || 'huggingface', trend_rank: m.trend_rank || null,
    context_length: m.ctx_tokens || null, price_in: m.price_in ?? null, price_out: m.price_out ?? null, modality: m.modality || null,
  };
}
const M_SELECT = 'select m.* from models m';

const signalRows = (where, args, limit) => db.prepare(`select e.*, m.likes mlikes, m.downloads mdownloads, m.param_count mparams, m.released_at mreleased, m.company_id mcompany, m.name mname, m.verification mver, m.source_type msrc, m.ctx_tokens mctx
  from events e left join models m on m.id=e.model_id where ${EV_OK} ${where} order by e.ts desc limit ${limit}`).all(...args);

function signalOut(e) {
  const meta = parseJson(e.meta, {}), co = e.company_id ? byId(e.company_id) : null;
  const sc = scoreSignal({
    cat: e.cat, ts: e.ts, companyName: co && co.name, meta, mentions: meta.mentions, tier: meta.tier || (e.verification === 'verified' ? 'primary' : null),
    model: e.model_id ? { likes: e.mlikes, downloads: e.mdownloads, param_count: e.mparams, released_at: e.mreleased, company_id: e.mcompany, adoption: e.msrc !== 'openrouter', ctx_tokens: e.mctx } : null,
  });
  return {
    id: e.id, ts: e.ts, cat: e.cat, title: e.title || e.summary, summary: e.summary, detail: e.detail || null, url: e.source || null,
    source_type: e.source_type || null, verification: e.verification || 'community', retrieved_at: e.retrieved_at || null,
    company_id: e.company_id || null, company: co ? co.name : null, model_id: e.model_id || null, model: e.mname || null,
    score: sc.score, importance: sc.importance, parts: sc.parts, why: sc.why, meta,
  };
}

function signals(q) {
  const win = WINDOWS[q.get('window')] || WINDOWS['24h'];
  let where = ` and e.ts >= datetime('now','${win}')`; const args = [];
  const cat = q.get('cat'), co = q.get('company'), ver = q.get('verification');
  if (cat) { where += ' and e.cat=?'; args.push(cat); }
  if (co) { where += ' and e.company_id=?'; args.push(co); }
  if (ver) { where += ' and e.verification=?'; args.push(ver); }
  let items = signalRows(where, args, 600).map(signalOut);
  const min = +q.get('minScore') || 0;
  if (min) items = items.filter(s => s.score >= min);
  if (q.get('sort') === 'score') items.sort((a, b) => b.score - a.score || (a.ts < b.ts ? 1 : -1));
  return items;
}

function lastChecked() {
  return db.prepare("select max(last_run) t from sources_config where last_status in ('ok','unchanged')").get().t || null;
}

// ---------- notifications ----------
async function notify(event) {
  const al = db.prepare(`select a.*,u.email from alerts a join users u on u.id=a.user_id where a.channel like '%email%' and (a.org_id is null or a.org_id=?) and (a.cat is null or a.cat=?)`).all(event.org_id, event.cat);
  for (const a of al) {
    if (SEV[event.sev] < MIN[a.minsev]) continue;
    const r = await sendMail({ to: a.email, subject: `[Signalstack] ${event.sev}: ${event.summary}`, text: `${event.summary}\n\nSeverity: ${event.sev}\nCategory: ${event.cat}\nSource: ${event.source || ''}\n\nManage alerts: your Signalstack account.` });
    db.prepare('insert into notification_log(user_id,channel,status,error) values(?,?,?,?)').run(a.user_id, 'email', r.ok ? 'sent' : 'failed', r.error || null);
  }
}
function diffDocs(a, b) {
  const A = a.split(';;'), B = b.split(';;'), k = x => x.split(':')[0], ak = A.map(k), bk = B.map(k), out = [];
  B.forEach(l => { if (!ak.includes(k(l))) out.push({ t: 'added', text: l }); else { const o = A.find(x => k(x) === k(l)); if (o !== l) out.push({ t: 'changed', text: o + ' -> ' + l }); } });
  A.forEach(l => { if (!bk.includes(k(l))) out.push({ t: 'removed', text: l }); });
  return { changes: out, severity: out.some(c => c.t === 'removed') ? 'Breaking' : out.length ? 'Important' : 'Informational' };
}

// ---------- public data routes ----------
// Each handler receives { q, m (regex match) } and returns the JSON body (or throws {code,error}).
const fail = (code, error) => Object.assign(new Error(error), { code });
const routes = [];
const get = (re, fn) => routes.push(['GET', re, fn]);

get(/^\/api\/status$/, () => {
  const c = t => db.prepare('select count(*) c from ' + t).get().c;
  return {
    counts: { models: db.prepare('select count(*) c from models where verified=1').get().c, papers: db.prepare('select count(*) c from papers where verified=1').get().c,
      eventsWeek: db.prepare("select count(*) c from events e where e.ts>=datetime('now','-7 day') and " + EV_OK).get().c, benchmarks: c('benchmarks'), docs: c('doc_versions') },
    lastUpdate: lastChecked(),
    sources: db.prepare("select count(*) total,coalesce(sum(last_status in ('ok','unchanged')),0) healthy from sources_config where enabled=1").get(),
  };
});

// Home: what matters right now.
get(/^\/api\/now$/, () => {
  const day = signals(new URLSearchParams('window=24h')), week = signals(new URLSearchParams('window=7d'));
  const pool = day.length >= 5 ? day : week;
  const top = [...pool].sort((a, b) => b.score - a.score).slice(0, 6);
  const newModels = db.prepare(M_SELECT + " where m.verified=1 and m.company_id is not null order by coalesce(m.released_at,m.rel) desc limit 8").all().map(modelOut);
  const trending = db.prepare(M_SELECT + " where m.verified=1 and m.trend_rank is not null and m.trend_at>=datetime('now','-2 day') order by m.trend_rank limit 8").all().map(modelOut);
  const papers = db.prepare("select id,title,authors,published_at,date,url,entities,verification,retrieved_at from papers where verified=1 order by coalesce(published_at,date) desc limit 6").all()
    .map(p => ({ ...p, entities: parseJson(p.entities, []) }));
  return {
    top, newModels, trending, papers, lastChecked: lastChecked(),
    counts: { last24h: day.length, significant: day.filter(s => s.score >= SIGNIFICANT).length, models: db.prepare('select count(*) c from models where verified=1').get().c, papers: db.prepare('select count(*) c from papers where verified=1').get().c },
    usedWindow: pool === day ? '24h' : '7d',
  };
});

get(/^\/api\/signals$/, ({ q }) => {
  const all = signals(q), { limit, offset } = pageOf(q);
  return { total: all.length, items: all.slice(offset, offset + limit), lastChecked: lastChecked() };
});
get(/^\/api\/signals\/facets$/, () => ({
  cats: db.prepare(`select cat name,count(*) n from events e where ${EV_OK} and e.ts>=datetime('now','-30 day') group by cat order by n desc`).all(),
  companies: db.prepare(`select company_id id,count(*) n from events e where ${EV_OK} and company_id is not null and e.ts>=datetime('now','-30 day') group by company_id order by n desc`).all().map(r => ({ ...r, name: byId(r.id) ? byId(r.id).name : r.id })),
  verification: db.prepare(`select verification name,count(*) n from events e where ${EV_OK} and e.ts>=datetime('now','-30 day') group by verification`).all(),
}));

const MODEL_ORDER = {
  new: 'coalesce(m.released_at,m.rel) desc', popular: 'm.likes desc', downloads: 'm.downloads desc',
  params: 'm.param_count desc nulls last', trending: 'm.trend_rank is null, m.trend_rank',
};
get(/^\/api\/models$/, ({ q }) => {
  const { limit, offset } = pageOf(q), t = (q.get('q') || '').trim();
  const ids = (q.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
  const cat = (q.get('cat') || '').replace(/[^a-z]/g, ''), co = q.get('company'), lic = q.get('license');
  const where = ` where m.verified=1 and (?1 is null or m.name like ?1 escape '\\') and (?2 is null or m.id in (select value from json_each(?2)))
    and (?3 is null or m.cats like ?3) and (?4 is null or m.company_id=?4) and (?5 is null or m.license=?5)
    and (?6 is null or m.pipeline=?6) and (?7=0 or m.company_id is not null) and (?8 is null or m.source_type=?8)`;
  const a = [t ? likeOf(t) : null, ids.length ? JSON.stringify(ids) : null, cat ? '%,' + cat + ',%' : null, co || null, lic || null, q.get('task') || null, q.get('official') === '1' ? 1 : 0, ['huggingface', 'openrouter'].includes(q.get('source')) ? q.get('source') : null];
  const order = MODEL_ORDER[q.get('sort')] || MODEL_ORDER.new;
  return {
    total: db.prepare('select count(*) c from models m' + where).get(...a).c,
    items: db.prepare(M_SELECT + where + ` order by ${order}, m.rowid desc limit ?9 offset ?10`).all(...a, limit, offset).map(modelOut),
  };
});
// Facets are computed over all models so the category tabs and filters show real counts (empty categories can be hidden).
get(/^\/api\/models\/facets$/, () => {
  const rows = db.prepare("select cats,company_id,license,pipeline from models where verified=1").all(), cats = {}, cos = {}, lic = {}, tasks = {};
  for (const r of rows) {
    (r.cats || '').split(',').filter(Boolean).forEach(c => { cats[c] = (cats[c] || 0) + 1; });
    if (r.company_id) cos[r.company_id] = (cos[r.company_id] || 0) + 1;
    if (r.license) lic[r.license] = (lic[r.license] || 0) + 1;
    if (r.pipeline) tasks[r.pipeline] = (tasks[r.pipeline] || 0) + 1;
  }
  const top = (o, n) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, n).map(([name, n2]) => ({ name, n: n2 }));
  return {
    total: rows.length,
    cats: Object.keys(CATEGORY_LABELS).map(id => ({ id, label: CATEGORY_LABELS[id], n: cats[id] || 0 })),
    companies: Object.entries(cos).map(([id, n]) => ({ id, name: byId(id) ? byId(id).name : id, n })).sort((x, y) => y.n - x.n),
    licenses: top(lic, 12), tasks: top(tasks, 15),
  };
});
get(/^\/api\/models\/([^/]+)$/, async ({ m }) => {
  let id; try { id = decodeURIComponent(m[1]); } catch (e) { throw fail(400, 'Bad model id.'); }
  if (!db.prepare('select 1 from models where id=? and verified=1').get(id)) throw fail(404, 'Model not found.');
  // Fill in exact size, last-modified date and architecture from the model's own page, at most once an hour.
  const row = db.prepare('select detail_at from models where id=?').get(id);
  if (!row.detail_at || Date.now() - Date.parse(row.detail_at.replace(' ', 'T') + 'Z') > 36e5) await enrichModel(db, id).catch(() => {});
  const md = db.prepare('select * from models where id=?').get(id), out = modelOut(md);
  const sig = signalOut({ ...(db.prepare('select * from events where model_id=? order by ts desc limit 1').get(id) || { cat: 'Model Release', ts: md.released_at || md.rel, company_id: md.company_id, source: md.url }),
    mlikes: md.likes, mdownloads: md.downloads, mparams: md.param_count, mreleased: md.released_at, mcompany: md.company_id, msrc: md.source_type, mctx: md.ctx_tokens, model_id: id });
  const papers = (md.arxiv ? db.prepare("select id,title,authors,published_at,date,url,verification from papers where id=? and verified=1").all('arxiv:' + md.arxiv) : []);
  const similar = db.prepare(M_SELECT + ` where m.verified=1 and m.id!=? and ((?2 is not null and m.company_id=?2) or (?3 is not null and m.pipeline=?3)) order by m.likes desc limit 6`).all(id, md.company_id || null, md.pipeline || null).map(modelOut);
  return {
    model: out, signal: { score: sig.score, importance: sig.importance, parts: sig.parts, why: sig.why },
    company: md.company_id ? (({ id: cid, name, site }) => ({ id: cid, name, site }))(byId(md.company_id)) : null,
    events: db.prepare('select * from events where model_id=? order by ts desc limit 20').all(id).map(e => signalOut({ ...e, mlikes: md.likes, mdownloads: md.downloads, mparams: md.param_count, mreleased: md.released_at, mcompany: md.company_id, msrc: md.source_type, mctx: md.ctx_tokens })),
    results: db.prepare('select r.*,b.name bname,b.ver bver from results r join benchmarks b on b.id=r.bench_id where model_id=? order by date desc').all(id),
    papers, similar, detailFetched: !!md.detail_at,
  };
});

get(/^\/api\/companies$/, () => COMPANIES.map(c => ({
  id: c.id, name: c.name, site: c.site, official: c.hf.length > 0 || c.gh.length > 0,
  models: db.prepare('select count(*) c from models where company_id=?').get(c.id).c,
  signals30d: db.prepare("select count(*) c from events where company_id=? and ts>=datetime('now','-30 day')").get(c.id).c,
})));
get(/^\/api\/companies\/([\w-]+)$/, ({ m }) => {
  const c = byId(m[1]); if (!c) throw fail(404, 'Company not found.');
  return {
    company: { id: c.id, name: c.name, site: c.site, hf: c.hf, gh: c.gh },
    models: db.prepare(M_SELECT + ' where m.verified=1 and m.company_id=? order by coalesce(m.released_at,m.rel) desc limit 40').all(c.id).map(modelOut),
    signals: signals(new URLSearchParams('window=30d&company=' + c.id)).slice(0, 30),
  };
});

get(/^\/api\/papers$/, ({ q }) => {
  const t = (q.get('q') || '').trim(), { limit, offset } = pageOf(q), co = q.get('company');
  const w = " where p.verified=1 and (?1 is null or p.title like ?1 escape '\\' or p.tldr like ?1 escape '\\' or p.authors like ?1 escape '\\') and (?2 is null or p.entities like ?2)";
  const a = [t ? likeOf(t) : null, co ? '%"' + co + '"%' : null];
  return {
    total: db.prepare('select count(*) c from papers p' + w).get(...a).c,
    items: db.prepare('select p.* from papers p' + w + ' order by coalesce(p.published_at,p.date) desc limit ?3 offset ?4').all(...a, limit, offset)
      .map(x => ({ id: x.id, title: x.title, authors: x.authors, published_at: x.published_at || x.date, url: x.url, summary: x.tldr, category: x.arch, entities: parseJson(x.entities, []), verification: x.verification || 'verified', source_type: x.source_type || 'arxiv', retrieved_at: x.retrieved_at })),
  };
});
get(/^\/api\/events$/, ({ q }) => signals(new URLSearchParams('window=30d&' + q.toString())).slice(0, Math.min(+q.get('limit') || 50, 100)));
get(/^\/api\/benchmarks$/, () => db.prepare('select * from benchmarks').all());
get(/^\/api\/benchmarks\/([\w-]+)$/, ({ m }) => ({ benchmark: db.prepare('select * from benchmarks where id=?').get(m[1]), results: db.prepare('select r.*,mo.name mname from results r join models mo on mo.id=r.model_id where bench_id=? and mo.verified=1 order by score desc').all(m[1]) }));
get(/^\/api\/orgs$/, () => db.prepare('select * from orgs').all());
get(/^\/api\/docs$/, () => db.prepare('select version,date from doc_versions order by date desc').all());
get(/^\/api\/docs\/diff$/, ({ q }) => {
  const a = db.prepare('select lines from doc_versions where version=?').get(q.get('a')), b = db.prepare('select lines from doc_versions where version=?').get(q.get('b'));
  if (!a || !b) throw fail(404, 'Version not found.');
  return diffDocs(a.lines, b.lines);
});
// Search: results grouped by type so the page can show Models, Companies, Papers, Signals and Benchmarks separately.
get(/^\/api\/search$/, ({ q }) => {
  const t = (q.get('q') || '').trim(); if (t.length < 2) return {};
  const l = likeOf(t), lc = t.toLowerCase();
  return {
    models: db.prepare("select * from models m where m.verified=1 and (m.name like ?1 escape '\\' or m.creator like ?1 escape '\\' or m.pipeline like ?1 escape '\\') order by (m.company_id is not null) desc, m.likes desc limit 8").all(l).map(modelOut),
    companies: COMPANIES.filter(c => c.name.toLowerCase().includes(lc) || c.id.includes(lc)).map(c => ({ id: c.id, name: c.name })),
    papers: db.prepare("select id,title,authors,published_at,date,url from papers where verified=1 and (title like ?1 escape '\\' or authors like ?1 escape '\\') order by coalesce(published_at,date) desc limit 6").all(l),
    signals: db.prepare(`select e.id,e.ts,e.cat,coalesce(e.title,e.summary) title,e.source url,e.verification from events e where ${EV_OK} and (e.summary like ?1 escape '\\' or e.title like ?1 escape '\\') order by e.ts desc limit 6`).all(l),
    benchmarks: db.prepare("select id,name,ver from benchmarks where name like ?1 escape '\\' or cat like ?1 escape '\\' limit 6").all(l),
  };
});

// ---------- request handling ----------
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
  const ip = (process.env.TRUST_PROXY === 'true' && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress;
  if (!p.startsWith('/api')) {
    try { return serveStatic(req, res, p); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  }
  if (limited('api:' + ip, 300)) return send(req, res, 429, { error: 'Too many requests. Wait a minute and try again.' });
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    try {
      // public, read-only data
      if (req.method === 'GET') {
        for (const [, re, fn] of routes) {
          const m = p.match(re); if (!m) continue;
          return send(req, res, 200, await fn({ q, m }), PUBLIC_CACHE);
        }
      }
      const j = body ? JSON.parse(body) : {}, sid = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/)?.[1];
      const s = sid && db.prepare('select user_id from sessions where token=? and expires>?').get(sid, Date.now());
      const uid = s?.user_id, reply = (c, o, h) => send(req, res, c, o, { 'Cache-Control': 'no-store', ...h });
      const need = () => { if (!uid) { reply(401, { error: 'Please log in to continue.' }); return false; } return true; };
      const ck = t => `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${t ? 604800 : 0}${process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
      const authLimited = () => { if (limited('auth:' + ip, 10)) { reply(429, { error: 'Too many attempts. Wait a minute and try again.' }); return true; } return false; };
      const newSession = id => { const t = cr.randomBytes(24).toString('hex'); db.prepare('insert into sessions values(?,?,?)').run(t, id, Date.now() + 6048e5); return t; };

      if (p === '/api/signup' && req.method === 'POST') {
        if (authLimited()) return;
        const email = String(j.email || '').trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) return reply(400, { error: 'Enter a valid email address.' });
        if ((j.password || '').length < 8) return reply(400, { error: 'Password must be at least 8 characters.' });
        if (j.accept !== true) return reply(400, { error: 'You must accept the Terms & Conditions and Privacy Policy to create an account.' });
        if (db.prepare('select 1 from users where email=?').get(email)) return reply(409, { error: 'An account with this email already exists. Try logging in.' });
        const role = db.prepare('select count(*) c from users').get().c === 0 ? 'admin' : 'user';
        const r = db.prepare('insert into users(email,name,pw,role,accepted_at,accepted_version) values(?,?,?,?,?,?)').run(email, String(j.name || '').slice(0, 60), hashPw(j.password), role, new Date().toISOString(), LEGAL_VERSION);
        return reply(201, { ok: true }, { 'Set-Cookie': ck(newSession(r.lastInsertRowid)) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (authLimited()) return;
        const us = db.prepare('select * from users where email=?').get(String(j.email || '').trim().toLowerCase());
        if (!us || !checkPw(String(j.password || ''), us.pw)) return reply(401, { error: 'Email or password is incorrect.' });
        return reply(200, { ok: true }, { 'Set-Cookie': ck(newSession(us.id)) });
      }
      if (p === '/api/logout') { if (sid) db.prepare('delete from sessions where token=?').run(sid); return reply(200, { ok: true }, { 'Set-Cookie': ck('') }); }
      if (p === '/api/forgot-password' && req.method === 'POST') {
        if (authLimited()) return;
        const email = String(j.email || '').trim().toLowerCase();
        if (db.prepare('select 1 from users where email=?').get(email)) {
          const code = String(cr.randomInt(100000, 999999));
          db.prepare('insert into password_resets(email,code,expires) values(?,?,?) on conflict(email) do update set code=excluded.code,expires=excluded.expires').run(email, code, Date.now() + 600000);
          const r = await sendMail({ to: email, subject: 'Your Signalstack reset code', text: `Your password reset code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.` });
          // The code goes to the log only when email could not be sent, so an operator without email set up can still recover an account.
          if (!r.ok) console.log(`[password reset] Email not sent (${r.error}). Code for ${email}: ${code}`);
        }
        // Same response whether or not the account exists, so this cannot be used to discover which emails have accounts.
        return reply(200, { ok: true, message: 'If that email has an account, a reset code has been sent.' });
      }
      if (p === '/api/reset-password' && req.method === 'POST') {
        if (authLimited()) return;
        const email = String(j.email || '').trim().toLowerCase(), code = String(j.code || '').trim();
        const rr = db.prepare('select * from password_resets where email=?').get(email);
        if (!rr || rr.code !== code || rr.expires < Date.now()) return reply(400, { error: 'That code is invalid or has expired. Request a new one.' });
        if ((j.password || '').length < 8) return reply(400, { error: 'Password must be at least 8 characters.' });
        db.prepare('update users set pw=? where email=?').run(hashPw(j.password), email);
        db.prepare('delete from password_resets where email=?').run(email);
        db.prepare('delete from sessions where user_id=(select id from users where email=?)').run(email); // sign out other devices
        return reply(200, { ok: true });
      }
      if (p === '/api/me') { if (!need()) return; return reply(200, db.prepare('select id,email,name,role from users where id=?').get(uid)); }
      const isAdmin = uid && db.prepare('select role from users where id=?').get(uid)?.role === 'admin';
      const needAdmin = () => { if (!need()) return false; if (!isAdmin) { reply(403, { error: 'This area is for admins only.' }); return false; } return true; };

      // personal (login required)
      if (p === '/api/watchlist') {
        if (!need()) return;
        if (req.method === 'POST') db.prepare('insert or ignore into watchlist values(?,?)').run(uid, j.model_id);
        if (req.method === 'DELETE') db.prepare('delete from watchlist where user_id=? and model_id=?').run(uid, j.model_id);
        return reply(200, db.prepare('select model_id from watchlist where user_id=?').all(uid).map(r => r.model_id));
      }
      if (p === '/api/alerts') {
        if (!need()) return;
        if (req.method === 'POST') {
          if (!(j.minsev in MIN)) return reply(400, { error: 'Choose a severity level.' });
          db.prepare('insert into alerts(user_id,org_id,cat,minsev,channel) values(?,?,?,?,?)').run(uid, j.org_id || null, j.cat || null, j.minsev, j.channel === 'app+email' ? 'app+email' : 'app');
        }
        if (req.method === 'DELETE') db.prepare('delete from alerts where id=? and user_id=?').run(j.id, uid);
        const al = db.prepare('select * from alerts where user_id=?').all(uid), ev = db.prepare('select e.*,o.name org from events e join orgs o on o.id=e.org_id where ' + EV_OK + ' order by ts desc limit 300').all();
        return reply(200, { alerts: al, matches: ev.filter(e => al.some(a => (!a.org_id || a.org_id === e.org_id) && (!a.cat || a.cat === e.cat) && SEV[e.sev] >= MIN[a.minsev])) });
      }

      // admin
      if (p === '/api/admin/summary') {
        if (!needAdmin()) return;
        const c = (t, w = '') => db.prepare(`select count(*) c from ${t} ${w}`).get().c;
        return reply(200, {
          users: c('users'), models: c('models'), papers: c('papers'), events: c('events'), pendingModels: c('models', 'where verified=0'), pendingPapers: c('papers', 'where verified=0'),
          sources: db.prepare('select * from sources_config').all(), emailsSent: c('notification_log', "where status='sent'"), emailsFailed: c('notification_log', "where status='failed'"),
          emailConfigured: !!process.env.RESEND_API_KEY,
        });
      }
      if (p === '/api/admin/log') { if (!needAdmin()) return; return reply(200, db.prepare('select * from ingestion_log order by ts desc limit 40').all()); }
      if (p === '/api/admin/pending') { if (!needAdmin()) return; return reply(200, { models: db.prepare('select * from models where verified=0').all().map(modelOut), papers: db.prepare('select * from papers where verified=0').all() }); }
      if (p === '/api/admin/review' && req.method === 'POST') {
        if (!needAdmin()) return;
        const t = j.type === 'paper' ? 'papers' : 'models';
        if (j.action === 'approve') db.prepare(`update ${t} set verified=1 where id=?`).run(j.id); else db.prepare(`delete from ${t} where id=?`).run(j.id);
        return reply(200, { ok: true });
      }
      if (p === '/api/admin/review/bulk' && req.method === 'POST') {
        if (!needAdmin()) return;
        let count = 0;
        for (const t of j.type === 'paper' ? ['papers'] : j.type === 'model' ? ['models'] : ['models', 'papers']) {
          count += db.prepare(`select count(*) c from ${t} where verified=0`).get().c;
          if (j.action === 'approve') db.prepare(`update ${t} set verified=1 where verified=0`).run(); else db.prepare(`delete from ${t} where verified=0`).run();
        }
        return reply(200, { ok: true, count });
      }
      if (p === '/api/admin/sources' && req.method === 'POST') { if (!needAdmin()) return; db.prepare('update sources_config set enabled=? where id=?').run(j.enabled ? 1 : 0, j.id); return reply(200, { ok: true }); }
      if (p === '/api/admin/ingest/run' && req.method === 'POST') {
        if (!needAdmin()) return;
        ingestOnce();
        return reply(202, { ok: true, message: 'Ingestion started. Refresh the admin page in a few seconds for results.' });
      }
      if (p === '/api/admin/users') { if (!needAdmin()) return; return reply(200, db.prepare('select id,email,name,role,created from users order by id').all()); }
      if (p === '/api/admin/users/role' && req.method === 'POST') { if (!needAdmin()) return; db.prepare('update users set role=? where id=?').run(j.role === 'admin' ? 'admin' : 'user', j.id); return reply(200, { ok: true }); }
      if (p === '/api/admin/test-email' && req.method === 'POST') {
        if (!needAdmin()) return;
        const r = await sendMail({ to: j.to, subject: 'Signalstack test email', text: 'If you are reading this, your email settings are working correctly.' });
        return reply(r.ok ? 200 : 500, r);
      }
      reply(404, { error: 'Endpoint not found.' });
    } catch (e) {
      if (e.code && typeof e.code === 'number') return send(req, res, e.code, { error: e.message });
      if (e instanceof SyntaxError) return send(req, res, 400, { error: 'Request could not be read.' });
      console.error(e);
      send(req, res, 500, { error: 'Something went wrong on our side. Try again shortly.' });
    }
  });
}).listen(PORT, () => {
  console.log('Signalstack running at http://localhost:' + PORT);
  if (process.env.DISABLE_INGEST !== 'true') scheduleIngestion();
});

async function ingestOnce() {
  try {
    const inserted = await runAll(db);
    for (const x of inserted) { const e = db.prepare('select * from events where id=?').get(x.id); if (e) await notify(e).catch(err => console.error('notify failed:', err.message)); }
    if (inserted.length) console.log(`Ingestion: ${inserted.length} new event(s).`);
  } catch (e) { console.error('Ingestion run failed:', e.message); }
}
function scheduleIngestion() {
  const mins = Math.max(5, +process.env.INGEST_INTERVAL_MIN || 30);
  setTimeout(ingestOnce, 10000); // first run shortly after boot
  setInterval(ingestOnce, mins * 60000);
  console.log(`Ingestion scheduled every ${mins} minute(s). Set INGEST_INTERVAL_MIN to change.`);
}
