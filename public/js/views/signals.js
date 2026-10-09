// Live Signals: everything new, with time-window, type, lab and verification filters.
import { api, html, pageHead, signalCard, empty, checked, verLegend, skeleton, mount, $, SIGNAL_LABEL } from '../lib.js';

const WINDOWS = [['1h', 'Last hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
const f = { window: '24h', cat: '', company: '', verification: '', sort: 'time' };
let shown = 0;

export async function render() {
  const facets = await api('/signals/facets');
  return {
    title: 'Live Signals',
    html: html`${pageHead('Live Signals', 'New models, research and releases as they are detected.', html`<span id="chk"></span>`)}
      ${verLegend()}
      <div class="toolbar"><div class="seg" role="group" aria-label="Time window">${WINDOWS.map(([k, l]) => html`<button data-win="${k}" class="${f.window === k ? 'on' : ''}">${l}</button>`)}</div></div>
      <div class="toolbar">
        <select id="fc" aria-label="Type"><option value="">All types</option>${facets.cats.map(c => html`<option value="${c.name}" ${f.cat === c.name ? 'selected' : ''}>${SIGNAL_LABEL[c.name] || c.name}</option>`)}</select>
        <select id="fco" aria-label="Lab"><option value="">All labs</option>${facets.companies.map(c => html`<option value="${c.id}" ${f.company === c.id ? 'selected' : ''}>${c.name}</option>`)}</select>
        <select id="fv" aria-label="Verification"><option value="">Any verification</option>${['verified', 'reported', 'community'].map(v => html`<option value="${v}" ${f.verification === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`)}</select>
        <select id="fs" aria-label="Sort"><option value="time">Newest first</option><option value="score" ${f.sort === 'score' ? 'selected' : ''}>Highest score</option></select></div>
      <div id="list">${skeleton(3)}</div><p><button id="more" hidden>Show more</button></p>`,
    after(root) {
      const load = async more => {
        const list = $('#list', root); if (!more) { shown = 0; mount(list, skeleton(3)); }
        try {
          const q = new URLSearchParams({ window: f.window, sort: f.sort, limit: 25, offset: shown, ...(f.cat && { cat: f.cat }), ...(f.company && { company: f.company }), ...(f.verification && { verification: f.verification }) });
          const d = await api('/signals?' + q);
          const cards = d.items.map(signalCard);
          if (more) list.insertAdjacentHTML('beforeend', cards.join('')); else mount(list, html`<div class="stack">${cards}</div>`);
          if (!more && !d.items.length) mount(list, empty('No signals in this window', 'Try a longer time window or clear a filter.', html`<button data-win="30d">Show 30 days</button>`));
          shown += d.items.length; $('#more', root).hidden = shown >= d.total;
          mount($('#chk', root), checked(d.lastChecked));
          list.querySelectorAll('[data-bar]').forEach(e => e.style.setProperty('--v', (+e.dataset.bar) + '%'));
        } catch (e) { mount(list, empty('Couldn’t load signals', e.message)); }
      };
      root.onclick = e => {
        const w = e.target.closest('[data-win]'); if (w) { f.window = w.dataset.win; root.querySelectorAll('[data-win].on').forEach(b => b.classList.remove('on')); root.querySelectorAll(`[data-win="${f.window}"]`).forEach(b => b.classList.add('on')); load(); }
        if (e.target.id === 'more') load(true);
      };
      const on = (id, k) => { $(id, root).onchange = ev => { f[k] = ev.target.value; load(); }; };
      on('#fc', 'cat'); on('#fco', 'company'); on('#fv', 'verification'); on('#fs', 'sort');
      load();
    },
  };
}
