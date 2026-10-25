// App shell: top bar, bottom navigation on phones, hash router, and the data every page shares.
import { $, $$, api, html, raw, mount, state, failed, skeleton, ago, trustBar } from './lib.js';
import { openAuth } from './auth.js';
import { showIntro, introSeen } from './intro.js';
import * as motion from './motion.js';
import { initPreview } from './preview.js';
import { initSuggest } from './suggest.js';
import * as savedMod from './saved.js';
import * as home from './views/home.js';
import * as signals from './views/signals.js';
import * as models from './views/models.js';
import * as model from './views/model.js';
import * as research from './views/research.js';
import * as search from './views/search.js';
import * as you from './views/you.js';
import * as extras from './views/extras.js';
import * as admin from './views/admin.js';
import * as apidocs from './views/apidocs.js';
import * as digestView from './views/digest.js';

const ICON = {
  now: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', models: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
  signals: '<path d="M4 18a8 8 0 0 1 8-8m-8 8a14 14 0 0 1 14-14M4 18h.01"/>', research: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7"/>',
  you: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};
const rawSvg = k => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`);

// route name -> [view module, which nav item to highlight]
const VIEWS = {
  now: [home, 'now'], signals: [signals, 'signals'], models: [models, 'models'], model: [model, 'models'], research: [research, 'research'],
  search: [search, ''], company: [extras.company, 'models'], companies: [extras.companies, 'models'], family: [extras.family, 'models'], saved: [savedMod.view, 'you'], api: [apidocs, 'you'], digest: [digestView, 'you'], compare: [extras.compare, 'you'],
  benchmarks: [extras.benchmarks, 'you'], docs: [extras.docs, 'you'], you: [you, 'you'], watchlist: [you.watchlist, 'you'], alerts: [you.alerts, 'you'], admin: [admin, 'you'],
};
const NAV = [['now', 'Now'], ['models', 'Models'], ['signals', 'Signals'], ['research', 'Research'], ['you', 'You']];
const PRIVATE = ['watchlist', 'alerts', 'admin', 'saved', 'digest'];

function shell() {
  mount($('#root'), html`<header class="top">
      <a class="brand" href="#now" aria-label="Signalstack home"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="3.2" fill="#35d4f4"/><circle cx="16" cy="16" r="8" fill="none" stroke="#35d4f4" stroke-opacity=".6" stroke-width="1.6"/><circle cx="16" cy="16" r="12.5" fill="none" stroke="#35d4f4" stroke-opacity=".3" stroke-width="1.3"/></svg>Signalstack</a>
      <nav class="nav" aria-label="Main">${[['now', 'Now'], ['signals', 'Signals'], ['models', 'Models'], ['research', 'Research'], ['companies', 'Companies'], ['compare', 'Compare']].map(([k, l]) => html`<a href="#${k}" data-nav="${k}">${l}</a>`)}</nav>
      <button type="button" class="sbtn" id="sopen" aria-label="Search" aria-expanded="false"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button>
      <form class="sform" id="sf" role="search"><label class="sr" for="sq">Search</label><input id="sq" type="search" placeholder="Search models, labs, papers" autocomplete="off"><button type="button" class="sclose" id="sclose" aria-label="Close search">Cancel</button></form>
      <div class="acct" id="acct"></div>
    </header>
    <main id="main" tabindex="-1"></main>
    <footer class="trust" id="trust" hidden></footer>
    <nav class="bottom" aria-label="Main">${NAV.map(([k, l]) => html`<a href="#${k}" data-nav="${k}">${rawSvg(k)}<span>${l}</span></a>`)}</nav>`);
  const sq = $('#sq');
  // Typing shows quick suggestions (suggest.js); Enter opens the full results page. Typing never moves the person off the page they are on.
  initSuggest(sq, $('#sf'));
  $('#sf').onsubmit = e => { e.preventDefault(); const v = sq.value.trim(); if (v.length >= 2) location.hash = 'search/' + encodeURIComponent(v); };
  // Phones: the search is an icon that opens a full-width field over the header, and closes on Cancel, Escape or navigating.
  const top = $('.top'), setSearch = on => { top.classList.toggle('searching', on); $('#sopen').setAttribute('aria-expanded', String(on)); if (on) sq.focus(); };
  $('#sopen').onclick = () => setSearch(true); $('#sclose').onclick = () => { sq.value = ''; setSearch(false); };
  sq.addEventListener('keydown', e => { if (e.key === 'Escape') setSearch(false); });
  addEventListener('hashchange', () => top.classList.remove('searching'));
  drawAcct();
}
function drawAcct() {
  const m = state.me;
  mount($('#acct'), m ? html`<a class="adminlink" href="#saved">Saved</a>${m.role === 'admin' ? html`<a class="adminlink" href="#admin">Admin</a>` : ''}<a class="who" href="#you" title="Your account">${m.name || m.email}</a><button id="lo" class="desk">Log out</button>` : html`<button id="li" class="desk">Log in</button><button class="pri" id="su">Sign up</button>`);
  if (m) $('#lo').onclick = async () => { await api('/logout'); state.me = null; state.watch = []; state.follows = []; state.saved = new Set(); state.collections = []; drawAcct(); route(); };
  else { $('#li').onclick = () => openAuth('login', boot); $('#su').onclick = () => openAuth('signup', boot); }
}

// Footer trust line, from the site status. Hidden until the numbers arrive, and on Now (which shows the same facts at the top).
function drawTrust() {
  const st = state.status || {}, f = $('#trust'); if (!f || !st.counts) return;
  mount(f, html`${trustBar({ week: st.counts.eventsWeek, sources: st.sources && st.sources.total, lastChecked: st.lastUpdate })}<p>Every item links to its original source and says how far that source can be trusted. <a href="#api">API, RSS and embed</a></p>`); f.hidden = false;
}
let seq = 0;
export async function route() {
  const [r, ...rest] = (location.hash.replace(/^#\/?/, '') || 'now').split('/'), arg = rest.join('/');
  const [view, navKey] = VIEWS[r] || [null, ''];
  $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === navKey || a.dataset.nav === r));
  const main = $('#main'), mine = ++seq; document.body.dataset.route = r || 'now';
  if (!view) { mount(main, html`<div class="empty"><h3>Page not found</h3><p>That address doesn’t exist.</p><a href="#now">Go to Home</a></div>`); return; }
  if (PRIVATE.includes(r) && !state.me) { mount(main, you.gate()); return; }
  mount(main, skeleton(4)); scrollTo(0, 0);
  try {
    const out = await (view.render || view.default)(decodeURIComponent(arg));
    if (mine !== seq) return; // a newer navigation started; drop this result
    mount(main, out.html || out); if (out.after) out.after(main);
    motion.enter(main);
    document.title = (out.title ? out.title + ' | ' : '') + 'Signalstack';
  } catch (e) {
    if (mine !== seq) return;
    if (e.code === 401 && state.me) { state.me = null; state.watch = []; drawAcct(); return route(); }
    mount(main, e.code === 401 ? you.gate() : failed(e));
  }
}

// Update every Follow button on screen to match what the person follows.
function markFollows() {
  $$('[data-follow]').forEach(b => { const [kind, ...r] = b.dataset.follow.split('|'), on = state.follows.some(x => x.kind === kind && x.key === r.join('|')); b.textContent = on ? 'Following' : 'Follow'; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
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
  const sv = e.target.closest('[data-save]');
  if (sv) { if (!state.me) return openAuth('login', boot); return savedMod.onSave(sv); }
  const fo = e.target.closest('[data-follow]');
  if (fo) {
    if (!state.me) return openAuth('login', boot);
    const [kind, ...rest] = fo.dataset.follow.split('|'), key = rest.join('|'), on = state.follows.some(x => x.kind === kind && x.key === key);
    fo.disabled = true;
    try { state.follows = await api('/follows', on ? 'DELETE' : 'POST', { kind, key }); } catch (x) { alert(x.message); }
    fo.disabled = false; markFollows();
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
  state.me = null; state.watch = []; state.follows = []; state.saved = new Set(); state.collections = [];
  if (!$('#main')) shell(); else drawAcct();
  // Everything starts at once instead of one request after another: the page, who is logged in, and the site counts.
  const who = (async () => { let saved; try { state.me = await api('/me'); [state.watch, state.follows, saved] = await Promise.all([api('/watchlist'), api('/follows'), api('/collections')]); savedMod.applyState(saved); } catch (e) { /* guest */ } })()
    .then(() => { drawAcct(); markFollows(); $$('[data-watch]').forEach(b => { if (state.watch.includes(b.dataset.watch)) b.textContent = 'Watching'; }); });
  state.whoReady = who; // pages that need to know who is logged in (the Now page's Watching section) wait for this
  const stat = api('/status').then(s => { state.status = s; drawTrust(); }).catch(() => { /* the page shows its own error */ });
  // Only pages that need to know who you are (or the site counts) wait for those; public pages never do.
  if ([...PRIVATE, 'you'].includes((location.hash.replace(/^#\/?/, '') || 'now').split('/')[0])) await Promise.all([who, stat]);
  await route();
}
shell(); boot();
setInterval(pollAlerts, 60000);
setInterval(() => api('/status').then(s => { state.status = s; drawTrust(); }).catch(() => {}), 300000);
// Keep every "5 min ago" on screen honest without reloading: refresh them once a minute. A "Last updated" older than an hour turns amber.
setInterval(() => $$('[data-ts]').forEach(el => {
  const ts = el.dataset.ts; if (!ts) return;
  el.textContent = ago(ts);
  const u = el.closest('.upd'); if (u) u.classList.toggle('stale', Date.now() - Date.parse(ts.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? '' : 'Z')) > 36e5);
}), 60000);
// Play the intro when someone arrives at the front door (no link to a specific page), once per visit.
if (!introSeen() && ['', 'now'].includes(location.hash.replace(/^#\/?/, ''))) showIntro(go);
initPreview(); savedMod.initSaved();
