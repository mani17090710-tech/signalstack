// Full search results, grouped by type. Each result says what it is and how it is sourced; every group has its own count.
import { api, html, pageHead, empty, modelCard, safeUrl, stamp, ago, verBadge, SIGNAL_LABEL, mid, $ } from '../lib.js';

const sec = (title, n, body) => (n ? html`<section class="blk"><header><h2>${title} <span class="cnt">${n}</span></h2></header>${body}</section>` : '');

export async function render(q) {
  const input = $('#sq'); if (input && input.value !== q) input.value = q;
  if (q.length < 2) return { title: 'Search', html: html`${pageHead('Search', 'Search models, labs and papers.')}${empty('Type at least 2 characters', 'Try a model name, a lab, an author or an arXiv ID.', html`<a class="btn-sec" href="#models">Browse models</a><a class="btn-sec" href="#research">Browse research</a>`, 'filter')}` };
  const r = await api('/search?q=' + encodeURIComponent(q));
  const n = ['models', 'companies', 'papers', 'signals', 'benchmarks'].reduce((a, k) => a + (r[k] || []).length, 0);
  return {
    title: 'Search: ' + q,
    html: html`${pageHead('Search', n ? html`${n} result${n === 1 ? '' : 's'} for “${q}”. Each result shows its type and how it is sourced.` : html`Results for “${q}”`)}
      ${n ? '' : empty('Nothing found', html`Nothing matches “${q}”. Check the spelling, use fewer words, or search by lab name, author or arXiv ID.`, html`<a class="btn-sec" href="#models">Browse models</a><a class="btn-sec" href="#research">Browse research</a><a class="btn-sec" href="#signals">See all signals</a>`, 'filter')}
      ${sec('Models', r.models.length, html`<div class="grid">${r.models.map(modelCard)}</div>`)}
      ${sec('Labs', r.companies.length, html`<div class="rows-sig">${r.companies.map(c => html`<article class="sig-row src-off"><span class="res-ico" aria-hidden="true">◎</span><div class="sr-main"><h3><a href="#company/${c.id}">${c.name}</a></h3><p class="sr-meta"><span class="sc-type">Lab</span><span>${c.models} model${c.models === 1 ? '' : 's'} tracked</span><span>${c.official ? 'Official Hugging Face or GitHub accounts on our reference list' : 'On our reference list; no official open-model account'}</span></p></div></article>`)}</div>`)}
      ${sec('Papers', r.papers.length, html`<div class="rows-sig">${r.papers.map(p => html`<article class="sig-row src-arx"><span class="res-ico" aria-hidden="true">▤</span><div class="sr-main"><h3>${safeUrl(p.url) ? html`<a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.title}</a>` : p.title}</h3><p class="sr-meta"><span class="sc-type">Paper</span><span class="srcb">arXiv ${p.arxiv_id}</span><time>${stamp(p.published_at)}</time>${verBadge(p.verification)}</p></div>${safeUrl(p.url) ? html`<a class="sr-go" href="${p.url}" target="_blank" rel="noopener noreferrer" aria-label="Open on arXiv" title="Open on arXiv">↗</a>` : ''}</article>`)}</div>`)}
      ${sec('Signals', r.signals.length, html`<div class="rows-sig">${r.signals.map(s => html`<article class="sig-row src-other"><span class="res-ico" aria-hidden="true">◈</span><div class="sr-main"><h3>${s.model_id ? html`<a href="#model/${mid(s.model_id)}">${s.title}</a>` : safeUrl(s.url) ? html`<a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</h3><p class="sr-meta"><span class="sc-type">${SIGNAL_LABEL[s.cat] || s.cat}</span><time>${ago(s.ts)}</time>${verBadge(s.verification)}</p></div>${safeUrl(s.url) ? html`<a class="sr-go" href="${s.url}" target="_blank" rel="noopener noreferrer" aria-label="Open original source" title="Open original source">↗</a>` : ''}</article>`)}</div>`)}
      ${sec('Benchmarks', r.benchmarks.length, html`<div class="rows-sig">${r.benchmarks.map(b => html`<article class="sig-row src-other"><span class="res-ico" aria-hidden="true">▥</span><div class="sr-main"><h3><a href="#benchmarks/${b.id}">${b.name} ${b.ver}</a></h3><p class="sr-meta"><span class="sc-type">Benchmark</span></p></div></article>`)}</div>`)}`,
  };
}
