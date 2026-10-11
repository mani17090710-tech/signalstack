'use strict';
// DISCOVERY is not VERIFICATION.
//
// Discovery says "something exists": a model turned up in Hugging Face, OpenRouter, a feed. Every sighting is stored
// in model_sources and never changes the verification status by itself.
//
// Verification says "the original provider confirms it". It is derived only from EVIDENCE rows (model_evidence):
//   verified          the official provider confirms it: linked to its own announcement or documentation
//   source_verified   the information comes directly from the original publisher (for example the lab's own
//                     Hugging Face account, its own blog or repository, or arXiv for a paper). It has not been
//                     separately checked against the provider's documentation
//   aggregator        discovered through a catalogue (OpenRouter, Hugging Face rankings) and nothing more
//   unverified        not enough reliable evidence
//
// A model with no evidence is "aggregator" if some catalogue lists it, otherwise "unverified".

const LEVELS = {
  verified: { rank: 3, label: 'Verified', desc: 'Confirmed by the official provider. It links to the provider’s own announcement or documentation.' },
  source_verified: { rank: 2, label: 'Source verified', desc: 'The information comes directly from the original publisher, such as the lab’s own Hugging Face account, its blog or repository, or arXiv. It has not been separately checked against the provider’s documentation.' },
  aggregator: { rank: 1, label: 'Aggregator listed', desc: 'Discovered through a catalogue such as OpenRouter or Hugging Face rankings. Not independently verified.' },
  unverified: { rank: 0, label: 'Unverified', desc: 'There is not enough reliable evidence.' },
};
const rank = v => (LEVELS[v] ? LEVELS[v].rank : 0);
const isLevel = v => Object.prototype.hasOwnProperty.call(LEVELS, v);

// Config tier of a source feed -> the level its own content can claim. Only a primary (original publisher) source
// reaches source_verified; everything else stays aggregator.
const levelOfTier = tier => (tier === 'primary' ? 'source_verified' : 'aggregator');

// Models from different sources are matched on a canonical key: lowercase "publisher/name", with a trailing
// release-date suffix removed (e.g. "-20261007" or "-2026-10-07"). Nothing fuzzier than that: similar names are not matches.
function canonKey(id) {
  return String(id || '').trim().toLowerCase().replace(/[-_.](20\d{6}|20\d{2}-\d{2}-\d{2})$/, '');
}

// Recompute and store a model's status from its evidence. Called after any change to its evidence or sources.
function recompute(db, modelId) {
  const ev = db.prepare('select level,verified_at from model_evidence where model_id=?').all(modelId);
  let best = null, at = null;
  for (const e of ev) {
    if (!best || rank(e.level) > rank(best)) best = e.level;
    if (e.verified_at && (!at || e.verified_at > at)) at = e.verified_at;
  }
  let level = best;
  if (!level) level = db.prepare('select 1 from model_sources where model_id=?').get(modelId) ? 'aggregator' : 'unverified';
  db.prepare('update models set verification=?,verified_at=? where id=?').run(level, at, modelId);
  return level;
}

module.exports = { LEVELS, rank, isLevel, levelOfTier, canonKey, recompute };
