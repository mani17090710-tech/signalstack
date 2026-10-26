'use strict';
// Signalstack backend. Run: node server.js  (Node 22.5+, no npm install needed)
const http = require('http'), fs = require('fs'), path = require('path'), cr = require('crypto'), zlib = require('zlib');
const { openDb, SOURCES, SRC_VERSION } = require('./lib/db');
const srcRules = require('./lib/sources');
const dnsp = require('node:dns').promises;
const { backup } = require('node:sqlite');
const os = require('os');
const { COMPANIES, byId: COMPANY, isOfficialUrl } = require('./lib/companies');
const { LABEL: VER_LABEL, MEANING: VER_MEANING, STATUSES, evidenceFor } = require('./lib/verify');
const { resolveId } = require('./lib/canon');
const resets = require('./lib/reset');
const byId = id => COMPANY[id] || null;
const { CATEGORY_LABELS } = require('./lib/classify');
const { seriesOf } = require('./lib/family');
const { matters } = require('./lib/matters');
const pub = require('./lib/publicapi');
const digest = require('./lib/digest');
const { scoreSignal, SIGNIFICANT, WEIGHTS, parseTs } = require('./lib/score');
const { sendMail } = require('./mailer');
const { runAll, runOne, probe, isRunning, enrichModel } = require('./ingest');

const PORT = process.env.PORT || 3000;
const db = openDb(process.env.DB || 'signalstack.db');
const PUBLIC = path.join(__dirname, 'public');
// Version/date of the Terms + Privacy Policy. Bump when they change materially; it is shown on both pages and recorded at signup.
const LEGAL_VERSION = process.env.LEGAL_VERSION || '2026-10-06';

// ---------- small helpers ----------
const hashPw = (pw, salt = cr.randomBytes(16).toString('hex')) => salt + ':' + cr.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, h) => { const [s, k] = h.split(':'); return cr.timingSafeEqual(Buffer.from(k, 'hex'), cr.scryptSync(pw, s, 64)); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Words are matched in order with anything between them, so "qwen coder" finds Qwen3-Coder-27B and "meta wonder" finds meta/muse-wonder.
const likeOf = t => '%' + String(t).trim().split(/\s+/).slice(0, 6).map(w => w.replace(/[\\%_]/g, '\\$&')).join('%') + '%';
const pageOf = q => ({ limit: Math.min(Math.max(+q.get('limit') || 50, 1), 200), offset: Math.max(+q.get('offset') || 0, 0) });

// Per-IP rate limits: a tight one for auth, a loose one for everything else under /api.
const buckets = new Map();
function limited(key, max, ms = 60000) {
  const n = Date.now(), a = (buckets.get(key) || []).filter(t => n - t < ms);
  a.push(n); buckets.set(key, a);
  return a.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, a] of buckets) if (!a.some(t => n - t < 36e5)) buckets.delete(k); }, 300000).unref();

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

// Capabilities come only from what the sources state: Hugging Face tags/tasks, OpenRouter's supported parameters and modalities.
function capabilitiesOf(m) {
  const tags = (m.uses || '').split(',').filter(Boolean), out = new Set();
  for (const t of tags) if (['reasoning', 'tool-use'].includes(t)) out.add(t);
  if (m.pipeline) out.add(m.pipeline);
  if (m.modality) out.add(m.modality);
  return [...out].slice(0, 12);
}
function modelOut(m) {
  const co = m.company_id ? byId(m.company_id) : null, status = STATUSES.includes(m.verification) ? m.verification : 'unverified';
  return {
    id: m.id, name: m.name, creator: m.creator || '', company_id: m.company_id || null, company: co ? co.name : null,
    released_at: m.released_at || m.rel || null,
    // What the date means: an official release date only comes from the provider; catalogue and Hugging Face dates are when the entry appeared there.
    date_kind: m.verification === 'verified' ? 'released' : m.source_type === 'openrouter' ? 'listed' : 'published', updated_at: m.updated_at || null, retrieved_at: m.retrieved_at || null,
    license: m.license || null, pipeline: m.pipeline || null, library: m.library || null, arch: m.arch || null,
    cats: (m.cats || '').split(',').filter(Boolean), params: m.params_label || null, param_count: m.param_count || null,
    gated: !!m.gated, likes: m.likes || 0, downloads: m.downloads || 0, url: m.url || null, arxiv: m.arxiv || null,
    verification: status, verification_label: VER_LABEL[status], verified_at: m.verified_at || null,
    source_type: m.source_type || 'huggingface', trend_rank: m.trend_rank || null, open: !!m.open, listed: !m.delisted_at,
    model_ref: m.model_ref || null, provider_model_id: m.provider_model_id || null, provider_url: m.provider_url || null, openrouter_url: m.or_url || null,
    context_length: m.ctx_tokens || null, context_source: m.ctx_tokens ? m.ctx_source || null : null,
    price_in: m.price_in ?? null, price_out: m.price_out ?? null, price_source: m.price_in != null ? m.price_source || null : null,
    modality: m.modality || null, capabilities: capabilitiesOf(m),
  };
}
const M_SELECT = 'select m.* from models m';

const signalRows = (where, args, limit) => db.prepare(`select e.*, m.likes mlikes, m.downloads mdownloads, m.param_count mparams, m.released_at mreleased, m.company_id mcompany, m.name mname, m.verification mver, m.source_type msrc, m.ctx_tokens mctx
  from events e left join models m on m.id=e.model_id where ${EV_OK} ${where} order by e.ts desc limit ${limit}`).all(...args);

function signalOut(e) {
  const meta = parseJson(e.meta, {}), co = e.company_id ? byId(e.company_id) : null;
  const sc = scoreSignal({
    cat: e.cat, ts: e.ts, companyName: co && co.name, meta, mentions: meta.mentions, tier: meta.tier || (e.verification === 'verified' || e.verification === 'source_verified' ? 'primary' : null),
    model: e.model_id ? { likes: e.mlikes, downloads: e.mdownloads, param_count: e.mparams, released_at: e.mreleased, company_id: e.mcompany, adoption: !['openrouter', 'curated'].includes(e.msrc), ctx_tokens: e.mctx } : null,
  });
  return {
    id: e.id, ts: e.ts, cat: e.cat, title: e.title || e.summary, summary: e.summary, detail: e.detail || null, url: e.source || null,
    source_type: e.source_type || null, verification: e.verification || 'aggregator_listed', verification_label: VER_LABEL[e.verification] || VER_LABEL.aggregator_listed, retrieved_at: e.retrieved_at || null,
    company_id: e.company_id || null, company: co ? co.name : null, model_id: e.model_id || null, model: e.mname || null,
    score: sc.score, importance: sc.importance, parts: sc.parts, why: sc.why, meta,
    // True only when the link is on one of the lab's own domains (https), so the page can say "official site" without guessing.
    official_domain: !!(co && e.source && isOfficialUrl(COMPANY[co.id] || co, e.source)),
    // A short plain-language note for important signals, written by fixed rules from the facts above (null when there is nothing solid to say).
    matters: matters({ cat: e.cat, score: sc.score, companyName: co && co.name, tier: meta.tier || (e.verification === 'verified' || e.verification === 'source_verified' ? 'primary' : null), meta,
      mentionNames: (meta.mentions || []).map(id => (byId(id) || {}).name),
      model: e.model_id ? { likes: e.mlikes, downloads: e.mdownloads, param_count: e.mparams, ctx_tokens: e.mctx, adoption: !['openrouter', 'curated'].includes(e.msrc), hoursOld: e.mreleased ? (Date.now() - parseTs(e.mreleased)) / 36e5 : null } : null }),
  };
}

function signals(q) {
  const win = WINDOWS[q.get('window')] || WINDOWS['24h'];
  let where = ` and e.ts >= datetime('now','${win}')`; const args = [];
  const cat = q.get('cat'), co = q.get('company'), ver = q.get('verification');
  if (cat) { const cs = cat.split(',').slice(0, 4); where += ' and e.cat in (' + cs.map(() => '?').join(',') + ')'; args.push(...cs); }
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
    verification: Object.fromEntries(STATUSES.map(v => [v, db.prepare('select count(*) c from models where verified=1 and verification=?').get(v).c])),
    // The Signal Score rules, so every "Why this score" panel shows the real weights and thresholds instead of a copy that could drift.
    score: { weights: WEIGHTS, significant: SIGNIFICANT, major: 80 },
    // Said plainly so nothing downstream claims more than this: what the lists cover and what they do not.
    coverage: 'SignalStack tracks official lab releases and models with real traction on Hugging Face, models listed in the OpenRouter catalogue, and papers from selected arXiv categories. It does not claim to list every AI model or paper.',
    lastUpdate: lastChecked(),
    sources: db.prepare("select count(*) total,coalesce(sum(last_status in ('ok','unchanged')),0) healthy from sources_config where enabled=1").get(),
  };
});

// Home: what matters right now. Ranking is importance plus recency: the Signal Score (importance) is faded as an item ages, so a fresh 75
// outranks a day-old 85. Each model or source appears once, and items are grouped so the page reads like a short briefing.
const NOW_GROUPS = [['models', 'Models', ['Model Release', 'Trending'], 5], ['papers', 'Papers', ['Research'], 4], ['labs', 'Lab updates and releases', ['Announcement', 'Open Source'], 4]];
const rankOf = s => { const t = parseTs(s.ts), ageH = isNaN(t) ? 48 : Math.max(0, (Date.now() - t) / 36e5); return Math.round(s.score * (0.6 + 0.4 * Math.exp(-ageH / 18))); };
function ranked(list) {
  const seen = new Set(), out = [];
  for (const s of list.map(x => ({ ...x, rank: rankOf(x) })).sort((a, b) => b.rank - a.rank || (a.ts < b.ts ? 1 : -1))) {
    const key = s.model_id || s.url || 'e' + s.id; if (seen.has(key)) continue; seen.add(key); out.push(s);
  }
  return out;
}
// What is new from the labs, series and models a person follows or watches (shared by the Now page and the digest).
function watchingFor(uid, limit, windowDays = 30) {
  const fol = db.prepare('select kind,key from follows where user_id=?').all(uid), watched = new Set(db.prepare('select model_id from watchlist where user_id=?').all(uid).map(r => r.model_id));
  const labs = new Map(fol.filter(f => f.kind === 'lab' && byId(f.key)).map(f => [f.key, byId(f.key).name])), fam = new Map(), famLabel = new Map();
  for (const f of fol.filter(x => x.kind === 'family')) {
    const g = seriesOf(labRows(f.key.split(':')[0])).find(x => x.key === f.key); if (!g) continue;
    famLabel.set(f.key, `${byId(g.company_id).name} ${g.label}`); g.models.forEach(mm => fam.set(mm.id, f.key));
  }
  const pool = signals(new URLSearchParams('window=' + windowDays + 'd')).map(sg => {
    const because = watched.has(sg.model_id) ? 'You watch this model' : fam.has(sg.model_id) ? `You follow ${famLabel.get(fam.get(sg.model_id))}` : labs.has(sg.company_id) ? `You follow ${labs.get(sg.company_id)}` : null;
    return because ? { ...sg, because } : null;
  }).filter(Boolean);
  return { items: ranked(pool).slice(0, limit), total: pool.length, follows: { labs: [...labs].map(([id, name]) => ({ id, name })), families: [...famLabel].map(([key, label]) => ({ key, label })), models: watched.size } };
}

get(/^\/api\/now$/, () => {
  const day = signals(new URLSearchParams('window=24h')), week = signals(new URLSearchParams('window=7d'));
  const pool = day.length >= 5 ? day : week;
  const groups = NOW_GROUPS.map(([id, label, cats, n]) => {
    const inDay = ranked(day.filter(s => cats.includes(s.cat))), use = inDay.length >= 3 ? inDay : ranked(week.filter(s => cats.includes(s.cat)));
    return { id, label, cats, window: use === inDay ? '24h' : '7d', total: use.length, items: use.slice(0, n) };
  });
  // The lead story is the best-ranked item across the groups, and is not repeated inside its group.
  const best = groups.flatMap(g => g.items.map(i => [g, i])).sort((a, b) => b[1].rank - a[1].rank)[0];
  const lead = best ? best[1] : null; if (best) best[0].items = best[0].items.filter(i => i !== lead);
  const trending = db.prepare(M_SELECT + " where m.verified=1 and m.trend_rank is not null and m.trend_at>=datetime('now','-2 day') order by m.trend_rank limit 8").all().map(modelOut);
  return {
    lead, groups: groups.filter(g => g.items.length || g.total), top: ranked(pool).slice(0, 6), trending, lastChecked: lastChecked(),
    counts: { last24h: day.length, week: week.length, sources: db.prepare('select count(*) c from sources_config where enabled=1').get().c, significant: day.filter(s => s.score >= SIGNIFICANT).length, models: db.prepare('select count(*) c from models where verified=1').get().c, papers: db.prepare('select count(*) c from papers where verified=1').get().c },
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
  // Best first: confirmed by the publisher before catalogue listings, then models with their basic facts filled in (size or context, licence, date), newest first within each group.
  best: "case m.verification when 'verified' then 0 when 'source_verified' then 1 when 'aggregator_listed' then 2 else 3 end, ((m.param_count is not null or m.ctx_tokens is not null) + (m.license is not null) + (m.released_at is not null)) < 3, coalesce(m.released_at,m.rel) desc",
};
get(/^\/api\/models$/, ({ q }) => {
  const { limit, offset } = pageOf(q), t = (q.get('q') || '').trim();
  const ids = (q.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
  const cat = (q.get('cat') || '').replace(/[^a-z]/g, ''), co = q.get('company'), lic = q.get('license');
  const where = ` where m.verified=1 and (?1 is null or m.name like ?1 escape '\\') and (?2 is null or m.id in (select value from json_each(?2)))
    and (?3 is null or m.cats like ?3) and (?4 is null or m.company_id=?4) and (?5 is null or m.license=?5)
    and (?6 is null or m.pipeline=?6) and (?7=0 or m.company_id is not null) and (?8 is null or m.source_type=?8 or (?8='api' and m.source_type in ('openrouter','curated'))) and (?9 is null or m.verification=?9)`;
  const a = [t ? likeOf(t) : null, ids.length ? JSON.stringify(ids) : null, cat ? '%,' + cat + ',%' : null, co || null, lic || null, q.get('task') || null, q.get('official') === '1' ? 1 : 0, ['huggingface', 'openrouter', 'curated'].includes(q.get('source')) ? q.get('source') : q.get('source') === 'api' ? 'api' : null, STATUSES.includes(q.get('verification')) ? q.get('verification') : null];
  const order = MODEL_ORDER[q.get('sort')] || MODEL_ORDER.new;
  return {
    total: db.prepare('select count(*) c from models m' + where).get(...a).c,
    items: db.prepare(M_SELECT + where + ` order by ${order}, m.rowid desc limit ?10 offset ?11`).all(...a, limit, offset).map(modelOut),
  };
});
// Facets are computed over all models so the category tabs and filters show real counts (empty categories can be hidden).
get(/^\/api\/models\/facets$/, () => {
  const rows = db.prepare("select cats,company_id,license,pipeline,verification from models where verified=1").all(), cats = {}, cos = {}, lic = {}, tasks = {}, vers = {};
  for (const r of rows) {
    (r.cats || '').split(',').filter(Boolean).forEach(c => { cats[c] = (cats[c] || 0) + 1; });
    if (r.company_id) cos[r.company_id] = (cos[r.company_id] || 0) + 1;
    if (r.license) lic[r.license] = (lic[r.license] || 0) + 1;
    if (r.pipeline) tasks[r.pipeline] = (tasks[r.pipeline] || 0) + 1;
    vers[r.verification] = (vers[r.verification] || 0) + 1;
  }
  const top = (o, n) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, n).map(([name, n2]) => ({ name, n: n2 }));
  return {
    total: rows.length,
    cats: Object.keys(CATEGORY_LABELS).map(id => ({ id, label: CATEGORY_LABELS[id], n: cats[id] || 0 })),
    companies: Object.entries(cos).map(([id, n]) => ({ id, name: byId(id) ? byId(id).name : id, n })).sort((x, y) => y.n - x.n),
    licenses: top(lic, 12), tasks: top(tasks, 15),
    verification: STATUSES.map(id => ({ id, label: VER_LABEL[id], n: vers[id] || 0 })),
  };
});

// How a model compares with its peers, for the graphs on its page. Peers are models of the same kind (API catalogue models, or open models
// of the same task). Needs at least 8 peers with a value; otherwise the comparison is left out rather than guessed.
function peersFor(md) {
  const api = md.source_type === 'openrouter' || md.source_type === 'curated';
  const col = (c, where, args, floor) => db.prepare(`select ${c} v from models where verified=1 and ${c} is not null and ${c}>${floor} ${where}`).all(...args).map(r => +r.v).sort((a, b) => a - b);
  const stat = (vals, v) => {
    if (v == null || vals.length < 8) return null;
    const n = vals.length, below = vals.filter(x => x < v).length, equal = vals.filter(x => x === v).length;
    return { value: v, n, percentile: Math.round(100 * (below + 0.5 * equal) / n), median: vals[n >> 1], p25: vals[Math.floor(n * .25)], p75: vals[Math.floor(n * .75)], min: vals[0], max: vals[n - 1] };
  };
  if (api) {
    const w = "and source_type in ('openrouter','curated') and delisted_at is null";
    return { group: 'API models in the catalogue', price_in: md.price_in > 0 ? stat(col('price_in', w, [], 0), md.price_in) : null, price_out: md.price_out > 0 ? stat(col('price_out', w, [], 0), md.price_out) : null, context: stat(col('ctx_tokens', w, [], 0), md.ctx_tokens || null) };
  }
  const w = md.pipeline ? "and source_type='huggingface' and pipeline=?" : "and source_type='huggingface'", a = md.pipeline ? [md.pipeline] : [];
  return { group: md.pipeline ? `open models for “${md.pipeline}”` : 'open models', likes: stat(col('likes', w, a, -1), md.likes || 0), downloads: stat(col('downloads', w, a, -1), md.downloads || 0), size: md.param_count > 0 ? stat(col('param_count', w, a, 0), md.param_count) : null };
}
// Small card for the hover preview on Now and Signals: only what is already stored (no outside fetch), so it answers fast.
get(/^\/api\/models\/([^/]+)\/preview$/, ({ m }) => {
  let id; try { id = decodeURIComponent(m[1]); } catch (e) { throw fail(400, 'Bad model id.'); }
  id = resolveId(db, id) || id;
  const md = db.prepare('select * from models where id=? and verified=1').get(id);
  if (!md) throw fail(404, 'Model not found.');
  const out = modelOut(md);
  const sig = signalOut({ ...(db.prepare('select * from events where model_id=? order by ts desc limit 1').get(id) || { cat: 'Model Release', ts: md.released_at || md.rel, company_id: md.company_id, source: md.url }),
    mlikes: md.likes, mdownloads: md.downloads, mparams: md.param_count, mreleased: md.released_at, mcompany: md.company_id, msrc: md.source_type, mctx: md.ctx_tokens, model_id: id });
  return { model: out, signal: { score: sig.score, importance: sig.importance, why: sig.why.slice(0, 3) }, source_url: md.provider_url || md.url || null };
});
get(/^\/api\/models\/([^/]+)$/, async ({ m }) => {
  let id; try { id = decodeURIComponent(m[1]); } catch (e) { throw fail(400, 'Bad model id.'); }
  id = resolveId(db, id) || id; // an id from before two records were merged still finds the model
  if (!db.prepare('select 1 from models where id=? and verified=1').get(id)) throw fail(404, 'Model not found.');
  // Fill in exact size, last-modified date and architecture from the model's own page, at most once an hour.
  const row = db.prepare('select detail_at from models where id=?').get(id);
  if (!row.detail_at || Date.now() - Date.parse(row.detail_at.replace(' ', 'T') + 'Z') > 36e5) await enrichModel(db, id).catch(() => {});
  const md = db.prepare('select * from models where id=?').get(id), out = modelOut(md);
  const sig = signalOut({ ...(db.prepare('select * from events where model_id=? order by ts desc limit 1').get(id) || { cat: 'Model Release', ts: md.released_at || md.rel, company_id: md.company_id, source: md.url }),
    mlikes: md.likes, mdownloads: md.downloads, mparams: md.param_count, mreleased: md.released_at, mcompany: md.company_id, msrc: md.source_type, mctx: md.ctx_tokens, model_id: id });
  // Related research: only links a source states (model card, the provider's own entry, or the paper's abstract).
  const papers = db.prepare(`select mp.arxiv_id,mp.kind,mp.claimed_by,mp.url evidence_url,p.id pid,p.title,p.authors,p.published_at,p.date,p.url,p.source_role,p.last_checked
      from model_papers mp left join papers p on p.arxiv_id=mp.arxiv_id where mp.model_id=? order by p.published_at desc`).all(id)
    .map(r => ({ arxiv_id: r.arxiv_id, url: r.url || 'https://arxiv.org/abs/' + r.arxiv_id, title: r.title || null, authors: r.authors || null, published_at: r.published_at || r.date || null,
      in_collection: !!r.pid, source_role: r.pid ? r.source_role || 'primary' : 'secondary', last_checked: r.last_checked || null,
      evidence: { kind: r.kind, claimed_by: r.claimed_by, url: r.evidence_url } }));
  const similar = db.prepare(M_SELECT + ` where m.verified=1 and m.id!=? and ((?2 is not null and m.company_id=?2) or (?3 is not null and m.pipeline=?3)) order by m.likes desc limit 6`).all(id, md.company_id || null, md.pipeline || null).map(modelOut);
  const co = md.company_id ? byId(md.company_id) : null;
  // The model series this model belongs to (grouped by name, only among the same lab's models), for the timeline link on its page.
  const fam = md.company_id ? seriesOf(labRows(md.company_id)).find(g => g.models.some(x => x.id === id)) : null;
  const family = fam ? { key: fam.key, label: fam.label, company_id: fam.company_id, count: fam.models.length, first: fam.first, last: fam.last,
    generation: (fam.models.find(x => x.id === id) || {}).generation, generations: fam.generations.map(x => ({ label: x.label, first: x.first, count: x.models.length, current: x.models.some(y => y.id === id) })) } : null;
  return {
    family, model: out, signal: { score: sig.score, importance: sig.importance, parts: sig.parts, why: sig.why, weights: WEIGHTS }, peers: peersFor(md),
    company: co ? { id: co.id, name: co.name, site: co.site } : null,
    // Verification is reported separately from discovery: what the evidence says, then where the model was found.
    verification: { status: out.verification, label: VER_LABEL[out.verification], meaning: VER_MEANING[out.verification], last_verified: md.verified_at || null, official_url: md.provider_url || null, evidence: evidenceFor(db, id) },
    discovery: db.prepare('select source,ext_id,url,first_seen,last_seen from model_sources where model_id=? order by first_seen').all(id),
    events: db.prepare('select * from events where model_id=? order by ts desc limit 20').all(id).map(e => signalOut({ ...e, mlikes: md.likes, mdownloads: md.downloads, mparams: md.param_count, mreleased: md.released_at, mcompany: md.company_id, msrc: md.source_type, mctx: md.ctx_tokens })),
    results: db.prepare('select r.*,b.name bname,b.ver bver from results r join benchmarks b on b.id=r.bench_id where model_id=? order by date desc').all(id),
    papers, similar, detailFetched: !!md.detail_at,
  };
});

// One row per lab for the Labs page ("Lab Radar"): how recently each was active, what its latest signal was, and which kinds of source we watch for it.
const labActivity = () => new Map(db.prepare(`select e.company_id id, max(e.ts) last, coalesce(sum(e.ts>=datetime('now','-7 day')),0) n7, coalesce(sum(e.ts>=datetime('now','-30 day')),0) n30 from events e where e.company_id is not null and ${EV_OK} group by e.company_id`).all().map(r => [r.id, r]));
const labState = a => !a ? 'idle' : a.n7 > 0 ? 'active' : a.n30 > 0 ? 'quiet' : 'idle';
const labSources = c => [c.hf.length && 'Hugging Face', c.gh.length && 'GitHub', c.domains.length && 'Website', (c.or || []).length && 'OpenRouter'].filter(Boolean);
get(/^\/api\/companies$/, () => {
  const act = labActivity(), mc = new Map(db.prepare('select company_id id,count(*) n from models where company_id is not null group by company_id').all().map(r => [r.id, r.n]));
  const latest = db.prepare(`select coalesce(e.title,e.summary) title,e.cat from events e where e.company_id=? and ${EV_OK} order by e.ts desc limit 1`);
  return COMPANIES.map(c => {
    const a = act.get(c.id), l = a ? latest.get(c.id) : null;
    return { id: c.id, name: c.name, site: c.site, official: c.hf.length > 0 || c.gh.length > 0, sources: labSources(c), models: mc.get(c.id) || 0, signals30d: a ? a.n30 : 0, signals7d: a ? a.n7 : 0,
      state: labState(a), last_signal: a ? a.last : null, latest: l ? { title: l.title, cat: l.cat } : null };
  });
});
// A lab's models as plain rows, used to work out its model series.
const labRows = id => db.prepare('select m.* from models m where m.verified=1 and m.company_id=? and m.delisted_at is null').all(id);
const seriesBrief = g => ({ key: g.key, label: g.label, count: g.models.length, generations: g.generations.length, first: g.first, last: g.last, latest: modelOut(g.models[g.models.length - 1]) });
get(/^\/api\/companies\/([\w-]+)$/, ({ m }) => {
  const c = byId(m[1]); if (!c) throw fail(404, 'Company not found.');
  const papers = db.prepare("select * from papers where verified=1 and entities like ? order by coalesce(published_at,date) desc limit 8").all('%"' + c.id + '"%').map(x => paperOut(x, false)), act = labActivity().get(c.id);
  return {
    company: { id: c.id, name: c.name, site: c.site, hf: c.hf, gh: c.gh, domains: c.domains, openrouter: c.or || [] },
    models: db.prepare(M_SELECT + ' where m.verified=1 and m.company_id=? order by coalesce(m.released_at,m.rel) desc limit 40').all(c.id).map(modelOut),
    signals: signals(new URLSearchParams('window=30d&company=' + c.id)).slice(0, 30),
    series: seriesOf(labRows(c.id)).map(seriesBrief),
    papers,
    activity: { state: labState(act), last: act ? act.last : null, n7: act ? act.n7 : 0, n30: act ? act.n30 : 0 },
    // The newest items from any monitored source, at any age, so a quiet lab still shows what it last did.
    recent: signalRows(' and e.company_id=?', [c.id], 6).map(signalOut),
    sources: labSources(c),
    stats: { models: db.prepare('select count(*) c from models where verified=1 and company_id=?').get(c.id).c, papers: db.prepare("select count(*) c from papers where verified=1 and entities like ?").get('%"' + c.id + '"%').c, signals30d: act ? act.n30 : 0 },
  };
});
// The history of one model series: generations from oldest to newest, with every model in each.
get(/^\/api\/families\/([\w-]+)\/([\w.-]+)$/, ({ m }) => {
  const c = byId(m[1]); if (!c) throw fail(404, 'Lab not found.');
  const g = seriesOf(labRows(c.id)).find(x => x.key === c.id + ':' + m[2].toLowerCase()); if (!g) throw fail(404, 'No series with that name for this lab.');
  return {
    company: { id: c.id, name: c.name }, series: { key: g.key, label: g.label, count: g.models.length, first: g.first, last: g.last },
    generations: g.generations.map(x => ({ label: x.label, first: x.first, last: x.last, models: x.models.map(modelOut) })),
  };
});

const paperOut = (x, full) => ({
  id: x.id, arxiv_id: x.arxiv_id || String(x.id).replace(/^arxiv:/, ''), title: x.title, authors: x.authors, published_at: x.published_at || x.date, updated_at: x.updated_at || null, url: x.url,
  summary: (x.abstract || x.tldr || '').slice(0, full ? undefined : 600), abstract_truncated: !x.abstract && !!x.tldr, category: x.primary_cat || x.arch,
  categories: (x.categories || x.primary_cat || x.arch || '').split(',').filter(Boolean), entities: parseJson(x.entities, []),
  verification: x.verification || 'source_verified', verification_label: VER_LABEL[x.verification] || VER_LABEL.source_verified,
  source_type: x.source_type || 'arxiv', source_role: x.source_role || 'primary', retrieved_at: x.retrieved_at, last_checked: x.last_checked || x.retrieved_at || null,
});
// Labs named in papers, with how many papers name each (for the same search and time range), so the filter only offers labs that have something to show.
get(/^\/api\/papers\/labs$/, ({ q }) => {
  const t = (q.get('q') || '').trim(), days = Math.min(Math.max(+q.get('days') || 0, 0), 3650), since = days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : null;
  const rows = db.prepare(`select j.value id, count(*) n from papers p, json_each(case when json_valid(p.entities) then p.entities else '[]' end) j where p.verified=1
    and (?1 is null or p.title like ?1 escape '\\' or coalesce(p.abstract,p.tldr) like ?1 escape '\\' or p.authors like ?1 escape '\\' or p.arxiv_id like ?1 escape '\\') and (?2 is null or substr(coalesce(p.published_at,p.date),1,10) >= ?2) group by j.value order by n desc`).all(t ? likeOf(t) : null, since);
  const total = db.prepare("select count(*) c from papers p where p.verified=1 and (?1 is null or p.title like ?1 escape '\\' or coalesce(p.abstract,p.tldr) like ?1 escape '\\' or p.authors like ?1 escape '\\' or p.arxiv_id like ?1 escape '\\') and (?2 is null or substr(coalesce(p.published_at,p.date),1,10) >= ?2)").get(t ? likeOf(t) : null, since).c;
  return { total, labs: rows.filter(r => byId(r.id)).map(r => ({ id: r.id, name: byId(r.id).name, n: r.n })) };
});
get(/^\/api\/papers$/, ({ q }) => {
  const t = (q.get('q') || '').trim(), { limit, offset } = pageOf(q), co = q.get('company');
  const w = " where p.verified=1 and (?1 is null or p.title like ?1 escape '\\' or coalesce(p.abstract,p.tldr) like ?1 escape '\\' or p.authors like ?1 escape '\\' or p.arxiv_id like ?1 escape '\\') and (?2 is null or p.entities like ?2) and (?3 is null or ','||coalesce(p.categories,p.arch,'')||',' like ?3) and (?4 is null or substr(coalesce(p.published_at,p.date),1,10) >= ?4)";
  const cat = (q.get('category') || '').replace(/[^\w.-]/g, ''), days = Math.min(Math.max(+q.get('days') || 0, 0), 3650);
  const a = [t ? likeOf(t) : null, co ? '%"' + co + '"%' : null, cat ? '%,' + cat + ',%' : null, days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : null];
  return {
    total: db.prepare('select count(*) c from papers p' + w).get(...a).c, lastChecked: db.prepare("select max(coalesce(last_checked,retrieved_at)) t from papers where verified=1").get().t || lastChecked(),
    items: db.prepare('select p.* from papers p' + w + ' order by coalesce(p.published_at,p.date) desc limit ?5 offset ?6').all(...a, limit, offset).map(x => paperOut(x, true)),
  };
});
get(/^\/api\/papers\/(.+)$/, ({ m }) => {
  let id; try { id = decodeURIComponent(m[1]); } catch (e) { throw fail(400, 'Bad paper id.'); }
  const x = db.prepare('select * from papers where verified=1 and (id=? or arxiv_id=?)').get(id, id.replace(/^arxiv:/, ''));
  if (!x) throw fail(404, 'Paper not found.');
  const models = db.prepare('select m.*,mp.kind,mp.claimed_by,mp.url evidence_url from model_papers mp join models m on m.id=mp.model_id where mp.arxiv_id=? and m.verified=1').all(x.arxiv_id);
  return { paper: paperOut(x, true), models: models.map(r => ({ ...modelOut(r), evidence: { kind: r.kind, claimed_by: r.claimed_by, url: r.evidence_url } })) };
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
// ---------- public API v1 ----------
// A small, stable, read-only subset for other people's sites and tools. Open to any origin (CORS), cached for a minute, covered by the same
// per-IP rate limit as the rest of the API. Shapes live in lib/publicapi.js; the page at #api documents them.
const v1q = (q, keys) => new URLSearchParams([...q].filter(([k]) => keys.includes(k)));
const v1meta = (extra = {}) => ({ generated_at: new Date().toISOString(), attribution: pub.ATTRIBUTION, ...extra });
get(/^\/api\/v1$/, () => ({ name: 'Signalstack public API', version: 1, attribution: pub.ATTRIBUTION, endpoints: ['/api/v1/now', '/api/v1/signals', '/api/v1/models', '/api/v1/labs', '/feed.xml', '/embed/now'], docs: '/#api' }));
get(/^\/api\/v1\/signals$/, ({ q }) => {
  const all = signals(v1q(q, ['window', 'cat', 'company', 'verification', 'minScore', 'sort'])), { limit, offset } = pageOf(q);
  return { data: all.slice(offset, offset + limit).map(pub.v1Signal), meta: v1meta({ total: all.length, limit, offset }) };
});
get(/^\/api\/v1\/now$/, () => {
  const day = signals(new URLSearchParams('window=24h')), pool = day.length >= 5 ? day : signals(new URLSearchParams('window=7d'));
  return { data: ranked(pool).slice(0, 10).map(pub.v1Signal), meta: v1meta({ window: pool === day ? '24h' : '7d', ranking: 'Signal Score faded by age (importance plus recency)' }) };
});
get(/^\/api\/v1\/models$/, ({ q }) => {
  const list = routes.find(([, re]) => re.test('/api/models'))[2]({ q: v1q(q, ['q', 'company', 'cat', 'license', 'task', 'sort', 'source', 'verification', 'limit', 'offset']) }), { limit, offset } = pageOf(q);
  return { data: list.items.map(pub.v1Model), meta: v1meta({ total: list.total, limit, offset }) };
});
get(/^\/api\/v1\/labs$/, () => ({ data: COMPANIES.map(c => ({ id: c.id, name: c.name, site: c.site || null })), meta: v1meta() }));

// RSS feed and the embeddable widget (plain pages, not JSON).
const baseUrl = req => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${process.env.TRUST_PROXY === 'true' ? req.headers['x-forwarded-proto'] || 'https' : 'http'}://${req.headers.host}`;
function servePublic(req, res, p, q) {
  const base = baseUrl(req).replace(/\/$/, '');
  if (p === '/feed.xml') {
    const items = signals(v1q(q, ['window', 'cat', 'company', 'verification', 'minScore'])).slice(0, 50);
    const body = pub.rss(items, { base, title: 'Signalstack: AI releases and research', desc: 'New AI models, papers and releases, each linked to its original source.', self: base + '/feed.xml' });
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
    return res.end(body);
  }
  const day = signals(new URLSearchParams('window=24h')), pool = day.length >= 5 ? day : signals(new URLSearchParams('window=7d'));
  const items = ranked(pool).slice(0, Math.min(Math.max(+q.get('limit') || 5, 1), 10));
  // The widget is meant to be framed anywhere, so it drops the site-wide frame ban and allows nothing but its own stylesheet.
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'none'" });
  res.end(pub.embedHtml(items, { base, title: 'AI right now', theme: q.get('theme') }));
}

// ---------- admin: source management ----------
const BUILTIN = new Set(SOURCES.map(x => x[0])), srcInterval = () => Math.max(5, +process.env.INGEST_INTERVAL_MIN || 30);
// Every source with its health, what it watches and its last dozen runs. Worst first, so what needs attention is at the top.
function sourceRows(onlyId) {
  const hist = db.prepare('select ts,status,message,items from ingestion_log where source_id=? order by ts desc, id desc limit 12'), now = Date.now(), iv = srcInterval();
  const rows = db.prepare('select * from sources_config' + (onlyId ? ' where id=?' : '')).all(...(onlyId ? [onlyId] : []));
  return rows.map(src => {
    const recent = hist.all(src.id), h = srcRules.health(src, recent, now, iv), w = srcRules.watches(src), cfg = parseJson(src.config, {});
    return { id: src.id, kind: src.kind, kind_label: srcRules.KIND_LABEL[src.kind] || src.kind, label: src.label, enabled: !!src.enabled, builtin: BUILTIN.has(src.id), tier: cfg.tier || null, company: cfg.company || null,
      watch: w.text, watch_url: w.url, last_run: src.last_run, last_status: src.last_status, last_error: src.last_error, state: h.state, failures: h.failures, failing_since: h.failingSince, last_ok: h.lastOk,
      history: recent.map(r => ({ ts: r.ts, status: r.status, message: r.message, items: r.items })) };
  }).sort((a, b) => srcRules.ORDER[a.state] - srcRules.ORDER[b.state] || a.label.localeCompare(b.label));
}
const sourceSummary = rows => ({ total: rows.length, ...Object.fromEntries(['healthy', 'failing', 'stale', 'warning', 'new', 'paused'].map(k => [k, rows.filter(r => r.state === k).length])),
  lastRun: rows.reduce((m, r) => (r.last_run && r.last_run > m ? r.last_run : m), '') || null, intervalMin: srcInterval(), running: isRunning() });
// A feed address must resolve to a public server, never an internal one.
async function publicHost(host) { try { const r = await dnsp.lookup(host, { all: true }); return r.length > 0 && !r.some(x => srcRules.privateAddress(x.address)); } catch (e) { return false; } }
const buildSource = async b => {
  const row = srcRules.build(b, { companyIds: COMPANIES.map(c => c.id), version: SRC_VERSION });
  if (row.kind === 'feed' && !(await publicHost(new URL(row.config.url).hostname))) { const e = new Error('We could not reach that website, or it points to a private network.'); e.code = 400; throw e; }
  return row;
};

// ---------- digests (email per person, Telegram per channel) ----------
const siteBase = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const digestGroups = (freq, skip = new Set()) => {
  const win = freq === 'weekly' ? '7d' : '24h', pool = signals(new URLSearchParams('window=' + win)), use = pool.length >= 5 || freq === 'weekly' ? pool : signals(new URLSearchParams('window=7d'));
  return NOW_GROUPS.map(([, label, cats, n]) => ({ label, items: ranked(use.filter(x => cats.includes(x.cat) && x.score >= SIGNIFICANT - 20 && !skip.has(x.id))).slice(0, Math.min(n, 3)) }));
};
function digestFor(uid, freq) {
  const u = db.prepare('select name from users where id=?').get(uid) || {}, pr = db.prepare('select token from digest_prefs where user_id=?').get(uid) || {};
  const watch = watchingFor(uid, 4, freq === 'weekly' ? 7 : 2).items;
  const groups = digestGroups(freq, new Set(watch.map(x => x.id)));
  return { ...digest.build({ freq, groups, watching: watch, base: siteBase(), unsubscribeUrl: `${siteBase()}/digest/unsubscribe?t=${pr.token || ''}`, name: u.name || '' }) };
}
async function sendDigest(uid, freq, { force = false } = {}) {
  const u = db.prepare('select email from users where id=?').get(uid); if (!u) return { ok: false, error: 'No such account.' };
  const d = digestFor(uid, freq); if (!d.count && !force) return { ok: true, skipped: true };
  const tok = db.prepare('select token from digest_prefs where user_id=?').get(uid)?.token;
  return sendMail({ to: u.email, subject: d.subject, text: d.text, html: d.html, headers: tok ? { 'List-Unsubscribe': `<${siteBase()}/digest/unsubscribe?t=${tok}>` } : undefined });
}
async function digestTick() {
  try {
    const now = Date.now();
    for (const pr of db.prepare("select * from digest_prefs where freq in ('daily','weekly')").all()) {
      if (!digest.due(pr, now)) continue;
      // Stamp first, so a slow or failing send is never repeated every tick; a failure is logged and the next slot tries again.
      db.prepare("update digest_prefs set last_sent=datetime('now') where user_id=?").run(pr.user_id);
      const r = await sendDigest(pr.user_id, pr.freq);
      db.prepare('insert into notification_log(user_id,channel,status,error) values(?,?,?,?)').run(pr.user_id, 'digest', r.ok ? (r.skipped ? 'skipped' : 'sent') : 'failed', r.error || null);
    }
    await telegramTick(now);
  } catch (e) { console.error('Digest run failed:', e.message); }
}
// One daily post to a Telegram channel or group, only when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. TELEGRAM_HOUR_UTC picks the hour (default 4).
async function telegramTick(now) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID; if (!tok || !chat) return;
  const hour = Math.min(Math.max(+process.env.TELEGRAM_HOUR_UTC || 4, 0), 23), slot = digest.lastSlot({ freq: 'daily', hour, tz_offset: 0 }, now);
  const last = db.prepare("select v from digest_state where k='telegram_last'").get();
  if (now - slot > 36e5 * 12 || (last && +last.v >= slot)) return;
  db.prepare("insert into digest_state(k,v) values('telegram_last',?) on conflict(k) do update set v=excluded.v").run(String(now));
  const items = digestGroups('daily').flatMap(g => g.items).sort((a, b) => b.rank - a.rank); if (!items.length) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: digest.telegram(items, siteBase(), now), parse_mode: 'HTML', disable_web_page_preview: true }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) console.error('Telegram digest failed: HTTP', r.status);
  } catch (e) { console.error('Telegram digest failed:', e.message); }
}
function serveUnsubscribe(res, q) {
  const t = String(q.get('t') || ''), r = /^[a-f0-9]{32}$/.test(t) ? db.prepare("update digest_prefs set freq='off' where token=?").run(t) : { changes: 0 };
  const msg = r.changes ? 'You will not get these emails any more. You can turn them back on any time in Signalstack, under You.' : 'This link is not valid any more. You can manage emails in Signalstack, under You.';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signalstack emails</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#07101f;color:#e6edf7;font:16px/1.5 system-ui,sans-serif"><main style="max-width:420px;padding:24px"><h1 style="font-size:22px;margin:0 0 8px">${r.changes ? 'Unsubscribed' : 'Link expired'}</h1><p style="color:#9fb0cc">${msg}</p><a href="/" style="color:#22d3ee">Back to Signalstack</a></main>`);
}

// Search: results grouped by type so the page can show Models, Companies, Papers, Signals and Benchmarks separately.
get(/^\/api\/search$/, ({ q }) => {
  const t = (q.get('q') || '').trim().slice(0, 100); if (t.length < 2) return {};
  const lc = t.toLowerCase(), toks = lc.split(/\s+/).filter(Boolean).slice(0, 6);
  // Every word must appear somewhere in the record, in any order ("wonder meta" finds meta/muse-wonder).
  const all = cols => ({ sql: toks.map(() => '(' + cols.map(c => `${c} like ? escape '\\'`).join(' or ') + ')').join(' and '), args: toks.flatMap(w => cols.map(() => likeOf(w))) });
  // Every result says what kind of thing it is (type) and how it is sourced (verification), so nothing looks more certain than it is.
  const tag = (type, list) => list.map(x => ({ type, ...x }));
  const mw = all(['m.name', 'm.creator', 'm.pipeline', 'm.provider_model_id', 'm.model_ref']), pw = all(['title', 'authors', 'arxiv_id']), ew = all(['e.summary', 'e.title']);
  return {
    models: tag('model', db.prepare(`select * from models m where m.verified=1 and ${mw.sql} order by (lower(m.name)=?) desc, (lower(m.name) like ? escape '\\') desc, (m.verification='verified') desc, (m.company_id is not null) desc, m.likes desc limit 8`).all(...mw.args, lc, likeOf(lc).slice(1)).map(modelOut)),
    companies: tag('company', COMPANIES.filter(c => toks.every(w => (c.name + ' ' + c.id).toLowerCase().includes(w))).map(c => ({ id: c.id, name: c.name, site: c.site, official: c.hf.length > 0 || c.gh.length > 0, verification: 'source_verified', verification_label: 'Reference list', models: db.prepare('select count(*) c from models where company_id=? and verified=1').get(c.id).c }))),
    papers: tag('paper', db.prepare(`select * from papers where verified=1 and ${pw.sql} order by coalesce(published_at,date) desc limit 6`).all(...pw.args).map(x => paperOut(x, false))),
    signals: tag('signal', db.prepare(`select e.id,e.ts,e.cat,coalesce(e.title,e.summary) title,e.source url,e.verification,e.source_type,e.model_id from events e where ${EV_OK} and ${ew.sql} order by e.ts desc limit 6`).all(...ew.args).map(x => ({ ...x, verification_label: VER_LABEL[x.verification] || VER_LABEL.aggregator_listed }))),
    benchmarks: tag('benchmark', db.prepare("select id,name,ver from benchmarks where name like ?1 escape '\\' or cat like ?1 escape '\\' limit 6").all(likeOf(t))),
  };
});

// ---------- request handling ----------
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
  const ip = (process.env.TRUST_PROXY === 'true' && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress;
  if (p === '/digest/unsubscribe') { if (limited('unsub:' + ip, 30)) { res.writeHead(429); return res.end('Too many requests.'); } return serveUnsubscribe(res, q); }
  if (p === '/digest/preview') {
    // The email as it would arrive. It uses inline styles (as email must), so it gets its own policy and may be framed only by this site.
    const sid = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/)?.[1], ss = sid && db.prepare('select user_id from sessions where token=? and expires>?').get(sid, Date.now());
    const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'" };
    if (!ss) { res.writeHead(401, h); return res.end('Log in to preview.'); }
    res.writeHead(200, h); return res.end(digestFor(ss.user_id, q.get('freq') === 'weekly' ? 'weekly' : 'daily').html);
  }
  if (p === '/feed.xml' || p === '/embed/now') {
    if (limited('api:' + ip, 300)) { res.writeHead(429, { 'Content-Type': 'text/plain' }); return res.end('Too many requests. Wait a minute and try again.'); }
    try { return servePublic(req, res, p, q); } catch (e) { console.error(e); res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Something went wrong.'); }
  }
  if (!p.startsWith('/api')) {
    try { return serveStatic(req, res, p); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  }
  if (req.method === 'OPTIONS' && p.startsWith('/api/v1')) { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' }); return res.end(); }
  if (limited('api:' + ip, 300)) return send(req, res, 429, { error: 'Too many requests. Wait a minute and try again.' }, p.startsWith('/api/v1') ? { 'Access-Control-Allow-Origin': '*' } : {});
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    try {
      // public, read-only data
      if (req.method === 'GET') {
        for (const [, re, fn] of routes) {
          const m = p.match(re); if (!m) continue;
          return send(req, res, 200, await fn({ q, m }), p.startsWith('/api/v1') ? { ...PUBLIC_CACHE, 'Access-Control-Allow-Origin': '*' } : PUBLIC_CACHE);
        }
      }
      const j = body ? JSON.parse(body) : {}, sid = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/)?.[1];
      const s = sid && db.prepare('select user_id from sessions where token=? and expires>?').get(sid, Date.now());
      const uid = s?.user_id, reply = (c, o, h) => send(req, res, c, o, { 'Cache-Control': 'no-store', ...h });
      // ADMIN_EMAILS (comma-separated) lists accounts that are always admins, so a fresh database does not depend on who signs up first.
      const adminEmails = () => String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
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
        const role = db.prepare('select count(*) c from users').get().c === 0 || adminEmails().includes(email) ? 'admin' : 'user';
        const r = db.prepare('insert into users(email,name,pw,role,accepted_at,accepted_version) values(?,?,?,?,?,?)').run(email, String(j.name || '').slice(0, 60), hashPw(j.password), role, new Date().toISOString(), LEGAL_VERSION);
        return reply(201, { ok: true }, { 'Set-Cookie': ck(newSession(r.lastInsertRowid)) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (authLimited()) return;
        const us = db.prepare('select * from users where email=?').get(String(j.email || '').trim().toLowerCase());
        if (!us || !checkPw(String(j.password || ''), us.pw)) return reply(401, { error: 'Email or password is incorrect.' });
        if (us.role !== 'admin' && adminEmails().includes(us.email)) db.prepare("update users set role='admin' where id=?").run(us.id);
        return reply(200, { ok: true }, { 'Set-Cookie': ck(newSession(us.id)) });
      }
      if (p === '/api/logout') { if (sid) db.prepare('delete from sessions where token=?').run(sid); return reply(200, { ok: true }, { 'Set-Cookie': ck('') }); }
      if (p === '/api/forgot-password' && req.method === 'POST') {
        if (authLimited()) return;
        const email = String(j.email || '').trim().toLowerCase();
        if (db.prepare('select 1 from users where email=?').get(email)) {
          const code = resets.issue(db, email);
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
        if (!resets.verify(db, email, code)) return reply(400, { error: 'That code is invalid or has expired. Request a new one.' });
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
      // Collections: save signals, models and papers, and sort them into named lists.
      if (p === '/api/collections' || p.startsWith('/api/saved')) {
        if (!need()) return;
        const SRC_LABEL = { huggingface: 'Hugging Face', openrouter: 'OpenRouter', curated: 'Official', arxiv: 'arXiv', 'github-release': 'GitHub', blog: 'Blog' };
        const first = () => { let c = db.prepare('select id from collections where user_id=? order by id limit 1').get(uid); if (!c) c = { id: Number(db.prepare("insert into collections(user_id,name) values(?,'Saved')").run(uid).lastInsertRowid) }; return c.id; };
        const mine = id => db.prepare('select id from collections where id=? and user_id=?').get(+id, uid);
        const state = () => { first(); return { collections: db.prepare('select c.id,c.name,(select count(*) from saved s where s.collection_id=c.id) n from collections c where c.user_id=? order by c.id').all(uid),
          saved: db.prepare("select distinct kind||'|'||ref k from saved where user_id=? limit 3000").all(uid).map(r => r.k) }; };
        const snap = (kind, ref) => {
          if (kind === 'signal') { const e = db.prepare(`select e.id,coalesce(e.title,e.summary) t,e.source,e.source_type from events e where e.id=? and ${EV_OK}`).get(+ref); return e && { title: e.t, url: e.source, source: SRC_LABEL[e.source_type] || 'Signal', ref: String(e.id) }; }
          if (kind === 'model') { const m = db.prepare('select id,name,source_type from models where id=? and verified=1').get(ref); return m && { title: String(m.name).split('/').pop(), url: null, source: SRC_LABEL[m.source_type] || 'Model', ref: m.id }; }
          if (kind === 'paper') { const x = db.prepare('select arxiv_id,id,title,url from papers where (arxiv_id=? or id=?) and verified=1').get(ref, ref); return x && { title: x.title, url: x.url, source: 'arXiv', ref: x.arxiv_id || x.id }; }
          return null;
        };
        if (p === '/api/collections') {
          if (req.method === 'POST') {
            const name = String(j.name || '').trim().slice(0, 40); if (!name) return reply(400, { error: 'Give the collection a name.' });
            if (db.prepare('select count(*) c from collections where user_id=?').get(uid).c >= 30) return reply(400, { error: 'You have reached 30 collections.' });
            try { db.prepare('insert into collections(user_id,name) values(?,?)').run(uid, name); } catch (e) { return reply(400, { error: 'You already have a collection with that name.' }); }
          } else if (req.method === 'DELETE') {
            if (!mine(j.id)) return reply(404, { error: 'Collection not found.' });
            if (+j.id === first()) return reply(400, { error: 'Your first collection cannot be deleted.' });
            db.prepare('delete from collections where id=? and user_id=?').run(+j.id, uid);
          }
          return reply(200, state());
        }
        if (p === '/api/collections/rename' && req.method === 'POST') {
          const name = String(j.name || '').trim().slice(0, 40); if (!name || !mine(j.id)) return reply(400, { error: 'Give the collection a name.' });
          try { db.prepare('update collections set name=? where id=? and user_id=?').run(name, +j.id, uid); } catch (e) { return reply(400, { error: 'You already have a collection with that name.' }); }
          return reply(200, state());
        }
        if (p === '/api/saved/where' && req.method === 'GET') return reply(200, { collections: db.prepare('select collection_id id from saved where user_id=? and kind=? and ref=?').all(uid, String(q.get('kind') || ''), String(q.get('ref') || '')).map(r => r.id) });
        if (p === '/api/saved' && req.method === 'GET') {
          const cid = q.get('collection') ? +q.get('collection') : first(); if (!mine(cid)) return reply(404, { error: 'Collection not found.' });
          return reply(200, { collection: cid, items: db.prepare('select kind,ref,title,url,source,saved_at from saved where user_id=? and collection_id=? order by id desc limit 300').all(uid, cid) });
        }
        if (p === '/api/saved' && (req.method === 'POST' || req.method === 'DELETE')) {
          const kind = String(j.kind || ''), ref = String(j.ref || '').slice(0, 200), cid = j.collection_id ? +j.collection_id : first();
          if (!mine(cid)) return reply(404, { error: 'Collection not found.' });
          if (req.method === 'POST') {
            const sn = snap(kind, ref); if (!sn) return reply(404, { error: 'That item is no longer available.' });
            if (db.prepare('select count(*) c from saved where user_id=?').get(uid).c >= 3000) return reply(400, { error: 'You have saved the maximum number of items.' });
            db.prepare('insert or ignore into saved(user_id,collection_id,kind,ref,title,url,source) values(?,?,?,?,?,?,?)').run(uid, cid, kind, sn.ref, sn.title, sn.url, sn.source);
          } else if (j.collection_id) db.prepare('delete from saved where user_id=? and collection_id=? and kind=? and ref=?').run(uid, cid, kind, ref);
          else db.prepare('delete from saved where user_id=? and kind=? and ref=?').run(uid, kind, ref);
          return reply(200, state());
        }
        if (p === '/api/saved/move' && req.method === 'POST') {
          if (!mine(j.from) || !mine(j.to)) return reply(404, { error: 'Collection not found.' });
          db.prepare('update or ignore saved set collection_id=? where user_id=? and collection_id=? and kind=? and ref=?').run(+j.to, uid, +j.from, String(j.kind), String(j.ref));
          db.prepare('delete from saved where user_id=? and collection_id=? and kind=? and ref=?').run(uid, +j.from, String(j.kind), String(j.ref));
          return reply(200, state());
        }
        return reply(404, { error: 'Not found.' });
      }
      // Follow a lab or a model series; the Now page shows what is new from everything you follow or watch.
      if (p === '/api/follows') {
        if (!need()) return;
        if (req.method === 'POST' || req.method === 'DELETE') {
          const kind = String(j.kind || ''), key = String(j.key || '').slice(0, 80);
          const valid = kind === 'lab' ? !!byId(key) : kind === 'family' ? /^[\w-]+:[\w.-]+$/.test(key) && !!byId(key.split(':')[0]) : false;
          if (!valid) return reply(400, { error: 'Unknown lab or series.' });
          if (req.method === 'POST') {
            if (db.prepare('select count(*) c from follows where user_id=?').get(uid).c >= 200) return reply(400, { error: 'You are following the maximum number of labs and series.' });
            db.prepare('insert or ignore into follows(user_id,kind,key) values(?,?,?)').run(uid, kind, key);
          } else db.prepare('delete from follows where user_id=? and kind=? and key=?').run(uid, kind, key);
        }
        return reply(200, db.prepare('select kind,key from follows where user_id=? order by created').all(uid));
      }
      if (p === '/api/watching') {
        if (!need()) return;
        return reply(200, watchingFor(uid, 8));
      }
      // Email digest preferences, a preview of what would be sent, and a "send me one now" test (limited to a few per hour).
      if (p === '/api/digest') {
        if (!need()) return;
        if (req.method === 'POST') {
          const freq = ['off', 'daily', 'weekly'].includes(j.freq) ? j.freq : 'off', hour = Math.min(Math.max(parseInt(j.hour, 10) || 0, 0), 23), tz = Math.min(Math.max(parseInt(j.tz_offset, 10) || 0, -720), 840);
          // last_sent is stamped now, so turning the digest on never sends one immediately; the first one arrives at the next chosen hour.
          db.prepare("insert into digest_prefs(user_id,freq,hour,tz_offset,last_sent,token) values(?,?,?,?,datetime('now'),?) on conflict(user_id) do update set freq=excluded.freq,hour=excluded.hour,tz_offset=excluded.tz_offset,last_sent=case when digest_prefs.freq=excluded.freq then digest_prefs.last_sent else excluded.last_sent end")
            .run(uid, freq, hour, tz, cr.randomBytes(16).toString('hex'));
          db.prepare('update digest_prefs set token=coalesce(nullif(token,\'\'),?) where user_id=?').run(cr.randomBytes(16).toString('hex'), uid);
        }
        const pr = db.prepare('select freq,hour,tz_offset from digest_prefs where user_id=?').get(uid) || { freq: 'off', hour: 8, tz_offset: 0 };
        return reply(200, { ...pr, emailConfigured: !!process.env.RESEND_API_KEY, telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) });
      }
      if (p === '/api/digest/preview') {
        if (!need()) return;
        const d = digestFor(uid, j.freq === 'weekly' || q.get('freq') === 'weekly' ? 'weekly' : 'daily');
        return reply(200, { subject: d.subject, html: d.html, count: d.count });
      }
      if (p === '/api/digest/test' && req.method === 'POST') {
        if (!need()) return;
        if (limited('digest-test:' + uid, 3, 36e5)) return reply(429, { error: 'You can send up to 3 test emails an hour. Try again later.' });
        if (!process.env.RESEND_API_KEY) return reply(400, { error: 'Email is not set up on this server yet, so a test cannot be sent. The preview shows what it would look like.' });
        if (!db.prepare('select token from digest_prefs where user_id=?').get(uid)) db.prepare("insert into digest_prefs(user_id,freq,token) values(?,'off',?)").run(uid, cr.randomBytes(16).toString('hex'));
        const r = await sendDigest(uid, j.freq === 'weekly' ? 'weekly' : 'daily', { force: true });
        return reply(r.ok ? 200 : 502, r.ok ? { ok: true } : { error: 'The email could not be sent: ' + r.error });
      }
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
            // Admin-only database backup
      if (p === '/api/admin/backup' && req.method === 'GET') {
        if (!needAdmin()) return;

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `signalstack-backup-${stamp}.sqlite`;
        const backupPath = path.join(
          os.tmpdir(),
          `signalstack-${cr.randomBytes(12).toString('hex')}.sqlite`
        );

        try {
          await backup(db, backupPath);

          res.writeHead(200, {
            'Content-Type': 'application/vnd.sqlite3',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store'
          });

          const stream = fs.createReadStream(backupPath);

          stream.on('error', () => {
            res.destroy();
          });

          stream.on('close', () => {
            fs.promises.unlink(backupPath).catch(() => {});
          });

          res.on('close', () => {
            fs.promises.unlink(backupPath).catch(() => {});
          });

          stream.pipe(res);
        } catch (err) {
          fs.promises.unlink(backupPath).catch(() => {});
          console.error('Database backup failed:', err.message);

          if (!res.headersSent) {
            return reply(500, { error: 'Database backup failed.' });
          }
          res.destroy();
        }

        return;
      }
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
      // Source management: list with health, pause / resume, refresh now, test an address, add, remove.
      if (p === '/api/admin/sources' && req.method === 'GET') { if (!needAdmin()) return; const rows = sourceRows(); return reply(200, { summary: sourceSummary(rows), sources: rows }); }
      if (p === '/api/admin/sources/toggle' && req.method === 'POST') {
        if (!needAdmin()) return;
        if (!db.prepare('select 1 from sources_config where id=?').get(j.id)) return reply(404, { error: 'No such source.' });
        db.prepare('update sources_config set enabled=? where id=?').run(j.enabled ? 1 : 0, j.id);
        return reply(200, { ok: true, source: sourceRows(j.id)[0] });
      }
      if (p === '/api/admin/sources/refresh' && req.method === 'POST') {
        if (!needAdmin()) return;
        if (limited('src-refresh:' + uid, 30)) return reply(429, { error: 'Slow down: up to 30 refreshes a minute.' });
        const r = await runOne(db, String(j.id || ''));
        if (r === undefined) return reply(404, { error: 'No such source.' });
        if (r === null) return reply(409, { error: 'A full ingestion run is in progress. Try again in a minute.' });
        for (const x of r.inserted) { const e = db.prepare('select * from events where id=?').get(x.id); if (e) await notify(e).catch(err => console.error('notify failed:', err.message)); }
        return reply(200, { ok: r.status !== 'error', result: { status: r.status, message: r.message, items: r.items, created: r.created }, source: sourceRows(j.id)[0] });
      }
      if (p === '/api/admin/sources/test' && req.method === 'POST') {
        if (!needAdmin()) return;
        if (limited('src-test:' + uid, 20)) return reply(429, { error: 'Slow down: up to 20 tests a minute.' });
        const row = await buildSource(j);
        try { return reply(200, { ok: true, id: row.id, label: row.label, ...(await probe(row.kind, row.config)) }); } catch (e) { return reply(200, { ok: false, id: row.id, label: row.label, error: e.message }); }
      }
      if (p === '/api/admin/sources/add' && req.method === 'POST') {
        if (!needAdmin()) return;
        const row = await buildSource(j), all = db.prepare('select id,kind,config from sources_config').all();
        if (all.length >= 300) return reply(400, { error: 'You have reached the limit of 300 sources.' });
        const same = all.find(x => x.id === row.id || (x.kind === row.kind && (() => { const a = parseJson(x.config, {}), b = row.config; return row.kind === 'github' ? a.owner === b.owner && a.repo === b.repo : row.kind === 'feed' ? a.url === b.url : a.author === b.author; })()));
        if (same) return reply(409, { error: 'That source is already in the list.', id: same.id });
        db.prepare('insert into sources_config(id,kind,label,config,enabled) values(?,?,?,?,1)').run(row.id, row.kind, row.label, JSON.stringify(row.config));
        const r = await runOne(db, row.id); // first read now, so the admin sees at once whether it works
        return reply(200, { ok: true, result: r ? { status: r.status, message: r.message, items: r.items, created: r.created } : { status: 'new', message: 'Added. It will be read in the next run.' }, source: sourceRows(row.id)[0] });
      }
      if (p === '/api/admin/sources/remove' && req.method === 'POST') {
        if (!needAdmin()) return;
        const id = String(j.id || ''); if (!db.prepare('select 1 from sources_config where id=?').get(id)) return reply(404, { error: 'No such source.' });
        if (BUILTIN.has(id)) return reply(400, { error: 'Built-in sources cannot be removed. Pause it instead.' });
        db.prepare('delete from ingestion_log where source_id=?').run(id); db.prepare('delete from sources_config where id=?').run(id);
        return reply(200, { ok: true });
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
      if (e.code && typeof e.code === 'number') return send(req, res, e.code, { error: e.message }, p.startsWith('/api/v1') ? { 'Access-Control-Allow-Origin': '*' } : {});
      if (e instanceof SyntaxError) return send(req, res, 400, { error: 'Request could not be read.' });
      console.error(e);
      send(req, res, 500, { error: 'Something went wrong on our side. Try again shortly.' });
    }
  });
}).listen(PORT, () => {
  console.log('Signalstack running at http://localhost:' + PORT);
  if (process.env.DISABLE_INGEST !== 'true') scheduleIngestion();
  if (process.env.DISABLE_DIGEST !== 'true' && process.env.DISABLE_INGEST !== 'true') { setTimeout(digestTick, 30000).unref(); setInterval(digestTick, 10 * 60000).unref(); } // checked often, so a server that wakes late still sends
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
