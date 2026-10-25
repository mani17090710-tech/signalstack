// Model detail: facts with their source, a Signal Score with its reasoning, related research and history.
import { explainer, animateExplainer } from './explain.js';
import { saveBtn, followBtn, api, html, pageHead, scoreRing, scoreBreakdown, verBadge, verLegend, signalCard, modelCard, day, stamp, ago, num, NA, CAT_LABEL, state, mid, safeUrl, host, shortName, ctxLabel, priceLabel, isApi, figureSource, SOURCE_NAME, EVIDENCE_LABEL, dateLabel } from '../lib.js';

const fact = (k, v, unit = '', src = '') => html`<dt>${k}</dt><dd>${v == null || v === '' ? html`<span class="na">${NA}</span>` : v}${v == null || v === '' ? '' : unit}${v == null || v === '' || !src ? '' : html`<span class="fig">${src}</span>`}</dd>`;

export async function render(id) {
  const d = await api('/models/' + encodeURIComponent(id)), m = d.model, s = d.signal;
  const name = shortName(m.id);
  return {
    title: name,
    after: root => animateExplainer(root),
    html: html`<p class="checked"><a href="#models">Model Universe</a> / ${m.company ? html`<a href="#company/${m.company_id}">${m.company}</a>` : m.creator || 'Community'}</p>
      ${pageHead(name.split('/').pop(), m.company ? `Published by ${m.company}` : `Uploaded by ${m.creator || 'an unknown publisher'}`, html`<span class="labact">${saveBtn('model', m.id)}<button data-watch="${m.id}" data-long="1" class="pri">${state.watch.includes(m.id) ? 'Watching' : 'Watch this model'}</button></span>`)}
      <div class="tags">${verBadge(m.verification)}${m.cats.map(c => html`<span class="tag">${CAT_LABEL[c] || c}</span>`)}${m.gated ? html`<span class="tag">Gated access</span>` : ''}</div>
      ${explainer(d)}
      <div class="mt">
        <section class="panel"><h2>Facts</h2><dl class="kv">
          ${fact('Publisher', m.company || m.creator)}${fact(dateLabel(m), m.released_at ? day(m.released_at) : null)}${isApi(m) ? '' : fact('Last updated', m.updated_at ? day(m.updated_at) : null)}
          ${isApi(m) ? html`<dt>Parameters</dt><dd><span class="na">Not publicly available</span></dd>` : fact('Parameters', m.params)}${fact('License', m.license)}${fact('Task', m.pipeline)}${isApi(m) ? '' : html`${fact('Library', m.library)}${fact('Architecture', m.arch)}`}
          ${fact('Model ID', m.provider_model_id || m.model_ref)}${fact('Context length', ctxLabel(m.context_length), '', figureSource(m.context_source))}${fact('Pricing', priceLabel(m), '', figureSource(m.price_source))}${fact('Capabilities', m.capabilities.length ? m.capabilities.join(', ') : null)}${isApi(m) ? '' : html`${fact('Downloads', num(m.downloads))}${fact('Likes', num(m.likes))}`}</dl>
          <p class="src"><a href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer">${host(m.url) || 'Source'}</a><span>Checked ${ago(m.retrieved_at)}</span></p>
          ${m.price_source === 'openrouter' || m.context_source === 'openrouter' ? html`<p class="fine">Context length and prices marked \u201cper OpenRouter listing\u201d come from a third-party catalogue and can differ from the provider\u2019s own figures.</p>` : ''}
          ${m.listed ? '' : html`<p class="fine">No longer in the OpenRouter catalogue as of the last check.</p>`}
          ${isApi(m) || d.detailFetched ? '' : html`<p class="fine">Exact size and last-updated date are filled in from the model page when it can be reached.</p>`}</section></div>
      <section class="blk"><header><h2>Verification</h2></header><div class="panel">
        <div class="vhead">${verBadge(d.verification.status)}<p>${d.verification.meaning}</p></div>
        <dl class="kv">
          ${fact('Official provider link', d.verification.official_url ? html`<a href="${safeUrl(d.verification.official_url)}" target="_blank" rel="noopener noreferrer">${host(d.verification.official_url)}</a>` : null)}
          ${fact('Last verified', d.verification.last_verified ? ago(d.verification.last_verified) : null)}
          ${fact('Provider model ID', m.provider_model_id)}
          ${d.company && d.company.site ? fact('Provider site', html`<a href="${safeUrl(d.company.site)}" target="_blank" rel="noopener noreferrer">${host(d.company.site)}</a>`) : ''}</dl>
        ${d.verification.status === 'verified' ? '' : html`<p class="fine">${d.verification.status === 'source_verified' ? 'Not yet matched to the provider\u2019s official documentation.' : 'No official provider announcement or documentation is on record for this model.'}</p>`}
        <h3>Evidence</h3>
        ${d.verification.evidence.length ? html`<ul class="ev">${d.verification.evidence.map(e => html`<li>${verBadge(e.status)} <b>${e.label}</b>${e.url ? html` <a href="${safeUrl(e.url)}" target="_blank" rel="noopener noreferrer">${host(e.url) || 'link'}</a>` : ''}<p class="meta">${e.note || ''} Checked ${ago(e.checked_at)}.</p></li>`)}</ul>` : html`<p class="na">No evidence recorded.</p>`}
        <h3>Where it was discovered</h3>
        ${d.discovery.length ? html`<ul class="ev">${d.discovery.map(x => html`<li><b>${SOURCE_NAME[x.source] || x.source}</b> ${x.url ? html`<a href="${safeUrl(x.url)}" target="_blank" rel="noopener noreferrer">${host(x.url) || 'link'}</a>` : ''}<p class="meta">Listed as ${x.ext_id || m.id}. First seen ${ago(x.first_seen)}, last seen ${ago(x.last_seen)}.</p></li>`)}</ul>` : html`<p class="na">No discovery record.</p>`}
        <p class="fine">Discovery shows that a model exists somewhere. It never changes the verification status.</p></div></section>
      ${verLegend()}
      ${d.papers.length ? html`<section class="blk"><header><h2>Related research</h2></header><div class="panel rows">${d.papers.map(p => html`<div><h3><a href="${safeUrl(p.url)}" target="_blank" rel="noopener noreferrer">${p.title || 'arXiv ' + p.arxiv_id}</a></h3>${p.authors ? html`<p class="meta">${p.authors.split(', ').slice(0, 6).join(', ')}${p.authors.split(', ').length > 6 ? ', and others' : ''}</p>` : ''}
        <p class="meta">arXiv ${p.arxiv_id}${p.published_at ? html`, published ${stamp(p.published_at)}` : ''}. ${p.in_collection ? 'Details from arXiv, checked ' + ago(p.last_checked) + '.' : 'Not fetched from arXiv yet; shown only because a source links it.'}</p>
        <p class="meta">Link evidence: ${EVIDENCE_LABEL[p.evidence.kind] || p.evidence.kind} (claimed by ${p.evidence.claimed_by || 'a source'}).</p></div>`)}</div></section>` : ''}
      ${d.results.length ? html`<section class="blk"><header><h2>Benchmark results</h2></header><div class="tw"><table><tr><th>Benchmark</th><th>Score</th><th>Evaluator</th><th>Date</th></tr>${d.results.map(r => html`<tr><td>${r.bname} ${r.bver}</td><td><b>${r.score}</b></td><td>${r.evaluator}</td><td>${r.date}</td></tr>`)}</table></div></section>`
        : html`<p class="checked mt">Benchmark scores: ${NA}.</p>`}
      ${d.family ? html`<section class="blk"><header><h2>Part of the ${d.family.label} series</h2><a href="#family/${d.family.company_id}/${encodeURIComponent(d.family.key.split(':')[1])}">Full timeline</a></header>
        <div class="panel famcard"><p class="sub">${d.family.count} models from ${d.company ? d.company.name : 'this lab'}, grouped by name. This one belongs to <b>${d.family.generation}</b>.</p>
          <ol class="famline">${d.family.generations.map(g => html`<li class="${g.current ? 'cur' : ''}"><span class="tl-dot" aria-hidden="true"></span><b>${g.label}</b><span class="fine">${g.first ? day(g.first) : ''}${g.count > 1 ? ` \u00b7 ${g.count} models` : ''}</span></li>`)}</ol>
          <div class="labact">${followBtn('family', d.family.key)}<a class="btn-sec" href="#family/${d.family.company_id}/${encodeURIComponent(d.family.key.split(':')[1])}">See the timeline</a></div></div></section>` : ''}
      <section class="blk"><header><h2>History</h2></header>${d.events.length ? html`<div class="stack">${d.events.map(signalCard)}</div>` : html`<div class="panel"><p class="na">No signals recorded for this model yet.</p></div>`}</section>
      ${d.similar.length ? html`<section class="blk"><header><h2>Related models</h2><a href="#compare/${mid(m.id)}">Compare</a></header><div class="grid">${d.similar.slice(0, 3).map(modelCard)}</div></section>` : ''}`,
  };
}
