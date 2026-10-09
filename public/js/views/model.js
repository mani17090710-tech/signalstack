// Model detail: facts with their source, a Signal Score with its reasoning, related research and history.
import { api, html, pageHead, scoreRing, scoreBreakdown, verBadge, verLegend, signalCard, modelCard, day, stamp, ago, num, NA, CAT_LABEL, state, mid, safeUrl, host, shortName } from '../lib.js';

const fact = (k, v, unit = '') => html`<dt>${k}</dt><dd>${v == null || v === '' ? html`<span class="na">${NA}</span>` : v}${v == null || v === '' ? '' : unit}</dd>`;

export async function render(id) {
  const d = await api('/models/' + encodeURIComponent(id)), m = d.model, s = d.signal;
  const name = shortName(m.id);
  return {
    title: name,
    html: html`<p class="checked"><a href="#models">Model Universe</a> / ${m.company ? html`<a href="#company/${m.company_id}">${m.company}</a>` : m.creator || 'Community'}</p>
      ${pageHead(name.split('/').pop(), m.company ? `Published by ${m.company}` : `Uploaded by ${m.creator || 'an unknown publisher'}`, html`<button data-watch="${m.id}" data-long="1" class="pri">${state.watch.includes(m.id) ? 'Watching' : 'Watch this model'}</button>`)}
      <div class="tags">${verBadge(m.verification)}${m.cats.map(c => html`<span class="tag">${CAT_LABEL[c] || c}</span>`)}${m.gated ? html`<span class="tag">Gated access</span>` : ''}</div>
      <div class="two mt">
        <section class="panel"><h2>Signal Score</h2>
          <div class="sig-head">${scoreRing(s.score, true)}<div><b>${s.importance}</b><p class="detail">SignalStack’s estimate of how much attention this deserves right now.</p></div></div>${scoreBreakdown(s, true)}</section>
        <section class="panel"><h2>Facts</h2><dl class="kv">
          ${fact('Publisher', m.company || m.creator)}${fact('Released', m.released_at ? day(m.released_at) : null)}${fact('Last updated', m.updated_at ? day(m.updated_at) : null)}
          ${fact('Parameters', m.params)}${fact('License', m.license)}${fact('Task', m.pipeline)}${fact('Library', m.library)}${fact('Architecture', m.arch)}
          ${fact('Context length', null)}${fact('Pricing', null)}${fact('Downloads', num(m.downloads))}${fact('Likes', num(m.likes))}</dl>
          <p class="src"><a href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer">${host(m.url) || 'Source'}</a><span>Checked ${ago(m.retrieved_at)}</span></p>
          ${d.detailFetched ? '' : html`<p class="fine">Exact size and last-updated date are filled in from the model page when it can be reached.</p>`}</section></div>
      ${verLegend()}
      ${d.papers.length ? html`<section class="blk"><header><h2>Research paper</h2></header><div class="panel rows">${d.papers.map(p => html`<div><h3><a href="${safeUrl(p.url)}" target="_blank" rel="noopener noreferrer">${p.title}</a></h3><p class="meta">${p.authors || ''}</p><p class="meta">Published ${stamp(p.published_at || p.date)}</p></div>`)}</div></section>`
        : m.arxiv ? html`<p class="checked">Linked to arXiv ${m.arxiv}, which is not in our collection yet.</p>` : ''}
      ${d.results.length ? html`<section class="blk"><header><h2>Benchmark results</h2></header><div class="tw"><table><tr><th>Benchmark</th><th>Score</th><th>Evaluator</th><th>Date</th></tr>${d.results.map(r => html`<tr><td>${r.bname} ${r.bver}</td><td><b>${r.score}</b></td><td>${r.evaluator}</td><td>${r.date}</td></tr>`)}</table></div></section>`
        : html`<p class="checked mt">Benchmark scores: ${NA}.</p>`}
      <section class="blk"><header><h2>History</h2></header>${d.events.length ? html`<div class="stack">${d.events.map(signalCard)}</div>` : html`<div class="panel"><p class="na">No signals recorded for this model yet.</p></div>`}</section>
      ${d.similar.length ? html`<section class="blk"><header><h2>Related models</h2><a href="#compare/${mid(m.id)}">Compare</a></header><div class="grid">${d.similar.slice(0, 3).map(modelCard)}</div></section>` : ''}`,
  };
}
