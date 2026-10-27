'use strict';
// Rules for editor changes to signals, free of the database so they can be tested alone.

const CATS = ['Model Release', 'Trending', 'Announcement', 'Open Source', 'Research'];
const bad = m => { const e = new Error(m); e.code = 400; return e; };
const isInt = v => typeof v === 'number' ? Number.isInteger(v) : /^\d{1,3}$/.test(String(v).trim());

/** Parses an edit to an existing signal. Fields left out are unchanged; null means "back to automatic". */
function parseUpdate(b) {
  const out = {};
  if ('score' in b) {
    if (b.score === null || b.score === '') out.score = null;
    else { if (!isInt(b.score) || +b.score < 0 || +b.score > 100) throw bad('The score must be a whole number from 0 to 100.'); out.score = +b.score; }
  }
  if ('matters' in b) {
    if (b.matters === null) out.matters = null;
    else { const t = String(b.matters).replace(/\s+/g, ' ').trim(); if (t.length > 400) throw bad('Keep the note to 400 characters or fewer.'); out.matters = t; } // '' = show no note
  }
  if ('hidden' in b) out.hidden = b.hidden ? 1 : 0;
  if (b.reset === true) return { reset: true };
  if (!Object.keys(out).length) throw bad('Nothing to change.');
  return out;
}

/**
 * Parses a signal an editor adds by hand. Provenance is never typed in: it follows from the link.
 * @param ctx { companyIds, isOfficial(companyId,url)->bool, now }
 */
function parseNew(b, ctx) {
  const title = String(b.title || '').replace(/\s+/g, ' ').trim();
  if (title.length < 5 || title.length > 200) throw bad('Give the signal a title of 5 to 200 characters.');
  let u; try { u = new URL(String(b.url || '').trim()); } catch (e) { throw bad('Add the link to the original source, starting with https://'); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw bad('The link must be a normal web address starting with https://');
  const cat = String(b.cat || ''); if (!CATS.includes(cat)) throw bad('Choose what kind of signal it is.');
  const company = b.company ? String(b.company) : null; if (company && !(ctx.companyIds || []).includes(company)) throw bad('That lab is not on our list.');
  const summary = String(b.summary || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  let ts = ctx.now; if (b.ts) { ts = Date.parse(String(b.ts).length === 10 ? b.ts + 'T00:00:00Z' : b.ts); if (isNaN(ts)) throw bad('That date is not valid.'); if (ts > ctx.now + 864e5) throw bad('The date cannot be in the future.'); }
  const url = u.toString(), official = !!(company && ctx.isOfficial(company, url));
  const extra = {}; if ('score' in b && b.score !== '' && b.score !== null) Object.assign(extra, { score: parseUpdate({ score: b.score }).score });
  if (b.matters) Object.assign(extra, { matters: parseUpdate({ matters: b.matters }).matters });
  return { title, url, cat, company, summary: summary || title, ts: new Date(ts).toISOString().slice(0, 16).replace('T', ' '),
    // Source Verified only when the link is on the lab's own site; anything else is "found elsewhere".
    verification: official ? 'source_verified' : 'aggregator_listed', ...extra };
}

module.exports = { parseUpdate, parseNew, CATS };
