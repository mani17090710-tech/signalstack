'use strict';
// Verification layer. It is deliberately separate from discovery.
//
//   Discovery says "this model exists somewhere" (rows in model_sources: Hugging Face, OpenRouter, a hand-kept list).
//   Verification says "who confirms it" (rows in model_evidence, each with a link and a check time).
//
// A model is never promoted by being discovered, or by being discovered in more places. Only evidence from the
// publisher itself raises the status:
//
//   verified           confirmed by the official provider (its announcement or API documentation on its own domain)
//   source_verified    comes directly from the original publisher (its own Hugging Face namespace or release feed)
//   aggregator_listed  discovered through a catalogue (OpenRouter, Hugging Face community uploads), not confirmed
//   unverified         no reliable evidence on record
const STATUSES = ['verified', 'source_verified', 'aggregator_listed', 'unverified'];
const RANK = { verified: 3, source_verified: 2, aggregator_listed: 1, unverified: 0 };

// What each kind of evidence is worth. Only the first two can make a model "verified".
const KINDS = {
  official_announcement: { status: 'verified', label: 'Official announcement' },
  official_docs: { status: 'verified', label: 'Official documentation' },
  publisher_namespace: { status: 'source_verified', label: 'Published under the lab’s own account' },
  publisher_release: { status: 'source_verified', label: 'Published by the original publisher' },
  aggregator: { status: 'aggregator_listed', label: 'Listed in a catalogue' },
};

const LABEL = { verified: 'Verified', source_verified: 'Source Verified', aggregator_listed: 'Aggregator Listed', unverified: 'Unverified' };
const MEANING = {
  verified: 'Confirmed by the official provider: its own announcement or API documentation lists this model.',
  source_verified: 'The information comes directly from the original publisher (for example its own Hugging Face account), but we have not matched it to the provider’s official documentation.',
  aggregator_listed: 'Discovered through a catalogue such as OpenRouter or the Hugging Face community. The catalogue is not the provider, so this is not confirmed as an official release.',
  unverified: 'There is not enough reliable evidence on record for this model.',
};

const nowIso = () => new Date().toISOString();

// Records (or re-confirms) one piece of evidence. Re-confirming updates its check time and keeps one row per link.
function addEvidence(db, modelId, kind, url, note) {
  if (!KINDS[kind]) throw new Error('Unknown evidence kind: ' + kind);
  db.prepare(`insert into model_evidence(model_id,kind,status,url,note,checked_at) values(?,?,?,?,?,?)
    on conflict(model_id,kind,url) do update set checked_at=excluded.checked_at,note=coalesce(excluded.note,model_evidence.note)`)
    .run(modelId, kind, KINDS[kind].status, url || '', note || null, nowIso());
}

const deriveStatus = list => list.reduce((best, e) => (RANK[e.status] > RANK[best] ? e.status : best), 'unverified');

// Recomputes a model's status from its evidence only. Nothing else is consulted.
function refreshVerification(db, modelId) {
  const ev = db.prepare('select * from model_evidence where model_id=?').all(modelId);
  const status = deriveStatus(ev);
  // "Last verified" is when the best non-catalogue evidence was last confirmed; catalogue listings never set it.
  const verifiedAt = ev.filter(e => RANK[e.status] >= RANK.source_verified).map(e => e.checked_at).sort().pop() || null;
  db.prepare('update models set verification=?,verified_at=? where id=?').run(status, verifiedAt, modelId);
  return status;
}

function evidenceFor(db, modelId) {
  return db.prepare('select kind,status,url,note,checked_at from model_evidence where model_id=? order by checked_at desc').all(modelId)
    .sort((a, b) => RANK[b.status] - RANK[a.status])
    .map(e => ({ ...e, label: KINDS[e.kind] ? KINDS[e.kind].label : e.kind }));
}

// Maps the old three-level vocabulary, still found in older databases, onto the new four statuses.
const LEGACY = { verified: 'source_verified', reported: 'aggregator_listed', community: 'aggregator_listed' };

module.exports = { STATUSES, RANK, KINDS, LABEL, MEANING, LEGACY, addEvidence, deriveStatus, refreshVerification, evidenceFor };
