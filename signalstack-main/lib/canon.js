'use strict';
// Canonical model records. The same model often shows up in several places (Hugging Face, OpenRouter, a lab's own
// list). Each real-world model gets ONE row in `models`; every place that listed it is attached as a row in
// `model_sources`. Two listings are treated as the same model only when their normalised identifiers match exactly,
// or when a source states the link itself (OpenRouter's hugging_face_id, a hand-kept entry's openrouter_id).
// Names that merely look alike are never merged.
const nowIso = () => new Date().toISOString();

// "Qwen/Qwen3-8B" and "qwen/qwen3-8b" are the same identifier. Dots and digits are kept as they are.
const canonKey = (creator, name) => {
  const n = String(name || '').trim();
  const full = n.includes('/') ? n : (creator ? creator + '/' + n : n);
  return full.toLowerCase().replace(/[\s_]+/g, '-');
};

// Which row survives when two are merged: Hugging Face (the model's own files) > hand-kept official entry > catalogue.
const RANK = { hf: 0, cu: 1, or: 2 };
const kindOf = id => String(id).split(':')[0];
const rankOf = id => (RANK[kindOf(id)] ?? 9);

// All stored rows that match a key, directly or through a registered alias key.
function findAll(db, key, aliasKeys = []) {
  const keys = [key, ...aliasKeys].filter(Boolean);
  const out = new Map();
  const byKey = db.prepare('select * from models where canon_key=?');
  const byAlias = db.prepare("select m.* from model_aliases a join models m on m.id=a.model_id where a.alias=? and a.kind='key'");
  for (const k of keys) for (const r of [...byKey.all(k), ...byAlias.all(k)]) out.set(r.id, r);
  return [...out.values()].sort((a, b) => rankOf(a.id) - rankOf(b.id));
}

// Resolves an id from an old link, a watchlist or a bookmark to the model's current id.
function resolveId(db, id) {
  if (db.prepare('select 1 from models where id=?').get(id)) return id;
  const a = db.prepare("select model_id from model_aliases where alias=? and kind='id'").get(id);
  return a ? a.model_id : null;
}

function addAlias(db, alias, modelId, kind) {
  if (!alias || alias === modelId) return;
  db.prepare('insert into model_aliases(alias,model_id,kind) values(?,?,?) on conflict(alias) do update set model_id=excluded.model_id,kind=excluded.kind').run(alias, modelId, kind);
}

// Records that a source lists this model. One row per (model, source, external id); sightings update last_seen.
function attachSource(db, modelId, s) {
  const now = nowIso();
  db.prepare(`insert into model_sources(model_id,source,ext_id,url,first_seen,last_seen,ctx_tokens,price_in,price_out)
    values(?,?,?,?,?,?,?,?,?)
    on conflict(model_id,source,ext_id) do update set last_seen=excluded.last_seen,url=excluded.url,
      ctx_tokens=coalesce(excluded.ctx_tokens,model_sources.ctx_tokens),price_in=coalesce(excluded.price_in,model_sources.price_in),price_out=coalesce(excluded.price_out,model_sources.price_out)`)
    .run(modelId, s.source, s.ext || '', s.url || null, now, now, s.ctx ?? null, s.priceIn ?? null, s.priceOut ?? null);
}

// Folds `dropId` into `keepId`: its sources, evidence, paper links, events, results and watchers move across,
// empty fields on the survivor are filled from it, and its old id keeps resolving through model_aliases.
function mergeModels(db, keepId, dropId) {
  if (keepId === dropId) return;
  const keep = db.prepare('select * from models where id=?').get(keepId), drop = db.prepare('select * from models where id=?').get(dropId);
  if (!keep || !drop) return;
  const fillable = ['arch', 'license', 'pipeline', 'library', 'modality', 'provider_url', 'or_url', 'provider_model_id', 'released_at', 'param_count', 'params_label'];
  const vals = {};
  for (const c of fillable) if ((keep[c] == null || keep[c] === '') && drop[c] != null && drop[c] !== '') vals[c] = drop[c];
  // Context and price travel together with where they came from; an official figure beats a catalogue figure.
  const takeCtx = drop.ctx_tokens != null && (keep.ctx_tokens == null || (keep.ctx_source !== 'official' && drop.ctx_source === 'official'));
  if (takeCtx) Object.assign(vals, { ctx_tokens: drop.ctx_tokens, ctx: drop.ctx, ctx_source: drop.ctx_source });
  const takePrice = drop.price_in != null && (keep.price_in == null || (keep.price_source !== 'official' && drop.price_source === 'official'));
  if (takePrice) Object.assign(vals, { price_in: drop.price_in, price_out: drop.price_out, price: drop.price, price_source: drop.price_source });
  if (kindOf(dropId) === 'cu' && keep.open === 0) vals.source_type = 'curated';
  db.exec('savepoint merge_models');
  try {
    const cols = Object.keys(vals);
    if (cols.length) db.prepare(`update models set ${cols.map(c => c + '=?').join(',')} where id=?`).run(...cols.map(c => vals[c]), keepId);
    db.prepare('update or ignore model_sources set model_id=? where model_id=?').run(keepId, dropId);
    db.prepare('update or ignore model_evidence set model_id=? where model_id=?').run(keepId, dropId);
    db.prepare('update or ignore model_papers set model_id=? where model_id=?').run(keepId, dropId);
    db.prepare('update or ignore watchlist set model_id=? where model_id=?').run(keepId, dropId);
    db.prepare('update events set model_id=? where model_id=?').run(keepId, dropId);
    db.prepare('update results set model_id=? where model_id=?').run(keepId, dropId);
    db.prepare("update model_aliases set model_id=? where model_id=?").run(keepId, dropId);
    addAlias(db, dropId, keepId, 'id');
    if (drop.canon_key && drop.canon_key !== keep.canon_key) addAlias(db, drop.canon_key, keepId, 'key');
    db.prepare('delete from models where id=?').run(dropId); // cascades whatever could not be moved (duplicates)
    db.exec('release merge_models');
  } catch (e) { db.exec('rollback to merge_models'); db.exec('release merge_models'); throw e; }
}

module.exports = { canonKey, findAll, resolveId, addAlias, attachSource, mergeModels, rankOf, kindOf, nowIso };
