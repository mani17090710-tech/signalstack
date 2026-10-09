// Global search, grouped by type.
import { api, html, pageHead, empty, modelCard, safeUrl, stamp, $ } from '../lib.js';

export async function render(q) {
  const input = $('#sq'); if (input && input.value !== q) input.value = q;
  if (q.length < 2) return html`${pageHead('Search', 'Type at least 2 characters.')}`;
  const r = await api('/search?q=' + encodeURIComponent(q));
  const n = ['models', 'companies', 'papers', 'signals', 'benchmarks'].reduce((a, k) => a + (r[k] || []).length, 0);
  const grp = (t, list, row) => list.length ? html`<section class="blk"><header><h2>${t}</h2></header>${row}</section>` : '';
  return {
    title: 'Search: ' + q,
    html: html`${pageHead('Search', `Results for “${q}”`)}
      ${n ? '' : empty('Nothing found', 'Try a model name, a lab such as Qwen, or a research topic.')}
      ${grp('Models', r.models, html`<div class="grid">${r.models.map(modelCard)}</div>`)}
      ${grp('Companies', r.companies, html`<div class="tags">${r.companies.map(c => html`<a class="tag co" href="#company/${c.id}">${c.name}</a>`)}</div>`)}
      ${grp('Research', r.papers, html`<div class="panel rows">${r.papers.map(p => html`<div><h3><a href="${safeUrl(p.url)}" target="_blank" rel="noopener noreferrer">${p.title}</a></h3><p class="meta">${stamp(p.published_at || p.date)}</p></div>`)}</div>`)}
      ${grp('Signals', r.signals, html`<div class="panel rows">${r.signals.map(s => html`<div><h3>${safeUrl(s.url) ? html`<a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</h3><p class="meta">${s.cat}, ${stamp(s.ts)}</p></div>`)}</div>`)}
      ${grp('Benchmarks', r.benchmarks, html`<div class="tags">${r.benchmarks.map(b => html`<a class="tag" href="#benchmarks/${b.id}">${b.name} ${b.ver}</a>`)}</div>`)}`,
  };
}
