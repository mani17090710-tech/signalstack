// Model Universe: browse every tracked model by category, lab, license and task.
import { api, html, pageHead, modelCard, empty, skeleton, mount, $, num, applyBars } from '../lib.js';

const f = { cat: '', company: '', license: '', task: '', sort: 'new', official: false, q: '' };
let rows = 0, total = 0, token = 0;
const SORTS = [['new', 'Newest'], ['trending', 'Trending'], ['popular', 'Most liked'], ['downloads', 'Most downloaded'], ['params', 'Largest']];

export async function render() {
  const fa = await api('/models/facets');
  const cats = fa.cats.filter(c => c.n > 0); // a category with no models is hidden rather than shown empty
  return {
    title: 'Model Universe',
    html: html`${pageHead('Model Universe', `${num(fa.total)} models collected from Hugging Face. Open a model for its sources, size, license and related research.`)}
      <div class="toolbar"><div class="seg" role="group" aria-label="Category"><button data-cat="" class="${f.cat === '' ? 'on' : ''}">All<span class="n">${num(fa.total)}</span></button>${cats.map(c => html`<button data-cat="${c.id}" class="${f.cat === c.id ? 'on' : ''}">${c.label}<span class="n">${num(c.n)}</span></button>`)}</div></div>
      <div class="toolbar"><input id="mq" type="search" placeholder="Filter by model name" value="${f.q}" aria-label="Filter by model name">
        <select id="mco" aria-label="Lab"><option value="">All labs</option>${fa.companies.map(c => html`<option value="${c.id}" ${f.company === c.id ? 'selected' : ''}>${c.name} (${c.n})</option>`)}</select>
        <select id="mli" aria-label="License"><option value="">Any license</option>${fa.licenses.map(l => html`<option ${f.license === l.name ? 'selected' : ''} value="${l.name}">${l.name} (${l.n})</option>`)}</select>
        <select id="mta" aria-label="Task"><option value="">Any task</option>${fa.tasks.map(l => html`<option ${f.task === l.name ? 'selected' : ''} value="${l.name}">${l.name} (${l.n})</option>`)}</select>
        <select id="mso" aria-label="Sort">${SORTS.map(([k, l]) => html`<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`)}</select>
        <label class="chk"><input type="checkbox" id="mof" ${f.official ? 'checked' : ''}><span>Official lab releases only</span></label></div>
      <p class="checked" id="mcount"></p><div id="mlist">${skeleton(3)}</div><p><button id="mmore" hidden>Load more</button></p>`,
    after(root) {
      const load = async more => {
        const my = ++token, list = $('#mlist', root);
        if (!more) { rows = 0; mount(list, skeleton(3)); }
        try {
          const q = new URLSearchParams({ sort: f.sort, limit: 30, offset: rows, ...(f.q && { q: f.q }), ...(f.cat && { cat: f.cat }), ...(f.company && { company: f.company }), ...(f.license && { license: f.license }), ...(f.task && { task: f.task }), ...(f.official && { official: 1 }) });
          const d = await api('/models?' + q); if (my !== token) return;
          total = d.total; const cards = d.items.map(modelCard);
          if (more) { list.firstElementChild.insertAdjacentHTML('beforeend', cards.join('')); applyBars(list); }
          else mount(list, d.items.length ? html`<div class="grid">${cards}</div>` : empty('No models match', 'Clear a filter or try a different name.'));
          rows += d.items.length; $('#mmore', root).hidden = rows >= total;
          $('#mcount', root).textContent = `Showing ${rows.toLocaleString()} of ${total.toLocaleString()}`;
        } catch (e) { if (my === token) mount(list, empty('Couldn’t load models', e.message)); }
      };
      let t; $('#mq', root).oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); };
      const on = (id, k) => { $(id, root).onchange = e => { f[k] = e.target.value; load(); }; };
      on('#mco', 'company'); on('#mli', 'license'); on('#mta', 'task'); on('#mso', 'sort');
      $('#mof', root).onchange = e => { f.official = e.target.checked; load(); };
      root.addEventListener('click', e => {
        const c = e.target.closest('[data-cat]'); if (c) { f.cat = c.dataset.cat; root.querySelectorAll('[data-cat]').forEach(b => b.classList.toggle('on', b === c)); load(); }
        if (e.target.id === 'mmore') load(true);
      });
      load();
    },
  };
}
