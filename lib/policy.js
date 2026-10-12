'use strict';
// Which Hugging Face models SignalStack keeps. One place, so the rule is easy to read and to change.
// Hugging Face hosts millions of repositories. We do not claim to cover them all: we keep official lab releases,
// models that are trending, and community models that have earned real attention. Everything else is skipped,
// and models that later fade (never reached the bar, or stopped being seen) are cleaned up automatically.
const int = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n >= 0 ? n : d; };

const policy = () => ({
  minLikes: int('HF_MIN_LIKES', 20),            // a community model is kept once it has this many likes ...
  minDownloads: int('HF_MIN_DOWNLOADS', 3000),  // ... or this many downloads
  pruneLikes: int('HF_PRUNE_LIKES', 10),        // below both of these, and not seen lately, it is cleaned up
  pruneDownloads: int('HF_PRUNE_DOWNLOADS', 1000),
  graceDays: int('HF_GRACE_DAYS', 14),          // how long a low-traction model is kept after we last saw it
  staleDays: int('HF_STALE_DAYS', 45),          // a model under the keep bar that we have not seen for this long is obsolete
});

// Why a Hugging Face model is kept, or null when it should be skipped.
function keepReason(item, { official = false, trending = false } = {}) {
  const p = policy();
  if (official) return 'official';
  if (trending) return 'trending';
  if ((item.likes || 0) >= p.minLikes || (item.downloads || 0) >= p.minDownloads) return 'popular';
  return null;
}

// Cleanup. Official, watched, referenced (events, benchmark results, papers) and merged models are never removed.
function pruneModels(db) {
  const p = policy();
  const refs = `and id not in (select model_id from results where model_id is not null) and id not in (select model_id from events where model_id is not null)
    and id not in (select model_id from watchlist) and id not in (select model_id from model_papers) and id not in (select model_id from model_evidence where kind in ('official_docs','official_announcement'))`;
  const seen = "coalesce(seen_at,retrieved_at,'1970-01-01')";
  const a = db.prepare(`delete from models where org_id='hf' and company_id is null and likes<? and downloads<? and ${seen}<datetime('now','-' || ? || ' day')
    and (trend_at is null or trend_at<datetime('now','-7 day')) ${refs}`).run(p.pruneLikes, p.pruneDownloads, p.graceDays).changes;
  const b = db.prepare(`delete from models where org_id='hf' and company_id is null and likes<? and downloads<? and ${seen}<datetime('now','-' || ? || ' day')
    and (trend_at is null or trend_at<datetime('now','-7 day')) ${refs}`).run(p.minLikes, p.minDownloads, p.staleDays).changes;
  return a + b;
}

module.exports = { policy, keepReason, pruneModels };
