'use strict';
// The public, read-only surface: stable JSON shapes for /api/v1, an RSS feed, and the small embeddable widget.
// Everything here is formatting only. The shapes are deliberately small and documented, so they can stay stable while the app changes.

const TYPE = { huggingface: 'model', openrouter: 'model', curated: 'model', arxiv: 'paper', 'github-release': 'release', blog: 'blog' };
const TYPE_BY_CAT = { 'Model Release': 'model', Trending: 'model', Research: 'paper', 'Open Source': 'release', Announcement: 'blog' };
const SOURCE = { huggingface: 'Hugging Face', openrouter: 'OpenRouter', curated: 'Official list', arxiv: 'arXiv', 'github-release': 'GitHub', blog: 'Blog' };
const ATTRIBUTION = 'Data from Signalstack. Every item links to its original source; please credit Signalstack when you republish it.';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Characters that are not allowed in XML 1.0 are dropped so one odd title can never break the whole feed.
const xml = s => esc(String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ''));
const httpUrl = u => (/^https?:\/\//i.test(u || '') ? u : null);
// Event timestamps are stored as UTC; return them as ISO 8601.
const iso = t => { if (!t) return null; const s = String(t).trim(); const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.length === 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + (s.length === 16 ? ':00Z' : 'Z')); return isNaN(d) ? null : d.toISOString(); };

const typeOf = s => TYPE[s.source_type] || TYPE_BY_CAT[s.cat] || 'update';
const v1Signal = s => ({
  id: s.id, type: typeOf(s), title: s.title, summary: s.detail || (s.summary !== s.title ? s.summary : null), published_at: iso(s.ts),
  source: { name: SOURCE[s.source_type] || null, url: httpUrl(s.url), verification: s.verification, on_official_domain: !!s.official_domain },
  lab: s.company_id ? { id: s.company_id, name: s.company } : null, model_id: s.model_id || null,
  score: s.score, importance: s.importance, why_it_matters: s.matters || null,
});
const v1Model = m => ({
  id: m.id, name: m.name, lab: m.company_id ? { id: m.company_id, name: m.company } : null, publisher: m.creator || null, access: ['openrouter', 'curated'].includes(m.source_type) ? 'api' : 'open-weights',
  released_at: m.released_at || null, date_means: m.date_kind, parameters: m.params, license: m.license, task: m.pipeline, context_tokens: m.context_length,
  price_per_million_tokens: m.price_in == null ? null : { input: m.price_in, output: m.price_out }, verification: m.verification, source_url: httpUrl(m.provider_url || m.url),
});

function rss(items, { base, title, desc, self }) {
  const body = items.map(s => {
    const link = httpUrl(s.url) || base, d = [s.summary && s.summary !== s.title ? s.summary : '', s.matters ? 'Why this matters: ' + s.matters : '', `Source: ${SOURCE[s.source_type] || 'original'} (${s.verification_label || s.verification})`].filter(Boolean).join('\n\n');
    return `<item><title>${xml(s.title)}</title><link>${xml(link)}</link><guid isPermaLink="false">signalstack-${s.id}</guid><pubDate>${new Date(iso(s.ts) || Date.now()).toUTCString()}</pubDate><category>${xml(typeOf(s))}</category><description>${xml(d)}</description></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(title)}</title><link>${xml(base)}</link><description>${xml(desc)}</description><language>en</language><atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>${body}</channel></rss>`;
}

// A server-rendered widget: no scripts, no inline styles (the site's CSP forbids both), styled by /css/embed.css.
function embedHtml(items, { base, title, theme }) {
  const rows = items.map(s => `<li><a class="t" href="${esc(httpUrl(s.url) || base)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><span class="m"><span class="b b-${esc(s.source_type || 'x')}">${esc(SOURCE[s.source_type] || 'Source')}</span><span>${esc(typeOf(s))}</span><span>score ${esc(s.score)}</span></span></li>`).join('');
  return `<!doctype html><html lang="en" data-theme="${theme === 'light' ? 'light' : 'dark'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/css/embed.css"></head><body><h1>${esc(title)}</h1>${items.length ? `<ol>${rows}</ol>` : '<p class="none">Nothing new right now.</p>'}<p class="by">Powered by <a href="${esc(base)}" target="_blank" rel="noopener">Signalstack</a>. Every item links to its original source.</p></body></html>`;
}

module.exports = { v1Signal, v1Model, rss, embedHtml, esc, xml, iso, ATTRIBUTION, typeOf };
