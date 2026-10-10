// App shell: top bar, bottom navigation on phones, hash router, and the data every page shares.
import { $, $$, api, html, raw, mount, state, failed, skeleton } from './lib.js';
import { openAuth } from './auth.js';
import { showIntro, introSeen } from './intro.js';
import * as home from './views/home.js';
import * as signals from './views/signals.js';
import * as models from './views/models.js';
import * as model from './views/model.js';
import * as research from './views/research.js';
import * as search from './views/search.js';
import * as you from './views/you.js';
import * as extras from './views/extras.js';
import * as admin from './views/admin.js';

const ICON = {
  now: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', models: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
  signals: '<path d="M4 18a8 8 0 0 1 8-8m-8 8a14 14 0 0 1 14-14M4 18h.01"/>', research: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7"/>',
  you: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};
const rawSvg = k => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`);

// route name -> [view module, which nav item to highlight]
const VIEWS = {
  now: [home, 'now'], signals: [signals, 'signals'], models: [models, 'models'], model: [model, 'models'], research: [research, 'research'],
  search: [search, ''], company: [extras.company, 'models'], companies: [extras.companies, 'models'], compare: [extras.compare, 'you'],
  benchmarks: [extras.benchmarks, 'you'], docs: [extras.docs, 'you'], you: [you, 'you'], watchlist: [you.watchlist, 'you'], alerts: [you.alerts, 'you'], admin: [admin, 'you'],
};
const NAV = [['now', 'Home'], ['models', 'Models'], ['signals', 'Signals'], ['research', 'Research'], ['you', 'You']];
const PRIVATE = ['watchlist', 'alerts', 'admin'];

function shell() {
  mount($('#root'), html`<header class="top">
      <a class="brand" href="#now" aria-label="Signalstack home"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="3.2" fill="#35d4f4"/><circle cx="16" cy="16" r="8" fill="none" stroke="#35d4f4" stroke-opacity=".6" stroke-width="1.6"/><circle cx="16" cy="16" r="12.5" fill="none" stroke="#35d4f4" stroke-opacity=".3" stroke-width="1.3"/></svg>Signalstack</a>
      <nav class="nav" aria-label="Main">${[['now', 'Now'], ['signals', 'Signals'], ['models', 'Models'], ['research', 'Research'], ['companies', 'Companies'], ['compare', 'Compare']].map(([k, l]) => html`<a href="#${k}" data-nav="${k}">${l}</a>`)}</nav>
      <form class="sform" id="sf" role="search"><label class="sr" for="sq">Search</label><input id="sq" type="search" placeholder="Search models, labs, papers" autocomplete="off"></form>
      <div class="acct" id="acct"></div>
    </header>
    <main id="main" tabindex="-1"></main>
    <nav class="bottom" aria-label="Main">${NAV.map(([k, l]) => html`<a href="#${k}" data-nav="${k}">${rawSvg(k)}<span>${l}</span></a>`)}</nav>`);
  let t; const sq = $('#sq');
  // Debounced: search only after the person pauses typing.
  sq.oninput = () => { clearTimeout(t); t = setTimeout(() => { const v = sq.value.trim(); if (v.length >= 2) location.hash = 'search/' + encodeURIComponent(v); }, 350); };
  $('#sf').onsubmit = e => { e.preventDefault(); clearTimeout(t); const v = sq.value.trim(); if (v.length >= 2) location.hash = 'search/' + encodeURIComponent(v); };
  drawAcct();
}
function drawAcct() {
  const m = state.me;
  mount($('#acct'), m ? html`<span class="who">${m.name || m.email}</span><button id="lo" class="desk">Log out</button>` : html`<button id="li" class="desk">Log in</button><button class="pri" id="su">Sign up</button>`);
  if (m) $('#lo').onclick = async () => { await api('/logout'); state.me = null; state.watch = []; drawAcct(); route(); };
  else { $('#li').onclick = () => openAuth('login', boot); $('#su').onclick = () => openAuth('signup', boot); }
}

let seq = 0;
export async function route() {
  const [r, ...rest] = (location.hash.replace(/^#\/?/, '') || 'now').split('/'), arg = rest.join('/');
  const [view, navKey] = VIEWS[r] || [null, ''];
  $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === navKey || a.dataset.nav === r));
  const main = $('#main'), mine = ++seq;
  if (!view) { mount(main, html`<div class="empty"><h3>Page not found</h3><p>That address doesn’t exist.</p><a href="#now">Go to Home</a></div>`); return; }
  if (PRIVATE.includes(r) && !state.me) { mount(main, you.gate()); return; }
  mount(main, skeleton(4)); scrollTo(0, 0);
  try {
    const out = await (view.render || view.default)(decodeURIComponent(arg));
    if (mine !== seq) return; // a newer navigation started; drop this result
    mount(main, out.html || out); if (out.after) out.after(main);
    document.title = (out.title ? out.title + ' | ' : '') + 'Signalstack';
  } catch (e) {
    if (mine !== seq) return;
    if (e.code === 401 && state.me) { state.me = null; state.watch = []; drawAcct(); return route(); }
    mount(main, e.code === 401 ? you.gate() : failed(e));
  }
}

// One delegated click handler (CSP forbids inline handlers).
document.addEventListener('click', async e => {
  const w = e.target.closest('[data-watch]');
  if (w) {
    if (!state.me) return openAuth('login', boot);
    const id = w.dataset.watch;
    state.watch = await api('/watchlist', state.watch.includes(id) ? 'DELETE' : 'POST', { model_id: id });
    $$('[data-watch]').forEach(b => { if (b.dataset.watch === id) b.textContent = state.watch.includes(id) ? 'Watching' : (b.dataset.long ? 'Watch this model' : 'Watch'); });
    if (location.hash.startsWith('#watchlist')) route();
    return;
  }
  const a = e.target.closest('[data-action]');
  if (a && a.dataset.action === 'reload') route();
  if (a && a.dataset.action === 'login') openAuth('login', boot);
  if (a && a.dataset.action === 'signup') openAuth('signup', boot);
  if (a && a.dataset.action === 'intro') showIntro(go);
});
const go = to => { if (location.hash === '#' + to) route(); else location.hash = to; };
addEventListener('hashchange', route);

async function pollAlerts() {
  if (!state.me || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const d = await api('/alerts'); let seen = 0; try { seen = +(localStorage.getItem('ss_seen') || 0); } catch (e) { /* ok */ }
    d.matches.filter(e => e.id > seen).forEach(e => new Notification('Signalstack: ' + e.sev, { body: e.summary }));
    if (d.matches.length) try { localStorage.setItem('ss_seen', Math.max(...d.matches.map(e => e.id))); } catch (e) { /* ok */ }
  } catch (e) { /* offline */ }
}

export async function boot() {
  state.me = null; state.watch = [];
  try { state.status = await api('/status'); } catch (e) { /* page will show its own error */ }
  try { state.me = await api('/me'); state.watch = await api('/watchlist'); } catch (e) { /* guest */ }
  if (!$('#main')) shell(); else drawAcct();
  await route();
}
shell(); boot();
setInterval(pollAlerts, 60000);
if (!introSeen() && !location.hash.replace('#', '')) showIntro(go);
