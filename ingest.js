'use strict';
// Ingestion pipeline: SOURCE -> FETCH (paged) -> NORMALIZE -> DEDUPLICATE -> ENTITY EXTRACTION -> CLASSIFY -> STORE -> SIGNALS.
// Real public sources only: Hugging Face Hub, arXiv, GitHub releases, and lab blog RSS feeds.
// No API keys are required. Optional: HF_TOKEN / GITHUB_TOKEN raise rate limits.
//
// Behaviour worth knowing:
//  * The first run of a source is a "backfill": it fills the catalog, creates only a few signals, and never
//    triggers alert emails, so a fresh deploy does not flood anyone.
//  * Later runs stop paging as soon as a whole page is already known, so they stay cheap.
//  * Discovery and verification are separate. A source only tells us a model or paper exists (model_sources); the
//    verification status comes from evidence (model_evidence): verified, source_verified, aggregator_listed, unverified.
//  * One canonical record per model, however many sources list it (lib/canon.js).
//  * Items are published immediately. Set REQUIRE_REVIEW=true to hold them for admin approval instead.
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { COMPANIES, byHandle, byOrPrefix, byGithubOwner, byId, mentions, isOfficialUrl } = require('./lib/companies');
const { canonKey, findAll, addAlias, attachSource, mergeModels, rankOf } = require('./lib/canon');
const { addEvidence, refreshVerification } = require('./lib/verify');
const { keepReason, pruneModels } = require('./lib/policy');
const { linkModelPapers } = require('./lib/links');
const { categorize, tagInfo, parseParams, pipelineOf, typeLabel, formatCount } = require('./lib/classify');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts16 = s => String(s || nowIso()).replace('T', ' ').slice(0, 16);
const unxml = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const httpUrl = u => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');
const isoOf = d => { const t = new Date(d); return isNaN(t) ? nowIso() : t.toISOString(); };
// How an event's source is described: straight from the original publisher, or relayed by someone else.
const verificationOf = tier => (tier === 'primary' ? 'source_verified' : 'aggregator_listed');
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
    const cat = (e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [, ''])[1];
    const categories = [...new Set([cat, ...[...e.matchAll(/<category[^>]*term="([^"]+)"/g)].map(m => m[1])].filter(Boolean))];
    return {
      id: 'arxiv:' + raw, arxivId: raw, title: pick(e, 'title').replace(/\s+/g, ' '), summary: pick(e, 'summary').replace(/\s+/g, ' '),
      published: pick(e, 'published'), updated: pick(e, 'updated'), cat, categories, url: 'https://arxiv.org/abs/' + raw,
      authors: [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map(m => unxml(m[1]).trim()).filter(Boolean),
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

const UPSERT_MODEL = `insert into models(id,name,org_id,arch,params,ctx,open,price,rel,ver,uses,verified,likes,downloads,url,creator,company_id,released_at,license,pipeline,library,cats,arxiv,param_count,params_label,gated,verification,source_type,retrieved_at,canon_key,model_ref,first_seen,seen_at,keep_reason,provider_url)
  values($id,$name,'hf','',$params,'',1,'',$rel,'',$uses,$verified,$likes,$downloads,$url,$creator,$company,$released,$license,$pipeline,$library,$cats,$arxiv,$pc,$pl,$gated,'unverified','huggingface',$now,$key,$ref,$now,$now,$reason,$purl)
  on conflict(id) do update set likes=excluded.likes,downloads=excluded.downloads,uses=excluded.uses,cats=excluded.cats,license=excluded.license,
    pipeline=excluded.pipeline,library=excluded.library,arxiv=excluded.arxiv,creator=excluded.creator,company_id=excluded.company_id,
    gated=excluded.gated,retrieved_at=excluded.retrieved_at,seen_at=excluded.seen_at,keep_reason=excluded.keep_reason,canon_key=excluded.canon_key,
    provider_url=coalesce(excluded.provider_url,models.provider_url),
    released_at=coalesce(models.released_at,excluded.released_at),param_count=coalesce(models.param_count,excluded.param_count),
    params_label=coalesce(models.params_label,excluded.params_label)`;

// Turns one normalized Hugging Face item into the columns we store (classification + entity extraction).
function describeModel(m) {
  const co = byHandle(m.creator), c = categorize({ name: m.name, pipeline: m.pipeline, tags: m.tags }), ti = tagInfo(m.tags), pp = parseParams(m.name);
  const uses = [m.pipeline, ...m.tags.filter(t => t !== m.pipeline && !/^(region:|endpoints_compatible|autotrain_compatible|text-generation-inference|deploy:|license:|arxiv:)/.test(t))]
    .filter(Boolean).map(t => t.replace(/,/g, ' ')).slice(0, 8).join(',');
  return { co, cats: ',' + c.cats.join(',') + ',', type: c.type, license: ti.license, arxiv: ti.arxiv.join(','), pp, uses };
}
// Discovery only: stores the Hugging Face listing and attaches it to the canonical record. It never sets a verification
// status by itself; evidence decides that (see lib/verify.js).
function saveModel(db, m, reason) {
  const d = describeModel(m), key = canonKey(m.creator, m.name);
  db.prepare(UPSERT_MODEL).run({
    id: m.id, name: m.name, params: d.pp ? d.pp.label : '', rel: (m.createdAt || nowIso()).slice(0, 10), uses: d.uses, verified: REVIEW(),
    likes: m.likes, downloads: m.downloads, url: m.url, creator: m.creator, company: d.co ? d.co.id : null, released: m.createdAt || nowIso(),
    license: d.license || null, pipeline: m.pipeline || null, library: m.library || null, cats: d.cats, arxiv: d.arxiv || null,
    pc: d.pp ? d.pp.count : null, pl: d.pp ? d.pp.label : null, gated: m.gated, now: nowIso(), key, ref: m.name, reason: reason || 'popular', purl: d.co ? m.url : null,
  });
  // The same model may already be stored from another listing (OpenRouter, a hand-kept entry): fold it into this record.
  for (const o of findAll(db, key).filter(r => r.id !== m.id)) mergeModels(db, m.id, o.id);
  attachSource(db, m.id, { source: 'huggingface', ext: m.name, url: m.url });
  if (d.co) addEvidence(db, m.id, 'publisher_namespace', 'https://huggingface.co/' + m.creator, `Published under ${d.co.name}’s own Hugging Face account.`);
  else addEvidence(db, m.id, 'aggregator', m.url, 'Community model on Hugging Face.');
  refreshVerification(db, m.id);
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
        // Keep only what the policy allows: official lab releases, trending models, and models with real traction.
        const official = !!byHandle(m.creator);
        const reason = keepReason(m, { official, trending: !!cfg.trending });
        if (!reason) continue;
        const key = canonKey(m.creator, m.name);
        const wasKnown = !!known.get(m.id), elsewhere = findAll(db, key).some(r2 => r2.id !== m.id);
        if (!wasKnown) { fresh++; created++; }
        const d = saveModel(db, m, reason);
        rank++;
        if (cfg.trending) setTrend.run(rank, nowIso(), m.id);
        ids.push(m.id);

        // A model we already knew from another listing is not "new", even though its Hugging Face page is.
        const isNew = !wasKnown && !elsewhere;
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
            source: m.url, source_type: 'huggingface', verification: lab ? 'source_verified' : verificationOf(cfg.tier), company_id: lab ? lab.id : null,
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


// ---------- OpenRouter (closed and API-only models) ----------
// OpenRouter's public catalogue lists models from OpenAI, Anthropic, Google, xAI and others, with context length and
// pricing. It is a discovery source only: a model found here is "Aggregator Listed". Only the provider's own
// announcement or documentation (see runCurated) can make it "Verified".
function parseOpenRouter(text) {
  const j = JSON.parse(text), arr = j && j.data;
  if (!Array.isArray(arr)) throw new Error('Unexpected OpenRouter response');
  const nowSec = Date.now() / 1000;
  return arr.filter(m => m && m.id && !String(m.id).includes(':') && !(m.expiration_date && Date.parse(m.expiration_date) < Date.now())).map(m => {
    const [prefix] = String(m.id).split('/'), a = m.architecture || {}, inp = a.input_modalities || [], out = a.output_modalities || [];
    const per1m = v => (v != null && v !== '' && isFinite(+v) && +v >= 0 ? +(+v * 1e6).toFixed(4) : null);
    const tags = [];
    if ((m.supported_parameters || []).includes('reasoning')) tags.push('reasoning');
    if ((m.supported_parameters || []).includes('tools')) tags.push('tool-use');
    const pipeline = out.includes('image') ? 'text-to-image' : out.includes('audio') ? 'text-to-audio' : out.includes('video') ? 'text-to-video'
      : inp.includes('video') || inp.includes('audio') ? 'any-to-any' : inp.includes('image') ? 'image-text-to-text' : 'text-generation';
    const created = +m.created > 0 && +m.created < nowSec + 86400 ? new Date(+m.created * 1000).toISOString() : '';
    return {
      id: 'or:' + m.id, orId: m.id, name: m.id, creator: prefix, createdAt: created, tags, pipeline,
      hfId: m.hugging_face_id || '', ctx: +m.context_length > 0 ? Math.round(+m.context_length) : null,
      priceIn: per1m(m.pricing && m.pricing.prompt), priceOut: per1m(m.pricing && m.pricing.completion),
      modality: a.modality || '', url: 'https://openrouter.ai/' + m.id,
    };
  });
}
const ctxLabel = n => (n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
const priceText = (a, b) => (a != null && b != null ? `$${a} in / $${b} out per 1M tokens` : '');

// One statement for catalogue rows (OpenRouter and the hand-kept list).
const UPSERT_API = `insert into models(id,name,org_id,arch,params,ctx,open,price,rel,ver,uses,verified,likes,downloads,url,creator,company_id,released_at,pipeline,cats,verification,source_type,retrieved_at,ctx_tokens,price_in,price_out,modality,canon_key,model_ref,first_seen,seen_at,or_url,provider_url,ctx_source,price_source)
  values($id,$name,$org,'','',$ctx,$open,$price,$rel,'',$uses,$verified,0,0,$url,$creator,$company,$released,$pipeline,$cats,'unverified',$stype,$now,$ctxn,$pin,$pout,$modality,$key,$ref,$now,$now,$orurl,$purl,$csrc,$psrc)
  on conflict(id) do update set name=excluded.name,ctx=excluded.ctx,price=excluded.price,uses=excluded.uses,cats=excluded.cats,pipeline=excluded.pipeline,creator=excluded.creator,
    company_id=excluded.company_id,retrieved_at=excluded.retrieved_at,ctx_tokens=excluded.ctx_tokens,price_in=excluded.price_in,price_out=excluded.price_out,
    modality=excluded.modality,seen_at=excluded.seen_at,delisted_at=null,canon_key=excluded.canon_key,ctx_source=excluded.ctx_source,price_source=excluded.price_source,
    or_url=coalesce(excluded.or_url,models.or_url),provider_url=coalesce(excluded.provider_url,models.provider_url),released_at=coalesce(models.released_at,excluded.released_at)`;

// A model OpenRouter lists that we already hold under another record: add what OpenRouter knows, never replace the
// record, and never overwrite a figure the provider itself published.
function attachOpenRouter(db, host, m) {
  const sets = ['or_url=?', 'seen_at=?', 'delisted_at=null', 'modality=coalesce(modality,?)'], args = [m.url, nowIso(), m.modality || null];
  if (host.ctx_source !== 'official' && m.ctx) { sets.push('ctx_tokens=?', 'ctx=?', 'ctx_source=?'); args.push(m.ctx, ctxLabel(m.ctx), 'openrouter'); }
  if (host.price_source !== 'official' && m.priceIn != null && m.priceOut != null) { sets.push('price_in=?', 'price_out=?', 'price=?', 'price_source=?'); args.push(m.priceIn, m.priceOut, priceText(m.priceIn, m.priceOut), 'openrouter'); }
  db.prepare(`update models set ${sets.join(',')} where id=?`).run(...args, host.id);
}

async function runOpenRouter(db, src, cfg, f, first) {
  const r = await fetchRes(cfg.url || 'https://openrouter.ai/api/v1/models', f);
  const items = parseOpenRouter(r.text);
  const known = db.prepare('select 1 from models where id=?');
  const hasEv = db.prepare('select 1 from events where source=? and cat=?');
  const evCap = first ? cfg.backfillEvents || 5 : cfg.maxEvents || 25;
  const fresh = [], inserted = [], mine = [];
  let created = 0, evCount = 0;
  db.exec('begin');
  try {
    for (const m of items) {
      const key = canonKey('', m.hfId || m.orId), rows = findAll(db, key, [canonKey('', m.orId)]);
      const self = rows.find(x => x.id === m.id), host = self || rows[0];
      if (host && host.id !== m.id) {
        // Already stored from another listing: attach this one to the canonical record.
        attachOpenRouter(db, host, m);
        addAlias(db, m.id, host.id, 'id'); // links that used the catalogue id keep working
        attachSource(db, host.id, { source: 'openrouter', ext: m.orId, url: m.url, ctx: m.ctx, priceIn: m.priceIn, priceOut: m.priceOut });
        addEvidence(db, host.id, 'aggregator', m.url, 'Listed in the OpenRouter catalogue.');
        refreshVerification(db, host.id);
        continue;
      }
      if (known.get('cu:' + m.orId)) continue; // the hand-kept, lab-linked entry wins
      const co = byOrPrefix(m.creator), c = categorize({ name: m.name, pipeline: m.pipeline, tags: m.tags });
      const isNew = !self;
      db.prepare(UPSERT_API).run({
        id: m.id, name: m.name, org: 'or', open: m.hfId ? 1 : 0, ctx: m.ctx ? ctxLabel(m.ctx) : '', price: priceText(m.priceIn, m.priceOut), rel: (m.createdAt || nowIso()).slice(0, 10),
        uses: [m.pipeline, ...m.tags].join(','), verified: REVIEW(), url: m.url, creator: m.creator, company: co ? co.id : null, released: m.createdAt || nowIso(),
        pipeline: m.pipeline, cats: ',' + c.cats.join(',') + ',', stype: 'openrouter', now: nowIso(), ctxn: m.ctx, pin: m.priceIn, pout: m.priceOut, modality: m.modality || null,
        key, ref: m.orId, orurl: m.url, purl: null, csrc: m.ctx ? 'openrouter' : null, psrc: m.priceIn != null && m.priceOut != null ? 'openrouter' : null,
      });
      attachSource(db, m.id, { source: 'openrouter', ext: m.orId, url: m.url, ctx: m.ctx, priceIn: m.priceIn, priceOut: m.priceOut });
      addEvidence(db, m.id, 'aggregator', m.url, 'Listed in the OpenRouter catalogue.');
      refreshVerification(db, m.id);
      mine.push(m.id);
      if (isNew) { created++; fresh.push({ m, co, c }); }
    }
    // The newest additions become "new model" signals (a handful on the first run, so a fresh deploy is not flooded).
    fresh.sort((a, b) => (a.m.createdAt < b.m.createdAt ? 1 : -1));
    for (const { m, co, c } of fresh) {
      if (evCount >= evCap || hasEv.get(m.url, 'Model Release')) continue;
      const bits = [c.type, m.ctx ? ctxLabel(m.ctx) + ' token context' : '', m.priceIn != null && m.priceOut != null ? `$${m.priceIn} / $${m.priceOut} per 1M tokens` : ''].filter(Boolean);
      const ev = addEvent(db, {
        sev: co ? 'Major' : 'Important', ts: ts16(m.createdAt), org_id: 'or', model_id: m.id, cat: 'Model Release',
        summary: `New model listed${co ? ' for ' + co.name : ''}: ${m.name}.`, title: m.name, detail: bits.join(', ') + '.',
        source: m.url, source_type: 'openrouter', verification: 'aggregator_listed', company_id: co ? co.id : null,
      });
      evCount++;
      if (!first) inserted.push(ev);
    }
    // A catalogue-only model that has left OpenRouter's list is marked as no longer listed (not deleted). A sanity floor
    // stops a truncated response from marking everything.
    if (items.length >= 20) {
      db.prepare("update models set delisted_at=? where source_type='openrouter' and id like 'or:%' and delisted_at is null and id not in (select value from json_each(?))")
        .run(nowIso(), JSON.stringify(items.map(x => x.id)));
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  return { firstText: r.text, items: items.length, created, inserted };
}

// ---------- Official list (data/curated-models.json) ----------
// Entries come from the provider's own announcement or documentation, on the provider's own domain. This is the only
// path that produces the "Verified" status for a closed model. An entry whose links are not on the provider's domain
// is rejected, so a typo cannot turn into a false "Verified".
const ARXIV_ID = /^\d{4}\.\d{4,5}$/;
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
    else if (!httpUrl(m.url) || !isOfficialUrl(co, m.url)) problems.push(`${label}: url must be an https link on ${co.name}'s own domain (${(co.domains || []).join(', ') || 'none configured'})`);
    else if (m.docs_url && (!httpUrl(m.docs_url) || !isOfficialUrl(co, m.docs_url))) problems.push(`${label}: docs_url must be an https link on ${co.name}'s own domain`);
    else if (m.papers && (!Array.isArray(m.papers) || m.papers.some(x => !ARXIV_ID.test(String(x))))) problems.push(`${label}: papers must be a list of arXiv ids such as 2401.00001`);
    else items.push({
      id: 'cu:' + m.id, name: m.id, display: String(m.name), co, createdAt: m.released + 'T00:00:00.000Z', url: String(m.url), docsUrl: m.docs_url ? String(m.docs_url) : '',
      providerId: m.provider_model_id ? String(m.provider_model_id).slice(0, 120) : '', orId: m.openrouter_id ? String(m.openrouter_id).toLowerCase() : '',
      ctx: +m.context > 0 ? Math.round(+m.context) : null, priceIn: m.price_in != null && +m.price_in >= 0 ? +m.price_in : null,
      priceOut: m.price_out != null && +m.price_out >= 0 ? +m.price_out : null, modality: m.modality ? String(m.modality).slice(0, 60) : '', summary: m.summary ? String(m.summary).slice(0, 240) : '',
      capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(x => String(x).slice(0, 40)).slice(0, 12) : [], papers: (m.papers || []).map(String),
    });
  });
  return { items, problems };
}

// Applies the provider's own facts to a record (new or existing) and records the evidence for them.
function applyOfficial(db, id, m) {
  const sets = ['released_at=?', 'rel=?', 'provider_url=?', 'seen_at=?'], args = [m.createdAt, m.createdAt.slice(0, 10), m.url, nowIso()];
  if (m.providerId) { sets.push('provider_model_id=?'); args.push(m.providerId); }
  if (m.ctx) { sets.push('ctx_tokens=?', 'ctx=?', 'ctx_source=?'); args.push(m.ctx, ctxLabel(m.ctx), 'official'); }
  if (m.priceIn != null && m.priceOut != null) { sets.push('price_in=?', 'price_out=?', 'price=?', 'price_source=?'); args.push(m.priceIn, m.priceOut, priceText(m.priceIn, m.priceOut), 'official'); }
  if (m.modality) { sets.push('modality=?'); args.push(m.modality); }
  db.prepare(`update models set ${sets.join(',')} where id=?`).run(...args, id);
  attachSource(db, id, { source: 'curated', ext: m.name, url: m.url, ctx: m.ctx, priceIn: m.priceIn, priceOut: m.priceOut });
  addEvidence(db, id, 'official_announcement', m.url, `Announced by ${m.co.name} on ${new URL(m.url).hostname}.`);
  if (m.docsUrl) addEvidence(db, id, 'official_docs', m.docsUrl, `Documented by ${m.co.name} on ${new URL(m.docsUrl).hostname}.`);
  for (const a of m.papers) db.prepare('insert or ignore into model_papers(model_id,arxiv_id,kind,claimed_by,url,created_at) values(?,?,?,?,?,?)').run(id, a, 'official_entry', 'publisher', m.url, nowIso());
  refreshVerification(db, id);
}

async function runCurated(db, src, cfg, f, first) {
  const file = path.resolve(__dirname, cfg.file || 'data/curated-models.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { firstText: '', items: 0, created: 0, inserted: [], seen: nowIso() }; } // no file means nothing curated
  const { items, problems } = parseCurated(text);
  const known = db.prepare('select 1 from models where id=?');
  const hasEv = db.prepare('select 1 from events where source=? and cat=?');
  const inserted = [];
  let created = 0;
  db.exec('begin');
  try {
    for (const m of items) {
      const key = canonKey('', m.name), alias = m.orId ? [canonKey('', m.orId)] : [];
      const rows = findAll(db, key, alias), self = rows.find(r => r.id === m.id), host = self || rows[0];
      if (host && host.id !== m.id && rankOf(host.id) < rankOf(m.id)) { // already held as an open-weight (Hugging Face) record: add the official facts to it
        applyOfficial(db, host.id, m);
        addAlias(db, m.id, host.id, 'id');
        continue;
      }
      const isNew = !self && !rows.length;
      db.prepare(UPSERT_API).run({
        id: m.id, name: m.name, org: 'cu', open: 0, ctx: m.ctx ? ctxLabel(m.ctx) : '', price: priceText(m.priceIn, m.priceOut), rel: m.createdAt.slice(0, 10),
        uses: [m.modality.includes('image') ? 'image-text-to-text' : 'text-generation', ...m.capabilities].join(','), verified: REVIEW(), url: m.url, creator: m.name.split('/')[0],
        company: m.co.id, released: m.createdAt, pipeline: m.modality.includes('image') ? 'image-text-to-text' : 'text-generation', cats: ',', stype: 'curated', now: nowIso(),
        ctxn: m.ctx, pin: m.priceIn, pout: m.priceOut, modality: m.modality || null, key, ref: m.name, orurl: null, purl: m.url, csrc: m.ctx ? 'official' : null, psrc: m.priceIn != null ? 'official' : null,
      });
      for (const o of rows.filter(r => r.id !== m.id)) mergeModels(db, m.id, o.id); // an OpenRouter listing of the same model joins this record
      if (m.orId) addAlias(db, canonKey('', m.orId), m.id, 'key');
      applyOfficial(db, m.id, m);
      if (isNew) {
        created++;
        if (!hasEv.get(m.url, 'Model Release')) {
          const ev = addEvent(db, {
            sev: 'Major', ts: ts16(m.createdAt), org_id: 'cu', model_id: m.id, cat: 'Model Release', summary: `New model from ${m.co.name}: ${m.display}.`, title: m.display,
            detail: m.summary || null, source: m.url, source_type: 'curated', verification: 'verified', company_id: m.co.id,
          });
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

// ---------- arXiv ----------
// arXiv is the primary record for a paper: title, authors, abstract, dates and categories are stored exactly as arXiv
// publishes them. Nothing is summarised or invented here.
let lastArxiv = 0;
async function arxivWait(opt) {
  const gap = opt.arxivDelayMs ?? 3100, w = lastArxiv + gap - Date.now();
  if (w > 0) await sleep(w);
  lastArxiv = Date.now();
}
const UPSERT_PAPER = `insert into papers(id,title,org_id,date,model_ids,arch,tldr,limits,url,verified,authors,published_at,entities,verification,source_type,retrieved_at,arxiv_id,abstract,categories,primary_cat,source_role,last_checked,updated_at)
  values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  on conflict(id) do update set title=excluded.title,authors=excluded.authors,abstract=excluded.abstract,categories=excluded.categories,primary_cat=excluded.primary_cat,
    arch=excluded.arch,updated_at=excluded.updated_at,last_checked=excluded.last_checked,retrieved_at=excluded.retrieved_at,arxiv_id=excluded.arxiv_id`;
function savePaper(db, p) {
  p.entities = mentions(p.title + ' ' + p.summary);
  db.prepare(UPSERT_PAPER).run(p.id, p.title, 'arxiv', (p.published || nowIso()).slice(0, 10), '', p.cat || 'Not classified', '', '', p.url, REVIEW(),
    p.authors.join(', '), p.published ? isoOf(p.published) : nowIso(), JSON.stringify(p.entities), 'source_verified', 'arxiv', nowIso(),
    p.arxivId, p.summary, p.categories.join(','), p.cat || null, 'primary', nowIso(), p.updated ? isoOf(p.updated) : null);
}
async function runArxiv(db, src, cfg, f, first, opt) {
  const q = cfg.query || (cfg.category ? 'cat:' + cfg.category : 'cat:cs.CL');
  const per = Math.min(+cfg.limit || 100, 200), pages = first ? cfg.backfillPages || 3 : cfg.pages || 1;
  const known = db.prepare('select 1 from papers where id=?');
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
        const isNew = !known.get(p.id);
        savePaper(db, p); // known papers are re-saved so their "last checked" time and any arXiv revision stay current
        if (isNew) { n++; created++; fresh.push(p); }
      }
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
    if (!items.length || items.length < per || (!first && !n)) break; // a short page means the feed has run out
  }
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

// Papers that models cite (arXiv ids on Hugging Face model cards, or listed in an official entry) but that we do not hold yet
// are fetched from arXiv by id, so the link on a model page leads to arXiv's own metadata.
async function runArxivCited(db, src, cfg, f, first, opt) {
  linkModelPapers(db);
  const ids = db.prepare('select distinct mp.arxiv_id a from model_papers mp left join papers p on p.arxiv_id=mp.arxiv_id where p.id is null limit ?').all(Math.min(+cfg.batch || 40, 100)).map(r => r.a);
  if (!ids.length) return { firstText: '', items: 0, created: 0, inserted: [], seen: nowIso() };
  await arxivWait(opt);
  const r = await fetchRes(`https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${ids.length}`, f);
  const items = parseArxiv(r.text);
  let created = 0;
  db.exec('begin');
  try { for (const p of items) { savePaper(db, p); created++; } db.exec('commit'); } catch (e) { db.exec('rollback'); throw e; }
  return { firstText: r.text, items: items.length, created, inserted: [], seen: nowIso() };
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
  const fn = { huggingface: runHF, openrouter: runOpenRouter, curated: runCurated, github: runGitHub, arxiv: runArxiv, arxiv_cited: runArxivCited, feed: runFeed }[kind];
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
    pruneModels(db);
    db.exec(`delete from papers where date<date('now','-${days} day') and (arxiv_id is null or arxiv_id not in (select arxiv_id from model_papers));
      delete from events where ts<datetime('now','-120 day') and model_id is null;
      delete from ingestion_log where ts<datetime('now','-14 day');
      delete from signal_overrides where event_id not in (select id from events);
      delete from sessions where expires<${Date.now()};delete from password_resets where expires<${Date.now()}`);
  } catch (e) { console.error('Prune failed:', e.message); }
}

let running = false;
// Runs one source and records the outcome (status on the source, a line in the log). Never throws: a failure is the result.
async function runLogged(db, src, f, opt) {
  const ts = nowIso();
  try {
    const r = await runSource(db, src, f, opt);
    db.prepare('update sources_config set last_run=?,last_status=?,last_error=? where id=?').run(ts, r.status, r.warning || null, src.id);
    const msg = r.status === 'unchanged' ? 'No new content since last check.' : `${r.first ? 'First run (backfill): ' : ''}Read ${r.items} item(s), ${r.created} new.${r.warning ? ' ' + r.warning : ''}`;
    db.prepare('insert into ingestion_log(source_id,ts,status,message,items) values(?,?,?,?,?)').run(src.id, ts, r.status, msg, r.items);
    return { status: r.status, message: msg, items: r.items, created: r.created || 0, inserted: r.inserted || [] };
  } catch (e) {
    db.prepare('update sources_config set last_run=?,last_status=?,last_error=? where id=?').run(ts, 'error', e.message, src.id);
    db.prepare('insert into ingestion_log(source_id,ts,status,message,items) values(?,?,?,?,0)').run(src.id, ts, 'error', e.message);
    return { status: 'error', message: e.message, items: 0, created: 0, inserted: [] };
  }
}
async function runAll(db, f = fetch, opt = {}) {
  if (running) return [];
  running = true;
  try {
    const all = [];
    for (const src of db.prepare('select * from sources_config where enabled=1').all()) all.push(...(await runLogged(db, src, f, opt)).inserted);
    linkModelPapers(db);
    prune(db);
    return all;
  } finally { running = false; }
}
// Refresh one source on request, even if it is paused. Shares the lock with the full run so two fetches never overlap; returns null when busy.
async function runOne(db, id, f = fetch, opt = {}) {
  const src = db.prepare('select * from sources_config where id=?').get(id); if (!src) return undefined;
  if (running) return null;
  running = true;
  try { const r = await runLogged(db, src, f, opt); linkModelPapers(db); return r; } finally { running = false; }
}
const isRunning = () => running;

// Reads a source once and reports what it found, without saving anything. Lets an admin check an address before adding it.
async function probe(kind, cfg, f = fetch) {
  if (kind === 'huggingface') {
    const r = await fetchRes(hfUrl({ ...cfg, limit: 5 }), f, hfHeaders()), items = parseHuggingFace(r.text);
    return { found: items.length, sample: items.slice(0, 3).map(x => x.name), note: items.length ? '' : 'The account exists but has no public models, or the name is wrong.' };
  }
  if (kind === 'github') {
    const r = await fetchRes(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases?per_page=5`, f, process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}), items = parseGitHub(r.text);
    return { found: items.length, sample: items.slice(0, 3).map(x => `${x.name} (${x.tag})`), note: items.length ? '' : 'The repository exists but has published no releases yet.' };
  }
  if (kind === 'feed') {
    const r = await fetchRes(cfg.url, f), items = parseFeed(r.text);
    if (!items.length) throw new Error('That address did not return a readable RSS or Atom feed.');
    return { found: items.length, sample: items.slice(0, 3).map(x => x.title), note: '' };
  }
  throw new Error('This source type cannot be tested here.');
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

module.exports = { parseCurated, parseOpenRouter, runAll, runOne, runSource, probe, isRunning, enrichModel, parseHuggingFace, parseGitHub, parseArxiv, parseFeed, describeModel };
