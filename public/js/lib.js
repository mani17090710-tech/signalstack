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

// Requests give up after 25 s instead of spinning forever. A GET that fails because the host is still waking up (network error, 502/503/504)
// is retried twice; writes are never retried, so nothing is submitted twice.
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function api(p, method = 'GET', body) {
  for (let tries = 0; ; tries++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch('/api' + p, { method, signal: ctl.signal, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      if (method === 'GET' && [502, 503, 504].includes(r.status) && tries < 2) { await sleep(1500 * (tries + 1)); continue; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.code = r.status; throw e; }
      return d;
    } catch (x) {
      if (x.code) throw x;
      if (method === 'GET' && tries < 2) { await sleep(1500 * (tries + 1)); continue; }
      const e = new Error(x.name === 'AbortError' ? 'The server is taking too long to answer' : 'Could not reach the server'); e.code = x.name === 'AbortError' ? 'timeout' : 'offline'; throw e;
    } finally { clearTimeout(timer); }
  }
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
export const shortName = id => String(id || '').replace(/^(hf|or|cu):/, '');
export const ctxLabel = n => (!n ? null : n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M tokens' : n >= 1e3 ? Math.round(n / 1e3) + 'K tokens' : n + ' tokens');
export const priceLabel = m => (m.price_in == null || m.price_out == null ? null : `$${m.price_in} in, $${m.price_out} out per 1M tokens`);
export const DATE_LABEL = { released: 'Released', listed: 'Added to OpenRouter', published: 'Published on Hugging Face' };
export const dateLabel = m => DATE_LABEL[m.date_kind] || 'Released';
export const isApi = m => m.source_type === 'openrouter' || m.source_type === 'curated';
export const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
export const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

export const CAT_LABEL = { vision: 'Vision', video: 'Video', audio: 'Audio', multimodal: 'Multimodal', coding: 'Coding', reasoning: 'Reasoning', agentic: 'Agents' };
export const SIGNAL_LABEL = { 'Model Release': 'New model', Trending: 'Trending', Research: 'Research', 'Open Source': 'Software release', Announcement: 'Announcement' };

// ---------- components ----------
// Discovery and verification are different questions. These four statuses answer only the second one: who confirms it.
export const VER = {
  verified: ['🟢', 'Verified', 'Confirmed by the official provider: its own announcement or API documentation lists this.'],
  source_verified: ['🔷', 'Source Verified', 'The information comes directly from the original publisher (for example its own Hugging Face account, release feed or arXiv), but is not matched to official provider documentation.'],
  aggregator_listed: ['🟡', 'Aggregator Listed', 'Found in a catalogue such as OpenRouter or the Hugging Face community. The catalogue is not the provider, so this is not confirmed as an official release.'],
  unverified: ['⚪', 'Unverified', 'Not enough reliable evidence on record.'],
};
export const verBadge = v => { const k = VER[v] ? v : 'unverified', [i, l, t] = VER[k]; return html`<span class="ver ver-${k}" title="${t}"><span aria-hidden="true">${i}</span> ${l}</span>`; };
export const verLegend = () => html`<details class="legend"><summary>What do the badges mean?</summary><dl>${Object.entries(VER).map(([k, [i, l, t]]) => html`<dt>${i} ${l}</dt><dd>${t}</dd>`)}</dl><p>Finding a model somewhere (discovery) never makes it Verified. Only evidence from the publisher itself does. Verified describes where the information comes from; it does not mean its claims were independently tested.</p></details>`;
export const FIGURE_SOURCE = { official: 'from the provider', openrouter: 'per OpenRouter listing (third party)' };
export const figureSource = s => (s ? FIGURE_SOURCE[s] || s : '');
export const SOURCE_NAME = { huggingface: 'Hugging Face', openrouter: 'OpenRouter catalogue', curated: 'Official list (hand-kept)' };
export const EVIDENCE_LABEL = { model_card_tag: 'Cited on the model card', official_entry: 'Listed in the provider\u2019s own entry', abstract_link: 'The paper links to this model' };

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

// ---------- signal card ----------
// Where a signal came from (colour-coded) and what kind of thing it is. Both are read from the source type the ingester stored, never guessed.
const SRC = { huggingface: ['hf', 'Hugging Face'], openrouter: ['or', 'OpenRouter'], curated: ['off', 'Official'], arxiv: ['arx', 'arXiv'], 'github-release': ['gh', 'GitHub'], blog: ['blog', ''] };
const TYPE = { huggingface: 'Model', openrouter: 'Model', curated: 'Model', arxiv: 'Paper', 'github-release': 'Release', blog: 'Blog' };
const TYPE_BY_CAT = { 'Model Release': 'Model', Trending: 'Model', Research: 'Paper', 'Open Source': 'Release', Announcement: 'Blog' };
const TYPE_ICON = {
  Model: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>',
  Paper: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  Release: '<path d="M3 12l9-9h7v7l-9 9z"/><circle cx="15" cy="7" r="1.2"/>',
  Blog: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  Update: '<circle cx="12" cy="12" r="8"/>',
};
export const signalType = s => TYPE[s.source_type] || TYPE_BY_CAT[s.cat] || 'Update';
export const sourceInfo = s => { const k = SRC[s.source_type]; return [k ? k[0] : 'other', (k && k[1]) || host(s.url) || 'Source']; };
// Release notes and abstracts can carry markdown; show them as plain sentences.
const plain = t => String(t || '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_>#]+/g, ' ').replace(/\s+/g, ' ').trim();

const card = (s, lead) => {
  const type = signalType(s), [sk, sname] = sourceInfo(s), url = safeUrl(s.url), sum = plain(s.detail || (s.summary !== s.title ? s.summary : ''));
  return html`<article class="sig src-${sk} ${lead ? 'sig-lead' : ''}">
    <header class="sc-top">
      <div class="sc-chips"><span class="sc-type"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(TYPE_ICON[type])}</svg>${type}</span><span class="srcb">${sname}</span><time class="sc-time" data-ts="${s.ts}" title="${stamp(s.ts)}">${ago(s.ts)}</time></div>
      ${scoreRing(s.score)}
    </header>
    <h3>${s.model_id ? html`<a href="#model/${mid(s.model_id)}">${s.title}</a>` : url ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</h3>
    ${sum ? html`<p class="sc-sum">${sum}</p>` : ''}
    <div class="sc-meta">${s.company ? html`<a class="tag co" href="#company/${s.company_id}">${s.company}</a>` : ''}${verBadge(s.verification)}<span class="imp imp-${s.importance}">${s.importance}</span></div>
    <div class="sc-act">${url ? html`<a class="btn-src" href="${url}" target="_blank" rel="noopener noreferrer">Open original source <span aria-hidden="true">↗</span></a>` : html`<span class="btn-src off" aria-disabled="true">Source link not available</span>`}${s.model_id ? html`<a class="btn-sec" href="#model/${mid(s.model_id)}">View model</a>` : ''}</div>
    ${scoreBreakdown(s)}</article>`;
};

export const signalCard = s => card(s, false);
export const leadCard = s => card(s, true);

// Compact one-line version for lists that are scanned, not read (the groups on Now). Same colour coding, same source button.
export const signalRow = s => {
  const type = signalType(s), [sk, sname] = sourceInfo(s), url = safeUrl(s.url);
  return html`<article class="sig-row src-${sk}">${scoreRing(s.score)}
    <div class="sr-main"><h3>${s.model_id ? html`<a href="#model/${mid(s.model_id)}">${s.title}</a>` : url ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</h3>
      <p class="sr-meta"><span class="sc-type">${type}</span><span class="srcb">${sname}</span><time data-ts="${s.ts}" title="${stamp(s.ts)}">${ago(s.ts)}</time>${s.company ? html`<a class="sr-co" href="#company/${s.company_id}">${s.company}</a>` : ''}</p></div>
    ${url ? html`<a class="sr-go" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="Open original source for ${s.title}" title="Open original source">↗</a>` : ''}</article>`;
};

export const modelCard = m => html`<article class="mcard">
  <div class="mc-top"><a class="mc-name" href="#model/${mid(m.id)}">${shortName(m.id).split('/').pop()}</a>${m.trend_rank ? html`<span class="tag">Trending #${m.trend_rank}</span>` : ''}</div>
  <p class="mc-by">${m.company ? html`<a href="#company/${m.company_id}">${m.company}</a>` : m.creator || 'Unknown publisher'}</p>
  <div class="tags">${m.cats.slice(0, 3).map(c => html`<span class="tag">${CAT_LABEL[c] || c}</span>`)}${m.pipeline && !m.cats.length ? html`<span class="tag">${m.pipeline}</span>` : ''}${verBadge(m.verification)}</div>
  <dl class="facts">${isApi(m) ? html`<div><dt>Context</dt><dd>${ctxLabel(m.context_length) || NA}</dd></div><div><dt>Input price</dt><dd>${m.price_in == null ? NA : '$' + m.price_in + ' / 1M'}</dd></div><div><dt>Output price</dt><dd>${m.price_out == null ? NA : '$' + m.price_out + ' / 1M'}</dd></div><div><dt>${dateLabel(m)}</dt><dd>${day(m.released_at)}</dd></div>`
    : html`<div><dt>Size</dt><dd>${m.params || NA}</dd></div><div><dt>Likes</dt><dd>${num(m.likes)}</dd></div><div><dt>Downloads</dt><dd>${num(m.downloads)}</dd></div><div><dt>${dateLabel(m)}</dt><dd>${day(m.released_at)}</dd></div>`}</dl>
  <button class="mini" data-watch="${m.id}">${state.watch.includes(m.id) ? 'Watching' : 'Watch'}</button></article>`;

// Loading placeholder shaped like a signal card, so the page does not jump when the real cards arrive. After a few seconds it explains the wait
// (pure CSS, no timers): free hosting sleeps when idle and the first request can take up to a minute.
export const skeleton = (n = 4) => html`<div class="skel" aria-busy="true" aria-label="Loading"><div class="sk-list">${Array.from({ length: n }, () => html`<div class="sk"><b class="sk-ring"></b><div><i></i><i></i><i></i></div></div>`)}</div>
  <p class="slow" role="status">Still loading. The server may be waking up after a quiet spell; the first visit can take up to a minute.</p></div>`;
const EMPTY_ICON = { signal: '<path d="M4 18a8 8 0 0 1 8-8m-8 8a14 14 0 0 1 14-14M4 18h.01"/>', filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>', data: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' };
export const empty = (title, body, action, kind = 'data') => html`<div class="empty"><svg class="empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(EMPTY_ICON[kind] || EMPTY_ICON.data)}</svg><h3>${title}</h3><p>${body}</p>${action ? html`<div class="empty-act">${action}</div>` : ''}</div>`;
export const failed = e => html`<div class="empty err"><svg class="empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw('<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>')}</svg><h3>This page didn’t load</h3><p>${e.message}. Your connection or the server may be slow; nothing was lost.</p><div class="empty-act"><button class="pri" data-action="reload">Try again</button></div></div>`;
export const pageHead = (title, sub, extra) => html`<header class="phead"><div><h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}</div>${extra || ''}</header>`;
// "Last updated 4 min ago" with a live dot. main.js refreshes every [data-ts] text once a minute, so the wording never goes stale on screen.
export const checked = t => html`<span class="upd ${t && Date.now() - parse(t) > 36e5 ? 'stale' : ''}" title="${t ? stamp(t) : 'No update recorded yet'}"><i class="upd-dot" aria-hidden="true"></i>Last updated <b data-ts="${t || ''}">${t ? ago(t) : 'not yet'}</b></span>`;
