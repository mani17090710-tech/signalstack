// Shared helpers: safe HTML templates, API client, formatting and small reusable components.

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Safe(String(s));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = v => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(val).join('') : v == null || v === false ? '' : esc(v));
// Tagged template: every interpolated value is escaped unless it came from another html`` call.
export const html = (strs, ...vals) => new Safe(strs.reduce((o, s, i) => o + s + (i < vals.length ? val(vals[i]) : ''), ''));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function mount(el, safe) { el.innerHTML = String(safe); applyBars(el); }
// CSP forbids inline style attributes, so widths are set from data attributes after rendering.
export function applyBars(root) { $$('[data-bar]', root).forEach(e => e.style.setProperty('--v', Math.max(0, Math.min(100, +e.dataset.bar || 0)) + '%')); }

export async function api(p, method = 'GET', body) {
  const r = await fetch('/api' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.code = r.status; throw e; }
  return d;
}

export const state = { me: null, watch: [], status: { counts: {} } };

// ---------- formatting ----------
export const num = n => { n = +n || 0; return n >= 1e9 ? (n / 1e9).toFixed(1).replace('.0', '') + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.0', '') + 'k' : String(n); };
export const NA = 'Not available from source';
const parse = t => { if (!t) return NaN; const s = String(t).trim(); if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s); if (s.length === 10) return Date.parse(s + 'T00:00:00Z'); return Date.parse(s.replace(' ', 'T') + (s.length === 16 ? ':00Z' : 'Z')); };
export const ago = t => {
  const ms = parse(t); if (isNaN(ms)) return 'unknown';
  const m = Math.max(0, Math.round((Date.now() - ms) / 6e4));
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
};
export const day = t => { const ms = parse(t); return isNaN(ms) ? NA : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
export const stamp = t => { const ms = parse(t); return isNaN(ms) ? NA : new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
export const mid = id => encodeURIComponent(id);
export const shortName = id => String(id || '').replace(/^(hf|or):/, '');
export const ctxLabel = n => (!n ? null : n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M tokens' : n >= 1e3 ? Math.round(n / 1e3) + 'K tokens' : n + ' tokens');
export const priceLabel = m => (m.price_in == null || m.price_out == null ? null : `$${m.price_in} in, $${m.price_out} out per 1M tokens`);
export const isApi = m => m.source_type === 'openrouter';
export const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
export const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

export const CAT_LABEL = { vision: 'Vision', video: 'Video', audio: 'Audio', multimodal: 'Multimodal', coding: 'Coding', reasoning: 'Reasoning', agentic: 'Agents' };
export const SIGNAL_LABEL = { 'Model Release': 'New model', Trending: 'Trending', Research: 'Research', 'Open Source': 'Software release', Announcement: 'Announcement' };

// ---------- components ----------
const VER = {
  verified: ['🟢', 'Verified', 'Published by the original source: a lab’s own account, repository or blog, or arXiv itself.'],
  reported: ['🟡', 'Reported', 'Reported by a secondary source rather than the original publisher.'],
  community: ['🔵', 'Community', 'Comes from a community platform such as Hugging Face rankings; not confirmed by the lab.'],
};
export const verBadge = v => { const [i, l, t] = VER[v] || VER.community; return html`<span class="ver ver-${VER[v] ? v : 'community'}" title="${t}"><span aria-hidden="true">${i}</span> ${l}</span>`; };
export const verLegend = () => html`<details class="legend"><summary>What do the badges mean?</summary><dl>${Object.entries(VER).map(([k, [i, l, t]]) => html`<dt>${i} ${l}</dt><dd>${t}</dd>`)}</dl><p>Verified means the item comes straight from its original publisher. It does not mean the claims in it were independently checked or peer reviewed.</p></details>`;

export const sourceLine = it => {
  const u = safeUrl(it.url);
  return html`<p class="src">${u ? html`<a href="${u}" target="_blank" rel="noopener noreferrer">${host(u) || 'Source'}</a>` : html`<span>Source link not available</span>`}
    <span>Published ${stamp(it.ts || it.published_at)}</span><span>Checked ${ago(it.retrieved_at)}</span></p>`;
};

export const scoreRing = (score, big = false) => html`<span class="score ${score >= 80 ? 'hi' : score >= 60 ? 'mid' : 'lo'} ${big ? 'big' : ''}" role="img" aria-label="Signal Score ${score} out of 100"><b>${score}</b></span>`;
const PART_LABEL = { impact: 'Impact', popularity: 'Popularity', technical: 'Technical', relevance: 'Relevance', freshness: 'Freshness' };
export const scoreBreakdown = (s, open = false) => html`<details class="why" ${open ? 'open' : ''}><summary>Why this score</summary>
  <div class="parts">${Object.entries(PART_LABEL).map(([k, l]) => html`<div class="part"><span>${l}</span>${s.parts[k] == null ? html`<em>No data</em>` : html`<span class="track"><i data-bar="${s.parts[k]}"></i></span><b>${s.parts[k]}</b>`}</div>`)}</div>
  <ul>${s.why.map(w => html`<li>${w}</li>`)}</ul>
  <p class="fine">Signal Score is SignalStack’s own estimate built from the evidence listed here. It is not an objective measure. Parts with no data are left out, not counted as zero.</p></details>`;

export const signalCard = s => html`<article class="sig">
  <div class="sig-head">${scoreRing(s.score)}<div class="sig-main">
    <div class="tags"><span class="tag">${SIGNAL_LABEL[s.cat] || s.cat}</span>${s.company ? html`<a class="tag co" href="#company/${s.company_id}">${s.company}</a>` : ''}${verBadge(s.verification)}<span class="imp imp-${s.importance}">${s.importance}</span></div>
    <h3>${s.model_id ? html`<a href="#model/${mid(s.model_id)}">${s.title}</a>` : safeUrl(s.url) ? html`<a href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</h3>
    ${s.detail ? html`<p class="detail">${s.detail}</p>` : ''}
    ${sourceLine(s)}</div></div>${scoreBreakdown(s)}</article>`;

export const modelCard = m => html`<article class="mcard">
  <div class="mc-top"><a class="mc-name" href="#model/${mid(m.id)}">${shortName(m.id).split('/').pop()}</a>${m.trend_rank ? html`<span class="tag">Trending #${m.trend_rank}</span>` : ''}</div>
  <p class="mc-by">${m.company ? html`<a href="#company/${m.company_id}">${m.company}</a>` : m.creator || 'Unknown publisher'}</p>
  <div class="tags">${m.cats.slice(0, 3).map(c => html`<span class="tag">${CAT_LABEL[c] || c}</span>`)}${m.pipeline && !m.cats.length ? html`<span class="tag">${m.pipeline}</span>` : ''}${verBadge(m.verification)}</div>
  <dl class="facts">${isApi(m) ? html`<div><dt>Context</dt><dd>${ctxLabel(m.context_length) || NA}</dd></div><div><dt>Input price</dt><dd>${m.price_in == null ? NA : '$' + m.price_in + ' / 1M'}</dd></div><div><dt>Output price</dt><dd>${m.price_out == null ? NA : '$' + m.price_out + ' / 1M'}</dd></div><div><dt>Released</dt><dd>${day(m.released_at)}</dd></div>`
    : html`<div><dt>Size</dt><dd>${m.params || NA}</dd></div><div><dt>Likes</dt><dd>${num(m.likes)}</dd></div><div><dt>Downloads</dt><dd>${num(m.downloads)}</dd></div><div><dt>Released</dt><dd>${day(m.released_at)}</dd></div>`}</dl>
  <button class="mini" data-watch="${m.id}">${state.watch.includes(m.id) ? 'Watching' : 'Watch'}</button></article>`;

export const skeleton = (n = 4) => html`<div class="skel" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () => html`<div class="sk"><i></i><i></i><i></i></div>`)}</div>`;
export const empty = (title, body, action) => html`<div class="empty"><h3>${title}</h3><p>${body}</p>${action || ''}</div>`;
export const failed = e => html`<div class="empty err"><h3>This page didn’t load</h3><p>${e.message}. <button class="link" data-action="reload">Try again</button></p></div>`;
export const pageHead = (title, sub, extra) => html`<header class="phead"><div><h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}</div>${extra || ''}</header>`;
export const checked = t => html`<span class="checked">Last checked ${ago(t)}</span>`;
