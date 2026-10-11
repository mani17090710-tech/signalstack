// Model detail: facts with their source, a Signal Score with its reasoning, related research and history.
import { VER, api, html, pageHead, scoreRing, scoreBreakdown, verBadge, verLegend, signalCard, modelCard, day, stamp, ago, num, NA, CAT_LABEL, state, mid, safeUrl, host, shortName, ctxLabel, priceLabel, isApi } from '../lib.js';

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
          ${fact('Publisher', m.company || m.creator)}${fact('Released', m.released_at ? day(m.released_at) : null)}${isApi(m) ? '' : fact('Last updated', m.updated_at ? day(m.updated_at) : null)}
          ${isApi(m) ? html`<dt>Parameters</dt><dd><span class="na">Not publicly available</span></dd>` : fact('Parameters', m.params)}${fact('License', m.license)}${fact('Task', m.pipeline)}${isApi(m) ? '' : html`${fact('Library', m.library)}${fact('Architecture', m.arch)}`}
          ${fact('Context length', ctxLabel(m.context_length))}${fact('Pricing', priceLabel(m))}${fact('Modalities', m.modality)}${isApi(m) ? '' : html`${fact('Downloads', num(m.downloads))}${fact('Likes', num(m.likes))}`}</dl>
          <p class="src"><a href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer">${host(m.url) || 'Source'}</a><span>Checked ${ago(m.retrieved_at)}</span></p>
          ${m.source_type === 'openrouter' ? html`<p class="fine">Listed by OpenRouter, a third-party catalogue. Prices are what OpenRouter charges and can differ from the lab\u2019s own.</p>` : ''}
          ${isApi(m) || d.detailFetched ? '' : html`<p class="fine">Exact size and last-updated date are filled in from the model page when it can be reached.</p>`}</section></div>
      <section class="panel mt"><h2>Verification</h2>
        <p>${verBadge(d.verification.level)} <span class="detail">${d.verification.description}</span></p>
        ${d.verification.evidence.length ? html`<p class="meta">Confirmed by</p><ul class="plain">${d.verification.evidence.map(e => html`<li>${safeUrl(e.url) ? html`<a href="${e.url}" target="_blank" rel="noopener noreferrer">${e.label || e.kind}</a>` : e.label || e.kind}<span class="meta"> ${host(e.url) || ''}, ${ago(e.verified_at)}</span></li>`)}</ul>`
          : html`<p class="fine">No provider confirmation yet, so this stays at “${VER[d.verification.level] ? VER[d.verification.level][1] : 'Unverified'}”.</p>`}
        <p class="meta">Found through</p><ul class="plain">${d.verification.sources.length ? d.verification.sources.map(x => html`<li>${safeUrl(x.url) ? html`<a href="${x.url}" target="_blank" rel="noopener noreferrer">${x.source}</a>` : x.source}<span class="meta"> last seen ${ago(x.last_seen)}</span></li>`) : html`<li class="na">${NA}</li>`}</ul>
        <p class="meta">${d.verification.verified_at ? 'Last verified ' + ago(d.verification.verified_at) : 'Never verified by the provider'}${m.ctx_source ? ' · Context length: ' + (m.ctx_source === 'official' ? 'from the provider' : 'per ' + m.ctx_source) : ''}${m.price_source ? ' · Pricing: ' + (m.price_source === 'official' ? 'from the provider' : 'per ' + m.price_source) : ''}</p>
        ${d.announcement ? html`<p><a href="${safeUrl(d.announcement)}" target="_blank" rel="noopener noreferrer">Official announcement</a></p>` : ''}${safeUrl(m.official_url) ? html`<p><a href="${m.official_url}" target="_blank" rel="noopener noreferrer">Official page</a></p>` : ''}</section>
      ${verLegend()}
      <section class="blk"><header><h2>Related research</h2></header>${d.papers.length ? html`<div class="panel rows">${d.papers.map(p => html`<div><h3>${p.in_collection ? html`<a href="${safeUrl(p.url)}" target="_blank" rel="noopener noreferrer">${p.title}</a>` : html`<a href="${safeUrl(p.url)}" target="_blank" rel="noopener noreferrer">arXiv ${p.arxiv_id}</a>`}</h3>${p.authors ? html`<p class="meta">${p.authors}</p>` : ''}<p class="meta">${p.in_collection ? 'Published ' + stamp(p.published_at) : 'Paper not in our collection yet'}</p><p class="fine">Why linked: ${p.evidence}</p></div>`)}</div>` : html`<div class="panel"><p class="na">No paper linked. A paper is linked only when there is evidence for it.</p></div>`}</section>
      ${d.results.length ? html`<section class="blk"><header><h2>Benchmark results</h2></header><div class="tw"><table><tr><th>Benchmark</th><th>Score</th><th>Evaluator</th><th>Date</th></tr>${d.results.map(r => html`<tr><td>${r.bname} ${r.bver}</td><td><b>${r.score}</b></td><td>${r.evaluator}</td><td>${r.date}</td></tr>`)}</table></div></section>`
        : html`<p class="checked mt">Benchmark scores: ${NA}.</p>`}
      <section class="blk"><header><h2>History</h2></header>${d.events.length ? html`<div class="stack">${d.events.map(signalCard)}</div>` : html`<div class="panel"><p class="na">No signals recorded for this model yet.</p></div>`}</section>
      ${d.similar.length ? html`<section class="blk"><header><h2>Related models</h2><a href="#compare/${mid(m.id)}">Compare</a></header><div class="grid">${d.similar.slice(0, 3).map(modelCard)}</div></section>` : ''}`,
  };
}
