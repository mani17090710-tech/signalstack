'use strict';
// Ingestion pipeline: SOURCE -> FETCH (paged) -> NORMALIZE -> DEDUPLICATE -> ENTITY EXTRACTION -> CLASSIFY -> STORE -> SIGNALS.
// Real public sources only: Hugging Face Hub, arXiv, GitHub releases, and lab blog RSS feeds.
// No API keys are required. Optional: HF_TOKEN / GITHUB_TOKEN raise rate limits.
//
// Behaviour worth knowing:
//  * The first run of a source is a "backfill": it fills the catalog, creates only a few signals, and never
//    triggers alert emails, so a fresh deploy does not flood anyone.
//  * Later runs stop paging as soon as a whole page is already known, so they stay cheap.
//  * DISCOVERY and VERIFICATION are separate. Every sighting of a model is stored in model_sources. A model's
//    verification status is derived only from evidence rows (see lib/verify.js); being listed by Hugging Face or
//    OpenRouter never makes a model "Verified".
//  * Items are published immediately. Set REQUIRE_REVIEW=true to hold them for admin approval instead.
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { COMPANIES, byHandle, byOrPrefix, byGithubOwner, byId, mentions } = require('./lib/companies');
const { recompute, levelOfTier, canonKey } = require('./lib/verify');
const { categorize, tagInfo, parseParams, pipelineOf, typeLabel, formatCount } = require('./lib/classify');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts16 = s => String(s || nowIso()).replace('T', ' ').slice(0, 16);
const unxml = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const httpUrl = u => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');
const isoOf = d => { const t = new Date(d); return isNaN(t) ? nowIso() : t.toISOString(); };
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
      categories: [...new Set([...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map(m => m[1]))].slice(0, 10), arxivId: raw,
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


// ---------- discovery, evidence and canonical records ----------
function recordSource(db, id, source, url, ref) {
  const t = nowIso();
  db.prepare(`insert into model_sources(model_id,source,source_ref,url,first_seen,last_seen) values(?,?,?,?,?,?)
    on conflict(model_id,source) do update set last_seen=excluded.last_seen,url=coalesce(excluded.url,model_sources.url),source_ref=coalesce(excluded.source_ref,model_sources.source_ref)`)
    .run(id, source, ref || null, url || null, t, t);
}
// Evidence is what verification is built from. The url is required: evidence without a link is not evidence.
function addEvidence(db, id, e) {
  if (!httpUrl(e.url)) return;
  db.prepare(`insert into model_evidence(model_id,level,kind,url,label,source,verified_at) values(?,?,?,?,?,?,?)
    on conflict(model_id,kind,url) do update set level=excluded.level,label=excluded.label,verified_at=excluded.verified_at`)
    .run(id, e.level, e.kind, e.url, e.label || null, e.source || null, nowIso());
}
// A model-to-paper link exists only where there is evidence for it; similar names are never enough.
function linkPapers(db, modelId, arxivIds, kind, url) {
  const ins = db.prepare('insert or ignore into model_papers(model_id,arxiv_id,evidence_kind,evidence_url,created_at) values(?,?,?,?,?)');
  for (const a of arxivIds) if (/^\d{4}\.\d{4,5}$/.test(a)) ins.run(modelId, a, kind, url || null, nowIso());
}

const UPSERT_MODEL = `insert into models(id,name,org_id,arch,params,ctx,open,price,rel,ver,uses,verified,likes,downloads,url,creator,company_id,released_at,license,pipeline,library,cats,arxiv,param_count,params_label,gated,verification,source_type,retrieved_at)
  values($id,$name,'hf','',$params,'',1,'',$rel,'',$uses,$verified,$likes,$downloads,$url,$creator,$company,$released,$license,$pipeline,$library,$cats,$arxiv,$pc,$pl,$gated,$verification,'huggingface',$now)
  on conflict(id) do update set likes=excluded.likes,downloads=excluded.downloads,uses=excluded.uses,cats=excluded.cats,license=excluded.license,
    pipeline=excluded.pipeline,library=excluded.library,arxiv=excluded.arxiv,creator=excluded.creator,company_id=excluded.company_id,
    gated=excluded.gated,retrieved_at=excluded.retrieved_at,
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
    pc: d.pp ? d.pp.count : null, pl: d.pp ? d.pp.label : null, gated: m.gated, verification: 'aggregator', now: nowIso(),
  });
  db.prepare('update models set canon_key=? where id=? and canon_key is null').run(canonKey(m.name), m.id);
  recordSource(db, m.id, 'huggingface', m.url, m.name);
  // The publisher's own account is evidence that the information comes from the original source.
  if (d.co) addEvidence(db, m.id, { level: 'source_verified', kind: 'official_account', url: m.url, label: `Published under ${d.co.name}\u2019s official Hugging Face account (${m.creator})`, source: 'huggingface' });
  // Papers the model's own metadata cites on Hugging Face.
  linkPapers(db, m.id, d.arxiv ? d.arxiv.split(',') : [], 'hf_model_tag', m.url);
  d.level = recompute(db, m.id);
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
        // Keep only models that matter: official labs, models that are trending, or ones with real traction.
        const official = !!byHandle(m.creator);
        if (cfg.minLikes && !official && !cfg.trending && m.likes < cfg.minLikes && m.downloads < (cfg.minDownloads || 0)) continue;
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
            source: m.url, source_type: 'huggingface', verification: d.level, company_id: lab ? lab.id : null,
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


// ---------- Closed and API-only models ----------
// One canonical record per model, whichever source finds it. OpenRouter and the hand-kept list both feed saveClosed();
// the record keeps every source that listed it (model_sources) and every piece of evidence for it (model_evidence).
const ctxLabel = n => (n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));

/**
 * @param r {key, aliases?, company, creator, createdAt, ctx, priceIn, priceOut, modality, capabilities, pipeline, cats,
 *           officialUrl?, official: boolean (the numbers come from the provider itself), source: {name, url, ref, orgId}, evidence: []}
 * Where two sources disagree, the provider's own numbers win over an aggregator's.
 */
function saveClosed(db, r) {
  const keys = [r.key, ...(r.aliases || [])].map(canonKey);
  let row = null;
  for (const k of keys) { row = db.prepare('select * from models where canon_key=?').get(k); if (row) break; }
  const id = row ? row.id : 'cm:' + canonKey(r.key), isNew = !row;
  const tag = r.official ? 'official' : r.source.name;
  const price = r.priceIn != null && r.priceOut != null ? `$${r.priceIn} in / $${r.priceOut} out per 1M tokens` : '';
  const caps = (r.capabilities || []).join(',');
  if (isNew) {
    db.prepare(`insert into models(id,name,org_id,arch,params,ctx,open,price,rel,ver,uses,verified,likes,downloads,url,creator,company_id,released_at,pipeline,cats,verification,source_type,retrieved_at,
        ctx_tokens,price_in,price_out,modality,canon_key,official_url,capabilities,ctx_source,price_source)
      values($id,$name,$org,'','',$ctx,0,$price,$rel,'','',$verified,0,0,$url,$creator,$company,$released,$pipeline,$cats,'aggregator',$stype,$now,$ctxn,$pin,$pout,$modality,$canon,$official,$caps,$csrc,$psrc)`).run({
      id, name: r.key, org: r.source.orgId, ctx: r.ctx ? ctxLabel(r.ctx) : '', price, rel: (r.createdAt || nowIso()).slice(0, 10), verified: REVIEW(), url: r.source.url,
      creator: r.creator, company: r.company ? r.company.id : null, released: r.createdAt || nowIso(), pipeline: r.pipeline, cats: ',' + (r.cats || []).join(',') + ',',
      stype: r.source.name, now: nowIso(), ctxn: r.ctx, pin: r.priceIn, pout: r.priceOut, modality: r.modality || null, canon: canonKey(r.key), official: r.officialUrl || null, caps: caps || null,
      csrc: r.ctx ? tag : null, psrc: price ? tag : null,
    });
  } else {
    const better = field => !row[field] || r.official || row[field] === r.source.name; // an aggregator never overwrites the provider's own number
    const u = [], a = [];
    if (r.ctx && better('ctx_source')) { u.push('ctx_tokens=?', 'ctx=?', 'ctx_source=?'); a.push(r.ctx, ctxLabel(r.ctx), tag); }
    if (price && better('price_source')) { u.push('price_in=?', 'price_out=?', 'price=?', 'price_source=?'); a.push(r.priceIn, r.priceOut, price, tag); }
    if (r.official && r.createdAt) { u.push('released_at=?', 'rel=?'); a.push(r.createdAt, r.createdAt.slice(0, 10)); }
    if (r.officialUrl) { u.push('official_url=?'); a.push(r.officialUrl); }
    if (caps) { u.push('capabilities=coalesce(capabilities,?)'); a.push(caps); }
    if (r.modality) { u.push('modality=coalesce(modality,?)'); a.push(r.modality); }
    u.push('retrieved_at=?'); a.push(nowIso());
    db.prepare(`update models set ${u.join(',')} where id=?`).run(...a, id);
  }
  recordSource(db, id, r.source.name, r.source.url, r.source.ref);
  for (const e of r.evidence || []) addEvidence(db, id, e);
  linkPapers(db, id, r.papers || [], 'official_announcement', r.officialUrl);
  const level = recompute(db, id);
  return { id, isNew, level };
}

// Release signal for a closed model. Its verification is whatever the model's evidence says, not what the source claims.
function closedEvent(db, id, r, level) {
  const bits = [r.type, r.ctx ? ctxLabel(r.ctx) + ' token context' : '', r.priceIn != null && r.priceOut != null ? `$${r.priceIn} / $${r.priceOut} per 1M tokens` : ''].filter(Boolean);
  return addEvent(db, {
    sev: r.company ? 'Major' : 'Important', ts: ts16(r.createdAt), org_id: r.source.orgId, model_id: id, cat: 'Model Release',
    summary: `New model${r.company ? ' from ' + r.company.name : ''}: ${r.display || r.key}.`, title: r.display || r.key, detail: r.summary || (bits.join(', ') + '.'),
    source: r.officialUrl || r.source.url, source_type: r.source.name, verification: level, company_id: r.company ? r.company.id : null,
  });
}

// ---------- OpenRouter: a discovery catalogue, not a source of verification ----------
function parseOpenRouter(text) {
  const j = JSON.parse(text), arr = j && j.data;
  if (!Array.isArray(arr)) throw new Error('Unexpected OpenRouter response');
  const nowSec = Date.now() / 1000;
  return arr.filter(m => m && m.id && !String(m.id).includes(':') && !(m.expiration_date && Date.parse(m.expiration_date) < Date.now())).map(m => {
    const [prefix] = String(m.id).split('/'), a = m.architecture || {}, inp = a.input_modalities || [], out = a.output_modalities || [], sp = m.supported_parameters || [];
    const per1m = v => (v != null && v !== '' && isFinite(+v) && +v >= 0 ? +(+v * 1e6).toFixed(4) : null);
    const tags = [];
    if (sp.includes('reasoning')) tags.push('reasoning');
    if (sp.includes('tools')) tags.push('tool-use');
    const capabilities = [];
    if (inp.includes('image')) capabilities.push('vision');
    if (inp.includes('audio')) capabilities.push('audio input');
    if (inp.includes('video')) capabilities.push('video input');
    if (inp.includes('file')) capabilities.push('file input');
    if (out.includes('image')) capabilities.push('image output');
    if (sp.includes('reasoning')) capabilities.push('reasoning');
    if (sp.includes('tools')) capabilities.push('tool use');
    if (sp.includes('structured_outputs') || sp.includes('response_format')) capabilities.push('structured output');
    const pipeline = out.includes('image') ? 'text-to-image' : out.includes('audio') ? 'text-to-audio' : out.includes('video') ? 'text-to-video'
      : inp.includes('video') || inp.includes('audio') ? 'any-to-any' : inp.includes('image') ? 'image-text-to-text' : 'text-generation';
    const created = +m.created > 0 && +m.created < nowSec + 86400 ? new Date(+m.created * 1000).toISOString() : '';
    return {
      key: String(m.id), orId: m.id, creator: prefix, createdAt: created, tags, capabilities, pipeline,
      hfId: m.hugging_face_id || '', ctx: +m.context_length > 0 ? Math.round(+m.context_length) : null,
      priceIn: per1m(m.pricing && m.pricing.prompt), priceOut: per1m(m.pricing && m.pricing.completion),
      modality: a.modality || '', url: 'https://openrouter.ai/' + m.id,
    };
  });
}

async function runOpenRouter(db, src, cfg, f, first) {
  const r = await fetchRes(cfg.url || 'https://openrouter.ai/api/v1/models', f);
  const items = parseOpenRouter(r.text);
  const evCap = first ? cfg.backfillEvents || 5 : cfg.maxEvents || 25;
  const fresh = [], inserted = [], hasEv = db.prepare('select 1 from events where source=? and cat=?');
  let created = 0, evCount = 0;
  db.exec('begin');
  try {
    for (const m of items) {
      const co = byOrPrefix(m.creator), c = categorize({ name: m.key, pipeline: m.pipeline, tags: m.tags });
      const rec = {
        key: m.key, company: co, creator: m.creator, createdAt: m.createdAt, ctx: m.ctx, priceIn: m.priceIn, priceOut: m.priceOut, modality: m.modality,
        capabilities: m.capabilities, pipeline: m.pipeline, cats: c.cats, type: c.type, official: false, source: { name: 'openrouter', url: m.url, ref: m.orId, orgId: 'or' },
      };
      if (m.hfId) {
        // Also on Hugging Face: the Hugging Face record is canonical. OpenRouter is recorded as one more place it was seen.
        const hf = db.prepare('select id from models where canon_key=?').get(canonKey(m.hfId));
        if (hf) saveClosed(db, { ...rec, key: m.hfId });
        continue;
      }
      const res = saveClosed(db, rec);
      if (res.isNew) { created++; fresh.push({ rec, res }); }
    }
    // The newest additions become "new model" signals (a handful on the first run, so a fresh deploy is not flooded).
    fresh.sort((a, b) => (a.rec.createdAt < b.rec.createdAt ? 1 : -1));
    for (const { rec, res } of fresh) {
      if (evCount >= evCap || hasEv.get(rec.source.url, 'Model Release')) continue;
      const ev = closedEvent(db, res.id, rec, res.level);
      evCount++;
      if (!first) inserted.push(ev);
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  return { firstText: r.text, items: items.length, created, inserted };
}

// ---------- Hand-kept list (data/curated-models.json): the provider-confirmed layer ----------
// Each entry links to the provider's own announcement, which is the evidence that earns "Verified".
function parseCurated(text) {
  const j = JSON.parse(text), arr = j && j.models;
  if (!Array.isArray(arr)) throw new Error('curated-models.json must contain a "models" array');
  const items = [], problems = [];
  arr.forEach((m, i) => {
    const label = `entry ${i + 1}${m && m.id ? ' (' + m.id + ')' : ''}`;
    const co = m && byId[m.company];
    if (!m || !/^[a-z0-9][\w.-]*\/[\w.:-]+$/.test(String(m.id || ''))) problems.push(`${label}: id must look like lab/model-name in lowercase`);
    else if (!m.name) problems.push(`${label}: name is required`);
    else if (!co) problems.push(`${label}: unknown company "${m.company}"`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.released || '')) || isNaN(Date.parse(m.released))) problems.push(`${label}: released must be YYYY-MM-DD`);
    else if (!/^https:\/\/[^\s"'<>]+$/.test(String(m.url || ''))) problems.push(`${label}: url must be an https link to the provider's announcement`);
    else if (m.docs_url && !/^https:\/\/[^\s"'<>]+$/.test(String(m.docs_url))) problems.push(`${label}: docs_url must be an https link`);
    else items.push({
      key: m.id, aliases: Array.isArray(m.aliases) ? m.aliases.map(String) : [], display: String(m.name), company: co, creator: m.id.split('/')[0],
      createdAt: m.released + 'T00:00:00.000Z', announcementUrl: String(m.url), docsUrl: m.docs_url ? String(m.docs_url) : '',
      ctx: +m.context > 0 ? Math.round(+m.context) : null, priceIn: m.price_in != null && +m.price_in >= 0 ? +m.price_in : null,
      priceOut: m.price_out != null && +m.price_out >= 0 ? +m.price_out : null, modality: m.modality ? String(m.modality).slice(0, 60) : '',
      capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(x => String(x).slice(0, 40)).slice(0, 12) : [],
      summary: m.summary ? String(m.summary).slice(0, 240) : '', papers: Array.isArray(m.papers) ? m.papers.map(String) : [],
    });
  });
  return { items, problems };
}

async function runCurated(db, src, cfg, f, first) {
  const file = path.resolve(__dirname, cfg.file || 'data/curated-models.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { firstText: '', items: 0, created: 0, inserted: [], seen: nowIso() }; } // no file means nothing curated
  const { items, problems } = parseCurated(text);
  const inserted = [];
  let created = 0;
  db.exec('begin');
  try {
    for (const m of items) {
      const c = categorize({ name: m.key, pipeline: m.modality.includes('image') ? 'image-text-to-text' : 'text-generation', tags: [] });
      const evidence = [{ level: 'verified', kind: 'official_announcement', url: m.announcementUrl, label: `Announced by ${m.company.name}`, source: 'curated' }];
      if (m.docsUrl) evidence.push({ level: 'verified', kind: 'official_documentation', url: m.docsUrl, label: `${m.company.name} documentation`, source: 'curated' });
      const rec = {
        key: m.key, aliases: m.aliases, display: m.display, company: m.company, creator: m.creator, createdAt: m.createdAt, ctx: m.ctx, priceIn: m.priceIn, priceOut: m.priceOut,
        modality: m.modality, capabilities: m.capabilities, pipeline: m.modality.includes('image') ? 'image-text-to-text' : 'text-generation', cats: c.cats, type: c.type,
        summary: m.summary, officialUrl: m.docsUrl || m.announcementUrl, official: true, papers: m.papers, evidence,
        source: { name: 'curated', url: m.announcementUrl, ref: m.key, orgId: 'cu' },
      };
      const res = saveClosed(db, rec);
      if (res.isNew) {
        created++;
        if (!db.prepare('select 1 from events where source=? and cat=?').get(rec.officialUrl, 'Model Release')) {
          const ev = closedEvent(db, res.id, rec, res.level);
          if (!first) inserted.push(ev);
        }
      }
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  // Valid entries are saved; invalid ones are reported so the person editing the file can fix them.
  const warning = problems.length ? `Skipped ${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'}: ${problems.slice(0, 3).join('; ')}` : '';
  // Mark the file as seen even when it is empty, so the first entry someone adds later raises a signal.
  return { firstText: text, items: items.length, created, inserted, warning, seen: nowIso() };
}


function linkMentionedModels(db, papers) {
  const cand = db.prepare("select id,canon_key from models where id like 'hf:%' and instr(?, canon_key)>0 and instr(canon_key,'/')>0 limit 20");
  for (const p of papers) {
    const text = `${p.title} ${p.summary}`.toLowerCase();
    for (const m of cand.all(text)) {
      const k = m.canon_key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|[^\\w./-])' + k + '($|[^\\w-])').test(text)) linkPapers(db, m.id, [p.arxivId], 'paper_names_model_id', p.url);
    }
  }
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
  const ins = db.prepare(`insert or ignore into papers(id,title,org_id,date,model_ids,arch,tldr,limits,url,verified,authors,published_at,entities,verification,source_type,retrieved_at,arxiv_id,categories)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const touch = db.prepare('update papers set retrieved_at=?,categories=coalesce(categories,?),arxiv_id=coalesce(arxiv_id,?) where id=?');
  let firstText = '', total = 0, created = 0;
  const fresh = [], seenAll = [];
  for (let i = 0; i < pages; i++) {
    await arxivWait(opt);
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&start=${i * per}&max_results=${per}`;
    const r = await fetchRes(url, f);
    if (i === 0) firstText = r.text;
    const items = parseArxiv(r.text);
    total += items.length; seenAll.push(...items);
    let n = 0;
    db.exec('begin');
    try {
      for (const p of items) {
        if (known.get(p.id)) { touch.run(nowIso(), p.categories.join(',') || null, p.arxivId, p.id); continue; } // seen again: refresh "last checked"
        n++; created++;
        p.entities = mentions(p.title + ' ' + p.summary);
        fresh.push(p);
        ins.run(p.id, p.title, 'arxiv', (p.published || nowIso()).slice(0, 10), '', p.cat || 'Not classified', p.summary, '', p.url, REVIEW(),
          p.authors.join(', '), p.published ? isoOf(p.published) : nowIso(), JSON.stringify(p.entities), 'source_verified', 'arxiv', nowIso(), p.arxivId, p.categories.join(',') || null);
      }
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    if (!items.length || items.length < per || (!first && !n)) break; // a short page means the feed has run out
  }
  // Link new papers to models only where the paper's own text names the model's exact repository id (for example
  // "Qwen/Qwen3-8B"). A similar name is not evidence and creates no link.
  for (const p of seenAll) if (!p.entities) p.entities = mentions(p.title + ' ' + p.summary);
  linkMentionedModels(db, seenAll);
  // Only papers that name a tracked lab or model family become signals; the rest stay searchable in Research.
  const inserted = [], cap = first ? cfg.backfillEvents || 5 : cfg.maxEvents || 10;
  fresh.filter(p => p.entities.length).sort((a, b) => (a.published < b.published ? 1 : -1)).slice(0, cap).forEach(p => {
    const ev = addEvent(db, {
      sev: 'Research', ts: ts16(p.published), org_id: 'arxiv', cat: 'Research', summary: 'New paper: ' + p.title, title: p.title,
      detail: p.summary.slice(0, 240), source: p.url, source_type: 'arxiv', verification: 'source_verified', company_id: p.entities[0],
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
      verification: levelOfTier(cfg.tier), company_id: co ? co.id : null, meta: { repo: `${cfg.owner}/${cfg.repo}`, tag: x.tag },
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
      source: x.link, source_type: 'blog', verification: levelOfTier(cfg.tier), company_id: cfg.company || null, meta: { tier: cfg.tier || 'community' },
    });
    created++;
    if (!first) inserted.push(ev);
  }
  return { firstText: r.text, items: items.length, created, inserted, seen: items.reduce((m, x) => (x.date > m ? x.date : m), '') || undefined };
}

// ---------- run one source / all sources ----------
async function runSource(db, src, f, opt = {}) {
  const cfg = JSON.parse(src.config || '{}'), kind = src.kind, first = !src.last_seen;
  const fn = { huggingface: runHF, openrouter: runOpenRouter, curated: runCurated, github: runGitHub, arxiv: runArxiv, feed: runFeed }[kind];
  if (!fn) throw new Error('Unknown source kind: ' + kind);
  const r = await fn(db, src, cfg, f, first, opt);
  const hash = sha(r.firstText || '');
  if (!first && hash === src.last_hash && !r.created && !r.warning) return { status: 'unchanged', items: 0, created: 0, inserted: [] };
  db.prepare('update sources_config set last_hash=?,last_seen=? where id=?').run(hash, r.seen || (r.items ? nowIso() : src.last_seen), src.id);
  return { status: r.warning ? 'warning' : 'ok', warning: r.warning || '', items: r.items, created: r.created, inserted: r.inserted, first };
}

function prune(db) {
  const days = Math.max(30, +process.env.RETENTION_DAYS || 365);
  try {
    db.exec(`delete from models where org_id='hf' and company_id is null and likes<10 and downloads<1000 and (trend_at is null or trend_at<datetime('now','-7 day')) and rel<date('now','-14 day')
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
        db.prepare('update sources_config set last_run=?,last_status=?,last_error=? where id=?').run(ts, r.status, r.warning || null, src.id);
        const msg = r.status === 'unchanged' ? 'No new content since last check.' : `${r.first ? 'First run (backfill): ' : ''}Read ${r.items} item(s), ${r.created} new.${r.warning ? ' ' + r.warning : ''}`;
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

module.exports = { saveClosed, parseCurated, parseOpenRouter, runAll, runSource, enrichModel, parseHuggingFace, parseGitHub, parseArxiv, parseFeed, describeModel };
