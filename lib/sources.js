'use strict';
// Source management rules, kept free of the database and the network so they can be tested on their own:
// what a new source must look like, what an existing one watches, and whether it is healthy.

const KIND_LABEL = { huggingface: 'Hugging Face', github: 'GitHub', feed: 'Blog / RSS', arxiv: 'arXiv', arxiv_cited: 'arXiv', openrouter: 'OpenRouter', curated: 'Curated list' };
const ADDABLE = ['huggingface', 'github', 'feed'];
const slug = s => String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const bad = m => { const e = new Error(m); e.code = 400; return e; };

// A hostname that can never be a public website: loopback, private ranges written as IP literals, and internal names.
function privateHost(h) {
  h = String(h).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.') && !h.includes(':')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) { const [a, b] = h.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224; }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || h.startsWith('fe80');
  return false;
}
// The same test for an address a name resolved to (used after a DNS lookup).
const privateAddress = a => privateHost(a);

/**
 * Turns what an admin typed into a source row, or throws a plain-language error (code 400).
 * @param {object} b  { kind, author | repo | url, label?, company?, tier? }
 * @param {{companyIds:Set<string>|string[], version:number}} ctx
 */
function build(b, ctx) {
  const kind = String(b.kind || ''); if (!ADDABLE.includes(kind)) throw bad('Choose a source type: Hugging Face account, GitHub repository, or blog / RSS feed.');
  const tier = b.tier === 'primary' ? 'primary' : 'community', company = b.company ? String(b.company) : '';
  const ids = new Set(ctx.companyIds || []); if (company && !ids.has(company)) throw bad('That lab is not on our list.');
  const v = ctx.version;
  if (kind === 'huggingface') {
    const author = String(b.author || '').trim().replace(/^https?:\/\/huggingface\.co\//i, '').replace(/\/.*$/, '');
    if (!/^[A-Za-z0-9][\w.-]{0,95}$/.test(author)) throw bad('Enter a Hugging Face user or organisation name, like "Qwen" or "meta-llama".');
    return { id: 'hf-org-' + author.toLowerCase(), kind, label: `Hugging Face — ${author}`, watch: 'https://huggingface.co/' + author,
      config: { v, author, sort: 'createdAt', limit: 50, pages: 2, backfillPages: 4, events: 'release', backfillEvents: 3, ...(company && { company }), tier } };
  }
  if (kind === 'github') {
    const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]{0,38})\/([\w.-]{1,100}?)(?:\.git)?\/?$/i.exec(String(b.repo || '').trim());
    if (!m) throw bad('Enter a repository as "owner/name" or paste its GitHub link.');
    const [, owner, repo] = m;
    return { id: 'gh-' + slug(owner + '-' + repo), kind, label: `GitHub — ${owner}/${repo}`, watch: `https://github.com/${owner}/${repo}`, config: { v, owner, repo, ...(company && { company }), tier } };
  }
  let u; try { u = new URL(String(b.url || '').trim()); } catch (e) { throw bad('Enter the full address of the feed, starting with https://'); }
  if (u.protocol !== 'https:') throw bad('Feeds must use https:// so we know who we are reading from.');
  if (u.username || u.password) throw bad('The address must not contain a username or password.');
  if (privateHost(u.hostname)) throw bad('That address points inside a private network. Use a public website.');
  const url = u.toString(); if (url.length > 300) throw bad('That address is too long.');
  const label = String(b.label || '').trim().slice(0, 80) || u.hostname.replace(/^www\./, '');
  const key = slug(u.hostname + u.pathname);
  return { id: 'feed-' + key, kind, label, watch: url, config: { v, url, org: { id: 'feed-' + key, name: label }, ...(company && { company }), tier } };
}

// What an existing source watches: a human line and, where there is one, the web address to open.
function watches(src) {
  let c = {}; try { c = JSON.parse(src.config || '{}'); } catch (e) { /* bad config shows as unknown */ }
  switch (src.kind) {
    case 'huggingface': return c.author ? { text: 'Models published by ' + c.author, url: 'https://huggingface.co/' + c.author } : { text: `Hugging Face listing, sorted by ${c.sort || 'date'}`, url: 'https://huggingface.co/models' };
    case 'github': return { text: `Releases of ${c.owner}/${c.repo}`, url: `https://github.com/${c.owner}/${c.repo}/releases` };
    case 'feed': return { text: c.url || 'Feed', url: c.url || null };
    case 'arxiv': return { text: c.category ? 'Papers in ' + c.category : 'arXiv search: ' + (c.query || ''), url: c.category ? 'https://arxiv.org/list/' + c.category + '/recent' : null };
    case 'arxiv_cited': return { text: 'Papers that tracked models cite', url: null };
    case 'openrouter': return { text: 'OpenRouter model catalogue', url: 'https://openrouter.ai/models' };
    case 'curated': return { text: 'Hand-kept list in the project files', url: null };
    default: return { text: src.kind, url: null };
  }
}

const OK = new Set(['ok', 'unchanged', 'warning']);
const ms = t => (t ? Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(String(t)) ? t : String(t).replace(' ', 'T') + 'Z') : NaN);

/**
 * @param src     a sources_config row
 * @param recent  its newest-first ingestion_log rows [{ts,status,message}]
 * @returns {{state, failures, failingSince, lastOk}}
 *  state: paused | new | failing | warning | stale | healthy
 */
function health(src, recent, now = Date.now(), intervalMin = 30) {
  let failures = 0; for (const r of recent) { if (r.status === 'error') failures++; else break; }
  const lastOkRow = recent.find(r => OK.has(r.status)), streak = recent.slice(0, failures);
  const out = { failures, failingSince: failures ? streak[streak.length - 1].ts : null, lastOk: lastOkRow ? lastOkRow.ts : null };
  if (!src.enabled) return { ...out, state: 'paused' };
  if (!src.last_run) return { ...out, state: 'new' };
  if (src.last_status === 'error') return { ...out, state: 'failing' };
  const age = now - ms(src.last_run);
  if (!isNaN(age) && age > Math.max(3 * intervalMin * 6e4, 3 * 36e5)) return { ...out, state: 'stale' };
  return { ...out, state: src.last_status === 'warning' ? 'warning' : 'healthy' };
}
const ORDER = { failing: 0, stale: 1, warning: 2, new: 3, healthy: 4, paused: 5 };

module.exports = { build, watches, health, privateHost, privateAddress, ORDER, KIND_LABEL, ADDABLE };
