// Companies, comparison, benchmarks and documentation diffs.
import { ctxLabel, priceLabel, api, html, pageHead, empty, modelCard, signalCard, day, num, NA, mid, shortName, safeUrl, $, mount, CAT_LABEL, followBtn, dateLabel, verBadge, isApi, scoreRing } from '../lib.js';
import { plainLine } from './explain.js';

// ---- Labs ----
const fmtRange = (a, b) => (a && b ? (day(a) === day(b) ? day(a) : `${day(a)} to ${day(b)}`) : a ? day(a) : NA);
const ACCOUNT = { hf: n => ['Hugging Face', 'https://huggingface.co/' + n, n], gh: n => ['GitHub', 'https://github.com/' + n, n] };

export const companies = {
  async render() {
    const list = await api('/companies');
    return { title: 'Labs', html: html`${pageHead('Labs', 'The AI labs we follow. Each page gathers a lab\u2019s latest models, papers and announcements in one place, and shows which accounts and websites we treat as official.')}
      <div class="grid">${list.map(c => html`<a class="panel labcard" href="#company/${c.id}"><h3>${c.name}</h3><p class="sub">${c.models ? `${c.models} model${c.models === 1 ? '' : 's'} stored` : 'No models stored yet'}${c.signals30d ? `, ${c.signals30d} signal${c.signals30d === 1 ? '' : 's'} in 30 days` : ''}</p>
        <p class="fine">${c.official ? 'Official Hugging Face or GitHub accounts monitored' : 'Tracked through the OpenRouter catalogue and announcements'}</p></a>`)}</div>` };
  },
};
export const company = {
  async render(id) {
    const d = await api('/companies/' + encodeURIComponent(id)), c = d.company, st = d.stats;
    const news = d.signals.filter(s => ['Announcement', 'Open Source'].includes(s.cat));
    const accounts = [...c.hf.map(ACCOUNT.hf), ...c.gh.map(ACCOUNT.gh)];
    return { title: c.name, html: html`<p class="checked"><a href="#companies">Labs</a></p>
      <header class="labhero"><div><h1>${c.name}</h1><p class="sub">${st.models} model${st.models === 1 ? '' : 's'} \u00b7 ${st.papers} paper${st.papers === 1 ? '' : 's'} naming it \u00b7 ${st.signals30d} signal${st.signals30d === 1 ? '' : 's'} in 30 days</p></div>
        <div class="labact">${followBtn('lab', c.id, true)}${safeUrl(c.site) ? html`<a class="btn-sec" href="${c.site}" target="_blank" rel="noopener noreferrer">Official site <span aria-hidden="true">\u2197</span></a>` : ''}</div></header>
      <section class="panel labsrc"><h2>Where we get ${c.name}\u2019s information</h2>
        <ul class="srclist">${accounts.map(([k, u, n]) => html`<li><span class="srcb">${k}</span><a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace('https://', '')}</a><span class="fine">official account we monitor</span></li>`)}
          ${c.domains.length ? html`<li><span class="srcb">Websites</span><span>${c.domains.join(', ')}</span><span class="fine">links here count as official</span></li>` : ''}
          ${c.openrouter.length ? html`<li><span class="srcb">OpenRouter</span><span>${c.openrouter.join(', ')}</span><span class="fine">third-party catalogue, not confirmed by the lab</span></li>` : ''}
          ${accounts.length ? '' : html`<li class="fine">${c.name} has no official Hugging Face or GitHub account on our list, so its entries come from catalogues and announcements.</li>`}</ul></section>
      ${d.series.length ? html`<section class="blk"><header><h2>Model series <span class="cnt">${d.series.length}</span></h2></header><div class="grid">${d.series.map(g => html`<a class="panel seriescard" href="#family/${c.id}/${encodeURIComponent(g.key.split(':')[1])}"><h3>${g.label} series</h3><p class="sub">${g.count} models in ${g.generations} generation${g.generations === 1 ? '' : 's'}</p><p class="fine">${fmtRange(g.first, g.last)}</p><p class="fine">Latest: <b>${shortName(g.latest.id).split('/').pop()}</b></p><span class="tl-link">See the timeline \u2192</span></a>`)}</div></section>` : ''}
      <section class="blk"><header><h2>Announcements and releases</h2>${news.length ? html`<a href="#signals/${encodeURIComponent('company=' + c.id + '&window=30d')}">See all signals</a>` : ''}</header>${news.length ? html`<div class="stack">${news.slice(0, 6).map(signalCard)}</div>` : empty('No announcements in the last 30 days', `Nothing new has been detected from ${c.name}\u2019s monitored sources.`, '', 'signal')}</section>
      <section class="blk"><header><h2>Models <span class="cnt">${st.models}</span></h2>${st.models > 12 ? html`<a href="#models/${encodeURIComponent('company=' + c.id)}">See all ${st.models}</a>` : ''}</header>${d.models.length ? html`<div class="grid">${d.models.slice(0, 12).map(modelCard)}</div>` : empty('No models stored', `${c.name} has no models on a Hugging Face account we monitor or in the catalogue yet.`)}</section>
      <section class="blk"><header><h2>Research naming ${c.name} <span class="cnt">${st.papers}</span></h2><a href="#research">All research</a></header>${d.papers.length ? html`<div class="rows-sig">${d.papers.slice(0, 6).map(p => html`<article class="sig-row src-arx"><span class="res-ico" aria-hidden="true">\u25a4</span><div class="sr-main"><h3>${safeUrl(p.url) ? html`<a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.title}</a>` : p.title}</h3><p class="sr-meta"><span class="sc-type">Paper</span><span class="srcb">arXiv ${p.arxiv_id}</span><time>${day(p.published_at)}</time></p></div>${safeUrl(p.url) ? html`<a class="sr-go" href="${p.url}" target="_blank" rel="noopener noreferrer" aria-label="Open on arXiv" title="Open on arXiv">\u2197</a>` : ''}</article>`)}</div>` : empty('No papers naming this lab yet', 'Papers appear here when their title or abstract names the lab or its model families.', '', 'data')}</section>` };
  },
};

// ---- Model timeline: the history of one model series ----
export const family = {
  async render(arg) {
    const [co, ser] = String(arg).split('/');
    const d = await api(`/families/${encodeURIComponent(co)}/${encodeURIComponent(ser)}`), g = d.generations;
    return { title: `${d.company.name} ${d.series.label}`, html: html`<p class="checked"><a href="#company/${d.company.id}">${d.company.name}</a> / Model series</p>
      <header class="labhero"><div><h1>${d.series.label} series</h1><p class="sub">${d.series.count} models from ${d.company.name}, ${fmtRange(d.series.first, d.series.last)}</p></div><div class="labact">${followBtn('family', d.series.key, true)}</div></header>
      <p class="fine">Grouped by model name, among ${d.company.name}\u2019s own models only. Dates are when each model was first published or listed in the source it came from, which is not always the official launch date.</p>
      <ol class="timeline">${g.map((x, i) => html`<li class="tl-node ${i === g.length - 1 ? 'latest' : ''}"><span class="tl-dot" aria-hidden="true"></span>
        <div class="tl-card"><div class="tl-head"><h3>${x.label}</h3>${i === g.length - 1 ? html`<span class="tl-badge">Latest</span>` : ''}<span class="tl-date">${fmtRange(x.first, x.last)}</span></div>
          <ul class="tl-models">${x.models.map(m => html`<li><a href="#model/${mid(m.id)}">${shortName(m.id).split('/').pop()}</a><span class="tl-chip">${m.params || ctxLabel(m.context_length) || '\u2014'}</span><span class="tl-sub">${dateLabel(m)} ${day(m.released_at)}</span>${verBadge(m.verification)}</li>`)}</ul></div></li>`)}</ol>` };
  },
};

// ---- Compare: 2 to 4 models side by side. The picks live in the address (#compare/id,id,id) so a comparison can be shared. ----
let picks = null;
const MAX = 4;
const list = ids => ids.map(encodeURIComponent).join(',');
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const CAP_LABEL = { reasoning: 'Reasoning', 'tool-use': 'Tool use' };

export const compare = {
  async render(arg) {
    const fromUrl = String(arg || '').split(',').map(x => { try { return decodeURIComponent(x); } catch (e) { return ''; } }).filter(Boolean);
    // A link with several models is a saved comparison. A single model (from a model page) is added to what was already being compared.
    if (fromUrl.length > 1) picks = fromUrl.slice(0, MAX);
    else if (fromUrl.length === 1 && !(picks || []).includes(fromUrl[0])) picks = [...(picks || []), fromUrl[0]].slice(-MAX);
    if (!picks) picks = (await api('/models?sort=popular&limit=3')).items.map(m => m.id);
    const D = (await Promise.all(picks.map(i => api('/models/' + mid(i) + '/preview').catch(() => null)))).filter(Boolean);
    picks = D.map(d => d.model.id);
    history.replaceState(null, '', '#compare/' + list(picks)); // shareable address, without reloading the page
    // Rows: [label, value of one model, optional "best" rule: 'high' or 'low' compares the raw numbers]
    const num0 = v => (v == null || v === '' ? null : +v);
    const ROWS = [
      ['Overview', [
        ['Publisher', d => d.model.company || d.model.creator],
        ['Release date', d => (d.model.released_at ? html`${day(d.model.released_at)}<span class="cmp-sub">${dateLabel(d.model)}</span>` : null), d => d.model.released_at, 'low'],
        ['Type', d => (isApi(d.model) ? 'Closed model, via API' : 'Open weights')],
        ['Task', d => d.model.pipeline]]],
      ['Specs', [
        ['Parameters', d => d.model.params, d => d.model.param_count],
        ['Context window', d => ctxLabel(d.model.context_length), d => d.model.context_length, 'high'],
        ['License', d => d.model.license],
        ['Price in / out (per 1M tokens)', d => (d.model.price_in == null ? null : `${priceLabel(d.model)}`), d => (d.model.price_in == null ? null : d.model.price_in + (d.model.price_out || 0)), 'low']]],
      ['Source', [
        ['Verification', d => verBadge(d.model.verification)],
        ['Original source', d => { const u = safeUrl(d.model.provider_url || d.source_url || d.model.url); return u ? html`<a href="${u}" target="_blank" rel="noopener noreferrer">${hostOf(u)} <span aria-hidden="true">\u2197</span></a>` : null; }]]],
      ['Traction', [
        ['Signal Score', d => d.signal.score, d => d.signal.score, 'high'],
        ['Likes', d => (isApi(d.model) ? null : num(d.model.likes)), d => (isApi(d.model) ? null : d.model.likes), 'high'],
        ['Downloads', d => (isApi(d.model) ? null : num(d.model.downloads)), d => (isApi(d.model) ? null : d.model.downloads), 'high']]],
      ['Key highlights', [
        ['What it is', d => plainLine(d.model)],
        ['Abilities', d => { const c = d.model.capabilities.filter(x => CAP_LABEL[x]); return c.length ? html`<span class="tags">${c.map(x => html`<span class="tag">${CAP_LABEL[x]}</span>`)}</span>` : null; }],
        ['Why it scores this way', d => (d.signal.why.length ? html`<ul class="cmp-why">${d.signal.why.slice(0, 3).map(w => html`<li>${w}</li>`)}</ul>` : null)]]],
    ];
    const cell = (r, d, best) => { const v = r[1](d); return html`<td class="${best ? 'best' : ''}">${v == null || v === '' ? html`<span class="na">${NA}</span>` : v}</td>`; };
    const sameAll = r => new Set(D.map(d => String((r[1](d) && r[1](d).toString()) || ''))).size === 1;
    const body = ROWS.map(([sec, rows]) => html`<tbody><tr class="cmp-sec"><th colspan="${D.length + 1}" scope="colgroup">${sec}</th></tr>${rows.map(r => {
      let best = null;
      if (r[3] && D.length > 1) { const vals = D.map(d => num0(r[2](d))); const ok = vals.filter(v => v != null); if (ok.length > 1 && new Set(ok).size > 1) best = r[3] === 'high' ? Math.max(...ok) : Math.min(...ok); if (r[0] === 'Release date') best = null; }
      return html`<tr class="${sameAll(r) ? 'cmp-same' : ''}"><th scope="row">${r[0]}</th>${D.map((d, i) => cell(r, d, best != null && num0(r[2](d)) === best))}</tr>`;
    })}</tbody>`);
    return {
      title: 'Compare',
      html: html`${pageHead('Compare models', 'Two to four models side by side. Only facts we hold are shown; a missing value says so. Highlighted cells are the best value in that row.')}
        <div class="toolbar tb-main"><input id="cq" type="search" placeholder="${D.length >= MAX ? 'Four models is the most you can compare' : 'Add a model by name'}" aria-label="Add a model" ${D.length >= MAX ? 'disabled' : ''}>
          <label class="chk"><input type="checkbox" id="cdiff"><span>Show only differences</span></label><button id="cshare" class="ftog">Copy link</button></div>
        <div class="tags" id="cres" aria-live="polite"></div>
        ${D.length < 2 ? empty('Add one more model', 'Pick at least two models to compare them. Search above, or start from a model page.', html`<a class="btn-sec" href="#models">Browse models</a>`, 'filter') : ''}
        ${D.length ? html`<div class="tw cmp"><table class="cmp-t"><thead><tr><th></th>${D.map(d => html`<th scope="col"><div class="cmp-head">${scoreRing(d.signal.score)}<a href="#model/${mid(d.model.id)}">${shortName(d.model.id).split('/').pop()}</a><button class="link" data-cdel="${d.model.id}" aria-label="Remove ${shortName(d.model.id)} from the comparison">remove</button></div></th>`)}</tr></thead>${body}</table></div>` : ''}`,
      after(root) {
        root.querySelectorAll('[data-cdel]').forEach(b => b.onclick = () => { picks = picks.filter(x => x !== b.dataset.cdel); location.hash = 'compare/' + list(picks) + (picks.length ? '' : '_'); });
        $('#cdiff', root).onchange = e => root.querySelector('.cmp-t') && root.querySelector('.cmp-t').classList.toggle('only-diff', e.target.checked);
        $('#cshare', root).onclick = async e => { try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Link copied'; } catch (x) { e.target.textContent = 'Copy it from the address bar'; } setTimeout(() => { e.target.textContent = 'Copy link'; }, 2200); };
        let t; $('#cq', root).oninput = e => { clearTimeout(t); t = setTimeout(async () => {
          const q = e.target.value.trim(); if (q.length < 2) return mount($('#cres', root), html``);
          const d = await api('/models?' + new URLSearchParams({ q, sort: 'popular', limit: 8 }));
          mount($('#cres', root), d.items.length ? html`${d.items.filter(m => !picks.includes(m.id)).map(m => html`<button data-cadd="${m.id}">+ ${shortName(m.id)}</button>`)}` : html`<span class="na">No matches.</span>`);
          root.querySelectorAll('[data-cadd]').forEach(b => b.onclick = () => { if (picks.length < MAX && !picks.includes(b.dataset.cadd)) picks.push(b.dataset.cadd); location.hash = 'compare/' + list(picks); });
        }, 250); };
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
