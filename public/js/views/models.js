// Model Universe: browse tracked models. The everyday controls (search, category, sort) are always visible; the rest sit in a Filters panel
// with a count and removable chips, so the page stays calm.
import { api, html, pageHead, modelCard, empty, skeleton, mount, $, num, applyBars, VER } from '../lib.js';

const f = { cat: '', company: '', license: '', task: '', sort: 'best', official: false, q: '', source: '', verification: '' };
let rows = 0, total = 0, token = 0;
const SORTS = [['best', 'Best first'], ['new', 'Newest'], ['trending', 'Trending'], ['popular', 'Most liked'], ['downloads', 'Most downloaded'], ['params', 'Largest']];
const FILTERS = ['source', 'verification', 'company', 'license', 'task'];

export async function render(arg = '') {
  // A link can preselect filters, for example #models/company=qwen
  if (arg) { const a = new URLSearchParams(arg); for (const k of ['company', 'cat', 'license', 'task', 'source', 'verification']) f[k] = a.get(k) || ''; f.q = ''; f.official = false; }
  const fa = await api('/models/facets');
  const cats = fa.cats.filter(c => c.n > 0); // a category with no models is hidden rather than shown empty
  const label = {
    source: v => (v === 'api' ? 'API models' : 'Open-weight'), verification: v => (VER[v] ? VER[v][1] : v),
    company: v => (fa.companies.find(c => c.id === v) || {}).name || v, license: v => v, task: v => v,
  };
  const active = () => [...FILTERS.filter(k => f[k]).map(k => [k, label[k](f[k])]), ...(f.official ? [['official', 'Official labs only']] : [])];
  return {
    title: 'Model Universe',
    html: html`${pageHead('Model Universe', `${num(fa.total)} models tracked: official and popular open-weight models from Hugging Face, plus API models from OpenRouter. A curated slice, not every model that exists.`)}
      <div class="toolbar tb-main"><input id="mq" type="search" placeholder="Search models by name" value="${f.q}" aria-label="Search models by name">
        <select id="mso" aria-label="Sort">${SORTS.map(([k, l]) => html`<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`)}</select>
        <button id="mftog" class="ftog" aria-expanded="false" aria-controls="mfil">Filters <span class="fcount" id="mfc" hidden></span></button></div>
      <div class="toolbar"><div class="seg" role="group" aria-label="Category"><button data-cat="" class="${f.cat === '' ? 'on' : ''}">All<span class="n">${num(fa.total)}</span></button>${cats.map(c => html`<button data-cat="${c.id}" class="${f.cat === c.id ? 'on' : ''}">${c.label}<span class="n">${num(c.n)}</span></button>`)}</div></div>
      <div class="fpanel" id="mfil" hidden>
        <label>Access<select id="msrc"><option value="">Open and API models</option><option value="huggingface" ${f.source === 'huggingface' ? 'selected' : ''}>Open-weight (Hugging Face)</option><option value="api" ${f.source === 'api' ? 'selected' : ''}>API models (closed or hosted)</option></select></label>
        <label>Verification<select id="mve"><option value="">Any</option>${fa.verification.map(v => html`<option value="${v.id}" ${f.verification === v.id ? 'selected' : ''}>${VER[v.id] ? VER[v.id][1] : v.label} (${v.n})</option>`)}</select></label>
        <label>Lab<select id="mco"><option value="">All labs</option>${fa.companies.map(c => html`<option value="${c.id}" ${f.company === c.id ? 'selected' : ''}>${c.name} (${c.n})</option>`)}</select></label>
        <label>License<select id="mli"><option value="">Any</option>${fa.licenses.map(l => html`<option ${f.license === l.name ? 'selected' : ''} value="${l.name}">${l.name} (${l.n})</option>`)}</select></label>
        <label>Task<select id="mta"><option value="">Any</option>${fa.tasks.map(l => html`<option ${f.task === l.name ? 'selected' : ''} value="${l.name}">${l.name} (${l.n})</option>`)}</select></label>
        <label class="chk"><input type="checkbox" id="mof" ${f.official ? 'checked' : ''}><span>Official lab releases only</span></label></div>
      <div class="chips" id="mchips" aria-label="Active filters"></div>
      <p class="checked" id="mcount" aria-live="polite"></p><div id="mlist">${skeleton(3)}</div><p class="more"><button id="mmore" hidden>Load more</button></p>`,
    after(root) {
      const sync = () => {
        const a = active(); $('#mfc', root).hidden = !a.length; $('#mfc', root).textContent = a.length;
        mount($('#mchips', root), html`${a.map(([k, l]) => html`<button class="chip" data-x="${k}">${l} <span aria-hidden="true">×</span><span class="sr">Remove filter</span></button>`)}${a.length > 1 ? html`<button class="link" data-x="all">Clear all</button>` : ''}`);
        if (a.length) $('#mfil', root).hidden = false, $('#mftog', root).setAttribute('aria-expanded', 'true');
      };
      const load = async more => {
        const my = ++token, list = $('#mlist', root);
        if (!more) { rows = 0; mount(list, skeleton(3)); }
        try {
          const q = new URLSearchParams({ sort: f.sort, limit: 30, offset: rows, ...(f.q && { q: f.q }), ...(f.cat && { cat: f.cat }), ...(f.company && { company: f.company }), ...(f.license && { license: f.license }), ...(f.task && { task: f.task }), ...(f.official && { official: 1 }), ...(f.source && { source: f.source }), ...(f.verification && { verification: f.verification }) });
          const d = await api('/models?' + q); if (my !== token) return;
          total = d.total; const cards = d.items.map(modelCard);
          if (more) { list.firstElementChild.insertAdjacentHTML('beforeend', cards.join('')); applyBars(list); }
          else mount(list, d.items.length ? html`<div class="grid">${cards}</div>` : empty('No models match', f.q ? `Nothing matches “${f.q}” with these filters. Check the spelling or clear a filter.` : 'Clear a filter or try a different category.', active().length || f.q ? html`<button class="pri" data-x="all">Clear search and filters</button>` : '', 'filter'));
          rows += d.items.length; $('#mmore', root).hidden = rows >= total;
          $('#mcount', root).textContent = total ? `Showing ${rows.toLocaleString()} of ${total.toLocaleString()} models` : '';
        } catch (e) { if (my === token) mount(list, empty('Couldn’t load models', e.message + '. Nothing was lost.', html`<button class="pri" data-x="retry">Try again</button>`)); }
      };
      const reset = () => { Object.assign(f, { q: '', company: '', license: '', task: '', source: '', verification: '', official: false }); ['#mq', '#msrc', '#mve', '#mco', '#mli', '#mta'].forEach(id => { $(id, root).value = ''; }); $('#mof', root).checked = false; };
      let t; $('#mq', root).oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 250); };
      const on = (id, k) => { $(id, root).onchange = e => { f[k] = e.target.value; sync(); load(); }; };
      on('#msrc', 'source'); on('#mve', 'verification'); on('#mco', 'company'); on('#mli', 'license'); on('#mta', 'task'); on('#mso', 'sort');
      $('#mof', root).onchange = e => { f.official = e.target.checked; sync(); load(); };
      root.addEventListener('click', e => {
        const c = e.target.closest('[data-cat]'); if (c) { f.cat = c.dataset.cat; root.querySelectorAll('[data-cat]').forEach(b => b.classList.toggle('on', b === c)); load(); return; }
        if (e.target.closest('#mftog')) { const p = $('#mfil', root), open = p.hidden; p.hidden = !open; $('#mftog', root).setAttribute('aria-expanded', String(open)); return; }
        const x = e.target.closest('[data-x]');
        if (x) {
          const k = x.dataset.x;
          if (k === 'all') { reset(); if ($('#mfil', root).querySelectorAll('select').length) { /* panel stays as it was */ } }
          else if (k === 'official') { f.official = false; $('#mof', root).checked = false; }
          else if (FILTERS.includes(k)) { f[k] = ''; $({ source: '#msrc', verification: '#mve', company: '#mco', license: '#mli', task: '#mta' }[k], root).value = ''; }
          sync(); load(); return;
        }
        if (e.target.id === 'mmore') load(true);
      });
      sync(); load();
    },
  };
}
