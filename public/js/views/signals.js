// Live Signals: everything new, with time-window, type, lab and verification filters.
// The page draws at once. The list and the lab filter load in parallel, so a slow response never leaves a blank screen.
import { api, html, pageHead, signalCard, compactRow, empty, checked, verLegend, skeleton, mount, $, VER } from '../lib.js';

const WINDOWS = [['1h', 'Last hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
const SHORT = { '1h': 'last hour', '6h': 'last 6 hours', '24h': 'last 24 hours' };
const f = { window: '24h', cat: '', company: '', verification: '', sort: 'time' };
let shown = 0;
// Detailed cards for research, a compact list for scanning. The choice is remembered in this browser.
const VIEW = 'ss_feedview';
const getView = () => { try { return localStorage.getItem(VIEW) === 'compact' ? 'compact' : 'detailed'; } catch (e) { return 'detailed'; } };
const setView = v => { try { localStorage.setItem(VIEW, v); } catch (e) { /* storage unavailable */ } };
let mode = getView(), items = [];
// Types shown in the filter. A value can name several categories (comma-separated), which is how the Now page links to "all models" or "all lab updates".
const TYPES = [['Model Release,Trending', 'Models'], ['Research', 'Papers'], ['Announcement,Open Source', 'Lab updates (blogs and releases)'], ['Open Source', 'Software releases only'], ['Announcement', 'Blog posts only']];
const filtered = () => !!(f.cat || f.company || f.verification);

const cardOf = s => (mode === 'compact' ? compactRow(s) : signalCard(s));

export async function render(arg = '') {
  mode = getView();
  // A link from Now can preselect filters, for example #signals/cat=Research&window=7d
  if (arg) { const a = new URLSearchParams(arg); f.cat = a.get('cat') || ''; f.company = a.get('company') || ''; f.verification = ''; if (WINDOWS.some(([k]) => k === a.get('window'))) f.window = a.get('window'); if (['time', 'score'].includes(a.get('sort'))) f.sort = a.get('sort'); }
  return {
    title: 'All signals',
    html: html`${pageHead('All signals', html`The full feed: every new model, paper and release as it is detected, newest first. Each card links to its original source. Want just the highlights? <a href="#now">See Now</a>.`, html`<span id="chk"><span class="upd"><i class="upd-dot" aria-hidden="true"></i>Checking…</span></span>`)}
      ${verLegend()}
      <p class="fallback" id="fallback" role="status" hidden></p><div class="toolbar"><div class="seg" role="group" aria-label="Time window">${WINDOWS.map(([k, l]) => html`<button data-win="${k}" class="${f.window === k ? 'on' : ''}">${l}</button>`)}</div>
        <div class="seg viewseg" role="group" aria-label="Feed view"><button data-view="detailed" class="${mode === 'detailed' ? 'on' : ''}" aria-pressed="${mode === 'detailed'}">Detailed</button><button data-view="compact" class="${mode === 'compact' ? 'on' : ''}" aria-pressed="${mode === 'compact'}">Compact</button></div></div>
      <div class="toolbar">
        <select id="fc" aria-label="Type"><option value="">All types</option>${TYPES.map(([k, l]) => html`<option value="${k}" ${f.cat === k ? 'selected' : ''}>${l}</option>`)}</select>
        <select id="fco" aria-label="Lab"><option value="">All labs</option></select>
        <select id="fv" aria-label="Verification"><option value="">Any verification</option>${Object.entries(VER).map(([v, x]) => html`<option value="${v}" ${f.verification === v ? 'selected' : ''}>${x[1]}</option>`)}</select>
        <select id="fs" aria-label="Sort"><option value="time" ${f.sort === 'time' ? 'selected' : ''}>Newest first</option><option value="score" ${f.sort === 'score' ? 'selected' : ''}>Highest score</option></select></div>
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
          let d = await api('/signals?' + q), widened = '';
          // A very short window can look broken. If it is empty, show the latest 7 days instead and say so plainly.
          if (!add && !d.items.length && SHORT[f.window]) {
            const was = SHORT[f.window];
            q.set('window', '7d'); const wide = await api('/signals?' + q);
            if (wide.items.length) { d = wide; f.window = '7d'; widened = `No signals in the ${was}. Showing the latest 7-day results instead.`; root.querySelectorAll('[data-win].on').forEach(b => b.classList.remove('on')); root.querySelectorAll('.seg [data-win="7d"]').forEach(b => b.classList.add('on')); }
          }
          const fb = $('#fallback', root); if (fb) { fb.textContent = widened; fb.hidden = !widened; }
          items = add ? items.concat(d.items) : d.items;
          if (add) list.querySelector('.stack').insertAdjacentHTML('beforeend', d.items.map(cardOf).join('')); else mount(list, html`<div class="stack ${mode === 'compact' ? 'compact' : ''}">${d.items.map(cardOf)}</div>`);
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
        const vw = e.target.closest('[data-view]');
        if (vw) {
          mode = vw.dataset.view; setView(mode);
          root.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === mode); b.setAttribute('aria-pressed', String(b.dataset.view === mode)); });
          const st = list.querySelector('.stack'); if (st) { st.classList.toggle('compact', mode === 'compact'); mount(st, html`${items.map(cardOf)}`); }
          return;
        }
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
