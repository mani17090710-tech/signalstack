'use strict';
// SIGNAL SCORE (0-100). A transparent heuristic, not objective truth.
//
// Five parts, each 0-100, each computed only from evidence we actually hold. A part with no evidence is left
// out (null) and the score is the weighted average of the parts that remain, so missing data never counts as
// "bad" and is never invented.
//
//   impact        how fast a model is being adopted (downloads per day since release)
//   popularity    likes and downloads of the model, or likes of models that cite the paper
//   technical     parameter count of a model, or how big a software release is (major / minor / patch)
//   relevance     whether a tracked lab is involved (official publisher, or named in a paper)
//   freshness     how recent it is (fades with a 3-day time constant)
//
// Models younger than 12 hours have had no time to gather traction, so impact and popularity are left out.

const { formatCount } = require('./classify');
const WEIGHTS = { impact: 0.2, popularity: 0.2, technical: 0.2, relevance: 0.25, freshness: 0.15 };
const HOUR = 36e5;
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const logPct = (v, max) => (v > 0 ? clamp((100 * Math.log10(1 + v)) / Math.log10(1 + max)) : 0);
const round = x => (x == null ? null : Math.round(x));

// Accepts 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM' (UTC) or a full ISO string.
function parseTs(ts) {
  if (!ts) return NaN;
  const s = String(ts).trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  if (s.length === 10) return Date.parse(s + 'T00:00:00Z');
  if (s.length === 16) return Date.parse(s.replace(' ', 'T') + ':00Z');
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

const freshness = (t, now) => (isNaN(t) ? null : clamp(100 * Math.exp(-Math.max(0, now - t) / HOUR / 72)));

function semverSize(tag) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(tag || ''));
  if (!m) return null;
  const minor = +m[2], patch = m[3] == null ? 0 : +m[3];
  if (minor === 0 && patch === 0) return { score: 85, label: 'major release' };
  if (patch === 0) return { score: 60, label: 'minor release' };
  return { score: 30, label: 'patch release' };
}

const compact = n => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.0', '') + 'k' : String(n));
const ago = (t, now) => {
  const m = Math.max(0, Math.round((now - t) / 6e4));
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
};

/**
 * @param {object} s  { cat, ts, model?: {likes,downloads,param_count,released_at,company_id,creator}, companyName?, meta?, mentions?, refLikes?, tier? }
 */
function scoreSignal(s, now = Date.now()) {
  const parts = { impact: null, popularity: null, technical: null, relevance: null, freshness: null };
  const why = [];
  const t = parseTs(s.ts);
  parts.freshness = freshness(t, now);
  if (!isNaN(t)) why.push('Published ' + ago(t, now));
  const m = s.model;

  if (m) {
    const released = parseTs(m.released_at) || t;
    const ageH = Math.max(0, (now - (isNaN(released) ? t : released)) / HOUR);
    const likes = +m.likes || 0, downloads = +m.downloads || 0;
    if (ageH >= 12 || likes || downloads) {
      parts.popularity = 0.6 * logPct(likes, 5000) + 0.4 * logPct(downloads, 5e6);
      parts.impact = logPct(downloads / Math.max(1, ageH / 24), 2e5);
      if (likes) why.push(compact(likes) + ' likes');
      if (downloads) why.push(compact(downloads) + ' downloads');
    } else {
      why.push('Too new to have adoption data');
    }
    if (+m.param_count > 0) {
      parts.technical = clamp((100 * (Math.log10(m.param_count) - 7)) / 5);
      why.push(formatCount(m.param_count) + ' parameters');
    }
    if (m.company_id) { parts.relevance = 92; why.push('Published by ' + (s.companyName || 'a tracked lab')); }
    else { parts.relevance = 35; why.push('Community upload (not from a tracked lab)'); }
  } else if (s.cat === 'Research') {
    if (s.mentions && s.mentions.length) { parts.relevance = 55; why.push('Names a tracked lab or model family'); }
    else { parts.relevance = 30; why.push('Does not name a tracked lab or model family'); }
    if (s.refLikes > 0) {
      parts.popularity = logPct(s.refLikes, 5000);
      why.push('Cited by models with ' + compact(s.refLikes) + ' likes');
    }
  } else if (s.cat === 'Open Source') {
    const v = semverSize(s.meta && s.meta.tag);
    if (v) { parts.technical = v.score; why.push('Version number marks a ' + v.label); }
    parts.relevance = s.companyName ? 85 : 70;
    why.push(s.companyName ? 'Official repository of ' + s.companyName : 'Key open-source AI project');
  } else if (s.cat === 'Announcement') {
    if (s.tier === 'primary') { parts.relevance = 92; why.push('Official announcement from ' + (s.companyName || 'the publisher')); }
    else { parts.relevance = 65; why.push('Community post on a tracked platform'); }
  }

  let num = 0, den = 0;
  for (const k of Object.keys(WEIGHTS)) if (parts[k] != null) { num += parts[k] * WEIGHTS[k]; den += WEIGHTS[k]; }
  const score = den ? Math.round(num / den) : 0;
  const rounded = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v)]));
  return { score, importance: score >= 80 ? 'Major' : score >= 60 ? 'Important' : 'Normal', parts: rounded, why };
}

module.exports = { scoreSignal, parseTs, WEIGHTS, SIGNIFICANT: 60 };
