// Research: papers from arXiv, with the labs they mention and the source on each. Same card design as the signal feed.
import { api, html, pageHead, empty, skeleton, mount, $, stamp, ago, verBadge, safeUrl, checked, saveBtn } from '../lib.js';

let COMPANY_NAMES = {};
const f = { q: '', company: '', window: '' };
const WINDOWS = [['', 'Any time'], ['7', 'Last 7 days'], ['30', 'Last 30 days']];
let rows = 0, total = 0, token = 0;

// A paper's details come straight from arXiv (the primary record). Lab tags are added only where the title or abstract names a lab.
const paper = p => html`<article class="sig src-arx">
  <header class="sc-top"><div class="sc-chips"><span class="sc-type"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/></svg>Paper</span><span class="srcb">arXiv ${p.arxiv_id}</span><time class="sc-time" data-ts="${p.published_at}" title="${stamp(p.published_at)}">${ago(p.published_at)}</time></div></header>
  <h3>${safeUrl(p.url) ? html`<a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.title}</a>` : p.title}</h3>
  ${p.authors ? html`<p class="sc-sum sc-au">${p.authors}</p>` : ''}
  <div class="sc-meta">${p.categories.map(c => html`<span class="tag">${c}</span>`)}${p.entities.map(c => html`<a class="tag co" href="#company/${c}">${COMPANY_NAMES[c] || c}</a>`)}${verBadge(p.verification)}</div>
  ${p.summary ? html`<details class="why"><summary>Abstract</summary><p class="detail">${p.summary}</p>${p.abstract_truncated ? html`<p class="fine">Shortened in our records. Open the paper on arXiv for the full abstract.</p>` : ''}</details>` : ''}
  <div class="sc-act">${safeUrl(p.url) ? html`<a class="btn-src" href="${p.url}" target="_blank" rel="noopener noreferrer">Open on arXiv <span aria-hidden="true">↗</span></a>` : ''}${saveBtn('paper', p.arxiv_id)}<span class="sc-fine">${p.source_role === 'primary' ? 'Primary record from arXiv' : 'Secondary source'}${p.last_checked || p.retrieved_at ? ` · checked ${ago(p.last_checked || p.retrieved_at)}` : ''}</span></div></article>`;

export async function render(arg = '') {
  // A link can preselect a lab, for example #research/company=qwen (used by the "All research" link on lab pages).
  if (arg) { const a = new URLSearchParams(arg); f.company = a.get('company') || ''; f.q = ''; f.window = ''; }
  return {
    title: 'Research',
    html: html`${pageHead('Research', 'Recent papers from selected arXiv categories (cs.CL, cs.LG, cs.AI, cs.CV and a few related ones). Not every arXiv paper is collected. Labs are listed only where the title or abstract names them.', html`<span id="rchk"></span>`)}
      <div class="toolbar tb-main"><input id="rq" type="search" placeholder="Search title, author, topic or arXiv ID" value="${f.q}" aria-label="Search papers">
        <select id="rco" aria-label="Lab mentioned"><option value="">Any lab mentioned</option></select>
        <select id="rwin" aria-label="Time">${WINDOWS.map(([k, l]) => html`<option value="${k}" ${f.window === k ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="labchips" id="rlabs" role="group" aria-label="Labs mentioned in these papers"></div>
      <p class="checked" id="rcount" aria-live="polite"></p><div id="rlist">${skeleton(3)}</div><p class="more"><button id="rmore" hidden>Load more</button></p>`,
    after(root) {
      // Lab names fill in as soon as they arrive; the first list waits for them only so tags show names, never raw ids.
      const cos = api('/companies').then(list => {
        COMPANY_NAMES = Object.fromEntries(list.map(c => [c.id, c.name]));
      }).catch(() => {});
      // Only labs that have papers under the current search and time range are offered, each with its count, so a pick never leads to an empty page.
      let labTok = 0;
      const loadLabs = async () => {
        const my = ++labTok;
        try {
          const d = await api('/papers/labs?' + new URLSearchParams({ ...(f.q && { q: f.q }), ...(f.window && { days: f.window }) })); if (my !== labTok) return;
          const labs = d.labs.slice(); if (f.company && !labs.some(l => l.id === f.company)) labs.push({ id: f.company, name: COMPANY_NAMES[f.company] || f.company, n: 0 });
          const top = labs.slice(0, 8); if (f.company && !top.some(l => l.id === f.company)) top.push(labs.find(l => l.id === f.company));
          mount($('#rlabs', root), labs.length ? html`<button class="chipf ${f.company ? '' : 'on'}" data-lab="">Any lab <span class="cnt">${d.total}</span></button>${top.map(l => html`<button class="chipf ${f.company === l.id ? 'on' : ''}" data-lab="${l.id}" aria-pressed="${f.company === l.id}">${l.name} <span class="cnt">${l.n}</span></button>`)}` : html``);
          const sel = $('#rco', root); if (sel) { sel.innerHTML = String(html`<option value="">Any lab mentioned</option>${labs.map(l => html`<option value="${l.id}" ${f.company === l.id ? 'selected' : ''}>${l.name} (${l.n})</option>`)}`); }
        } catch (e) { /* the chips are an extra; the list still works */ }
      };
      const load = async more => {
        const my = ++token, list = $('#rlist', root); if (!more) { rows = 0; mount(list, skeleton(3)); } else { $('#rmore', root).disabled = true; }
        try {
          await Promise.race([cos, new Promise(r => setTimeout(r, 2500))]);
          const d = await api('/papers?' + new URLSearchParams({ limit: 20, offset: rows, ...(f.q && { q: f.q }), ...(f.company && { company: f.company }), ...(f.window && { days: f.window }) })); if (my !== token) return;
          total = d.total; const cards = d.items.map(paper);
          if (more) list.firstElementChild.insertAdjacentHTML('beforeend', cards.join('')); else mount(list, d.items.length ? html`<div class="stack">${cards}</div>` : empty('No papers match', f.q ? `Nothing matches “${f.q}”. Try fewer words, an author name or an arXiv ID.` : 'Try another lab or a longer time range.', html`<button class="pri" data-clear>Clear search and filters</button>`, 'filter'));
          rows += d.items.length; $('#rmore', root).hidden = rows >= total; $('#rmore', root).disabled = false; $('#rcount', root).textContent = total ? `Showing ${rows.toLocaleString()} of ${total.toLocaleString()} papers` : '';
          if (d.lastChecked) mount($('#rchk', root), checked(d.lastChecked));
        } catch (e) { if (my === token) { $('#rmore', root).disabled = false; mount(list, empty('Couldn’t load papers', e.message + '. Nothing was lost.', html`<button class="pri" data-retry>Try again</button>`)); } }
      };
      let t; $('#rq', root).oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); loadLabs(); load(); }, 250); };
      $('#rco', root).onchange = e => { f.company = e.target.value; loadLabs(); load(); };
      $('#rwin', root).onchange = e => { f.window = e.target.value; loadLabs(); load(); };
      root.addEventListener('click', e => {
        const lb = e.target.closest('[data-lab]'); if (lb) { f.company = lb.dataset.lab; loadLabs(); load(); return; }
        if (e.target.id === 'rmore') load(true);
        if (e.target.closest('[data-retry]')) load();
        if (e.target.closest('[data-clear]')) { Object.assign(f, { q: '', company: '', window: '' }); $('#rq', root).value = ''; $('#rco', root).value = ''; $('#rwin', root).value = ''; loadLabs(); load(); }
      });
      loadLabs(); load();
    },
  };
}
