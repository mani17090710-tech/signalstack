// Companies, comparison, benchmarks and documentation diffs.
import { ctxLabel, priceLabel, api, html, pageHead, empty, modelCard, signalCard, day, num, NA, mid, shortName, safeUrl, $, mount, CAT_LABEL } from '../lib.js';

export const companies = {
  async render() {
    const list = await api('/companies');
    return { title: 'Companies', html: html`${pageHead('Companies', 'Labs whose official Hugging Face and GitHub accounts we monitor.')}
      <div class="grid">${list.map(c => html`<a class="panel" href="#company/${c.id}"><h3>${c.name}</h3><p class="sub">${c.models} model${c.models === 1 ? '' : 's'} stored, ${c.signals30d} signal${c.signals30d === 1 ? '' : 's'} in 30 days</p>${c.official ? '' : html`<p class="fine">No official Hugging Face account to monitor, so releases appear only via blogs and papers.</p>`}</a>`)}</div>` };
  },
};
export const company = {
  async render(id) {
    const d = await api('/companies/' + encodeURIComponent(id)), c = d.company;
    return { title: c.name, html: html`<p class="checked"><a href="#companies">Companies</a></p>${pageHead(c.name, '', safeUrl(c.site) ? html`<a href="${c.site}" target="_blank" rel="noopener noreferrer">Official site</a>` : '')}
      <section class="blk"><header><h2>Recent signals</h2></header>${d.signals.length ? html`<div class="stack">${d.signals.slice(0, 10).map(signalCard)}</div>` : empty('No signals in the last 30 days', 'Nothing new has been detected from this lab’s monitored sources.')}</section>
      <section class="blk"><header><h2>Models</h2></header>${d.models.length ? html`<div class="grid">${d.models.map(modelCard)}</div>` : empty('No models stored', 'This lab has no models on a Hugging Face account we monitor.')}</section>` };
  },
};

let picks = null;
export const compare = {
  async render(arg) {
    if (arg && !(picks || []).includes(arg)) picks = [...(picks || []), arg].slice(-4);
    if (!picks) picks = (await api('/models?sort=popular&limit=3')).items.map(m => m.id);
    const D = (await Promise.all(picks.map(i => api('/models/' + mid(i)).catch(() => null)))).filter(Boolean);
    const row = (label, fn) => html`<tr><th scope="row">${label}</th>${D.map(d => { const v = fn(d.model, d); return html`<td>${v == null || v === '' ? html`<span class="na">${NA}</span>` : v}</td>`; })}</tr>`;
    return {
      title: 'Compare',
      html: html`${pageHead('Compare models', 'Up to four models. Only facts we have are shown.')}
        <div class="tags">${D.map(d => html`<span class="tag">${shortName(d.model.id)} <button class="link" data-cdel="${d.model.id}" aria-label="Remove ${shortName(d.model.id)}">remove</button></span>`)}</div>
        <div class="toolbar mt"><input id="cq" type="search" placeholder="Add a model by name" aria-label="Add a model"></div><div class="tags" id="cres"></div>
        <div class="tw mt"><table><tr><th></th>${D.map(d => html`<th><a href="#model/${mid(d.model.id)}">${shortName(d.model.id).split('/').pop()}</a></th>`)}</tr>
          ${row('Publisher', m => m.company || m.creator)}${row('Released', m => (m.released_at ? day(m.released_at) : null))}${row('Parameters', m => m.params)}${row('License', m => m.license)}${row('Task', m => m.pipeline)}
          ${row('Categories', m => m.cats.map(c => CAT_LABEL[c] || c).join(', '))}${row('Likes', m => num(m.likes))}${row('Downloads', m => num(m.downloads))}${row('Signal Score', (m, d) => d.signal.score)}${row('Context length', m => ctxLabel(m.context_length))}${row('Pricing', m => priceLabel(m))}</table></div>`,
      after(root) {
        root.querySelectorAll('[data-cdel]').forEach(b => b.onclick = () => { picks = picks.filter(x => x !== b.dataset.cdel); window.dispatchEvent(new HashChangeEvent('hashchange')); });
        let t; $('#cq', root).oninput = e => { clearTimeout(t); t = setTimeout(async () => {
          const q = e.target.value.trim(); if (q.length < 2) return mount($('#cres', root), html``);
          const d = await api('/models?' + new URLSearchParams({ q, sort: 'popular', limit: 8 }));
          mount($('#cres', root), d.items.length ? html`${d.items.map(m => html`<button data-cadd="${m.id}">${shortName(m.id)}</button>`)}` : html`<span class="na">No matches.</span>`);
          root.querySelectorAll('[data-cadd]').forEach(b => b.onclick = () => { if (picks.length < 4 && !picks.includes(b.dataset.cadd)) picks.push(b.dataset.cadd); window.dispatchEvent(new HashChangeEvent('hashchange')); });
        }, 300); };
      },
    };
  },
};

export const benchmarks = {
  async render(id) {
    const bs = await api('/benchmarks');
    if (!bs.length) return html`${pageHead('Benchmarks', '')}${empty('No benchmark data yet', 'Benchmark results are not available from the sources we monitor.')}`;
    id = id || bs[0].id; const d = await api('/benchmarks/' + id), b = d.benchmark;
    return { title: 'Benchmarks', html: html`${pageHead('Benchmarks', 'Every result with who measured it.')}
      <div class="toolbar"><select id="bs" aria-label="Benchmark">${bs.map(x => html`<option value="${x.id}" ${x.id === id ? 'selected' : ''}>${x.name} ${x.ver}, ${x.cat}</option>`)}</select></div>
      <div class="panel"><h3>${b.name} ${b.ver}</h3><p class="sub">${b.descr}</p><p class="fine">Method: ${b.meth}</p></div>
      <div class="tw mt"><table><tr><th>Model</th><th>Score</th><th>Evaluator</th><th>Date</th><th>Source</th></tr>${d.results.map(r => html`<tr><td><a href="#model/${mid(r.model_id)}">${r.mname}</a></td><td><b>${r.score}</b></td><td>${r.evaluator}</td><td>${r.date}</td><td>${r.source}</td></tr>`)}</table></div>`,
      after(root) { $('#bs', root).onchange = e => { location.hash = 'benchmarks/' + e.target.value; }; } };
  },
};

export const docs = {
  async render() {
    const vs = await api('/docs');
    if (!vs.length) return html`${pageHead('Documentation', '')}${empty('No documentation tracked', 'No documentation pages are being tracked yet.')}`;
    const a = (vs[1] || vs[0]).version, b = vs[0].version, d = await api(`/docs/diff?a=${a}&b=${b}`);
    return html`${pageHead('Documentation changes', `Comparing ${a} with ${b}: ${d.severity}`)}<div class="panel rows">${d.changes.map(c => html`<div><b>${c.t}</b> ${c.text}</div>`)}${d.changes.length ? '' : html`<div class="na">No differences.</div>`}</div>`;
  },
};
