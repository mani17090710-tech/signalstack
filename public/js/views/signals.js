// Live Signals: everything new, with time-window, type, lab and verification filters.
// The page draws at once. The list and the lab filter load in parallel, so a slow response never leaves a blank screen.
import { api, html, pageHead, signalCard, empty, checked, verLegend, skeleton, mount, $, SIGNAL_LABEL, VER } from '../lib.js';

const WINDOWS = [['1h', 'Last hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
const f = { window: '24h', cat: '', company: '', verification: '', sort: 'time' };
let shown = 0;
const filtered = () => !!(f.cat || f.company || f.verification);

export async function render() {
  return {
    title: 'Live Signals',
    html: html`${pageHead('Live Signals', 'New models, research and releases as they are detected. Each card links to its original source.', html`<span id="chk"><span class="upd"><i class="upd-dot" aria-hidden="true"></i>Checking…</span></span>`)}
      ${verLegend()}
      <div class="toolbar"><div class="seg" role="group" aria-label="Time window">${WINDOWS.map(([k, l]) => html`<button data-win="${k}" class="${f.window === k ? 'on' : ''}">${l}</button>`)}</div></div>
      <div class="toolbar">
        <select id="fc" aria-label="Type"><option value="">All types</option>${Object.entries(SIGNAL_LABEL).map(([k, l]) => html`<option value="${k}" ${f.cat === k ? 'selected' : ''}>${l}</option>`)}</select>
        <select id="fco" aria-label="Lab"><option value="">All labs</option></select>
        <select id="fv" aria-label="Verification"><option value="">Any verification</option>${Object.entries(VER).map(([v, x]) => html`<option value="${v}" ${f.verification === v ? 'selected' : ''}>${x[1]}</option>`)}</select>
        <select id="fs" aria-label="Sort"><option value="time">Newest first</option><option value="score" ${f.sort === 'score' ? 'selected' : ''}>Highest score</option></select></div>
      <p class="checked" id="count" aria-live="polite"></p>
      <div id="list">${skeleton(3)}</div><p class="more"><button id="more" hidden>Show more</button></p>`,
    after(root) {
      const list = $('#list', root), more = $('#more', root), count = $('#count', root);
      // Labs for the filter: filled in whenever they arrive. If this fails the filter simply stays at "All labs".
      api('/signals/facets').then(d => {
        const sel = $('#fco', root); if (!sel || !root.contains(sel)) return;
        sel.insertAdjacentHTML('beforeend', d.companies.map(c => String(html`<option value="${c.id}" ${f.company === c.id ? 'selected' : ''}>${c.name}</option>`)).join(''));
      }).catch(() => {});

      const load = async add => {
        if (!add) { shown = 0; mount(list, skeleton(3)); count.textContent = ''; }
        else { more.disabled = true; more.textContent = 'Loading…'; }
        try {
          const q = new URLSearchParams({ window: f.window, sort: f.sort, limit: 25, offset: shown, ...(f.cat && { cat: f.cat }), ...(f.company && { company: f.company }), ...(f.verification && { verification: f.verification }) });
          const d = await api('/signals?' + q);
          const cards = d.items.map(signalCard);
          if (add) list.querySelector('.stack').insertAdjacentHTML('beforeend', cards.join('')); else mount(list, html`<div class="stack">${cards}</div>`);
          if (!add && !d.items.length) {
            mount(list, filtered()
              ? empty('No signals match these filters', 'Nothing in this time window fits the type, lab and verification you chose.', html`<button class="pri" data-clear>Clear filters</button><button data-win="30d">Try 30 days</button>`, 'filter')
              : empty('No signals in this window', f.window === '30d' ? 'Nothing new has been detected in the last 30 days. Sources are checked regularly, so check back soon.' : 'Nothing new has been detected in this time window. A longer window usually has more.',
                f.window === '30d' ? '' : html`<button class="pri" data-win="${f.window === '7d' ? '30d' : '7d'}">Show ${f.window === '7d' ? '30' : '7'} days</button>`, 'signal'));
          }
          shown += d.items.length; more.hidden = shown >= d.total; more.disabled = false; more.textContent = 'Show more';
          count.textContent = d.total ? `Showing ${shown} of ${d.total} signal${d.total === 1 ? '' : 's'}` : '';
          mount($('#chk', root), checked(d.lastChecked));
        } catch (e) {
          more.disabled = false; more.textContent = 'Show more';
          if (add) { count.textContent = 'Couldn’t load more. ' + e.message + '.'; return; }
          mount(list, empty('Couldn’t load signals', `${e.message}. Nothing was lost; the server may just be slow to answer.`, html`<button class="pri" data-retry>Try again</button>`, 'data'));
        }
      };
      root.onclick = e => {
        const w = e.target.closest('[data-win]'); if (w) { f.window = w.dataset.win; root.querySelectorAll('[data-win].on').forEach(b => b.classList.remove('on')); root.querySelectorAll(`.seg [data-win="${f.window}"]`).forEach(b => b.classList.add('on')); load(); return; }
        if (e.target.closest('[data-retry]')) return load();
        if (e.target.closest('[data-clear]')) { f.cat = f.company = f.verification = ''; ['#fc', '#fco', '#fv'].forEach(id => { $(id, root).value = ''; }); return load(); }
        if (e.target.id === 'more') load(true);
      };
      const on = (id, k) => { $(id, root).onchange = ev => { f[k] = ev.target.value; load(); }; };
      on('#fc', 'cat'); on('#fco', 'company'); on('#fv', 'verification'); on('#fs', 'sort');
      load();
    },
  };
}
