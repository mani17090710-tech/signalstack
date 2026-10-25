// Hover preview for models on Now and Signals. Point at a model name and a small card shows what it is, its score and the key
// numbers, with a button to the full page and one to the original source. People who want the detail still get all of it;
// people in a hurry get the gist without leaving the list. Mouse and keyboard focus only (touch has no hover: a tap still opens the page).
import { api, html, mount, num, day, isApi, ctxLabel, safeUrl, host, verBadge, scoreRing, dateLabel, mid, shortName } from './lib.js';
import { plainLine } from './views/explain.js';

const TRIGGER = '.sig h3 a[href^="#model/"], .sig-row h3 a[href^="#model/"], .mcard .mc-name';
const cache = new Map();
let pv, openFor = null, tOpen, tClose, seq = 0;

const where = () => ['now', 'signals', ''].includes(location.hash.replace(/^#\/?/, '').split('/')[0]);
const money = v => '$' + (v >= 100 ? Math.round(v) : v >= 1 ? +v.toFixed(2) : +v.toFixed(3));
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function el() {
  if (pv) return pv;
  pv = document.createElement('aside'); pv.id = 'pv'; pv.className = 'pv'; pv.hidden = true; pv.setAttribute('aria-label', 'Model preview');
  pv.addEventListener('pointerenter', () => clearTimeout(tClose));
  pv.addEventListener('pointerleave', () => { if (!pv.classList.contains('sheet')) hide(160); });
  pv.addEventListener('click', e => { if (e.target.closest('a')) hide(0); });
  document.body.append(pv);
  return pv;
}

function card(d) {
  const m = d.model, s = d.signal, api = isApi(m), name = shortName(m.id).split('/').pop(), src = safeUrl(d.source_url);
  const stats = api
    ? [['Context', ctxLabel(m.context_length) || 'Not listed'], ['Input', m.price_in == null ? 'Not listed' : money(m.price_in) + ' / 1M'], ['Output', m.price_out == null ? 'Not listed' : money(m.price_out) + ' / 1M']]
    : [['Size', m.params || 'Not listed'], ['Likes', num(m.likes)], ['Downloads', num(m.downloads)]];
  return html`<div class="pv-top"><div><b class="pv-name">${name}</b><span class="pv-by">${m.company || m.creator || 'Unknown publisher'}</span></div>${scoreRing(s.score)}</div>
    <div class="pv-tags">${verBadge(m.verification)}<span class="imp imp-${s.importance}">${s.importance}</span></div>
    <p class="pv-line">${plainLine(m)}</p>
    <dl class="pv-stats">${stats.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
    <div class="pv-bar" aria-hidden="true"><i data-v="${s.score}"></i></div>
    ${s.why.length ? html`<p class="pv-why">${s.why[0]}</p>` : ''}
    <p class="pv-date">${dateLabel(m)} ${day(m.released_at)}</p>
    <div class="pv-act"><a class="pv-go" href="#model/${mid(m.id)}">Full details</a>${src ? html`<a class="pv-src" href="${src}" target="_blank" rel="noopener noreferrer">${host(src) || 'Source'} <span aria-hidden="true">↗</span></a>` : html`<span class="pv-nosrc">Source link not available</span>`}</div>
    <p class="pv-note">Short version, from the same data as the full page.</p>`;
}

function place(a) {
  const p = el(), r = a.getBoundingClientRect(), w = Math.min(340, innerWidth - 16);
  p.style.setProperty('width', w + 'px');
  let x = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const h = p.offsetHeight, below = r.bottom + 8 + h <= innerHeight || r.top - 8 - h < 8;
  p.style.setProperty('left', x + 'px');
  p.style.setProperty('top', Math.max(8, below ? r.bottom + 8 : r.top - 8 - h) + 'px');
  p.classList.toggle('up', !below);
}

function paint(a) {
  const p = el();
  requestAnimationFrame(() => p.querySelectorAll('.pv-bar i').forEach(i => i.style.setProperty('--v', i.dataset.v + '%')));
  place(a);
  p.hidden = false; requestAnimationFrame(() => p.classList.add('on'));
}

async function show(a) {
  if (!where()) return;
  const id = decodeURIComponent((a.getAttribute('href') || '').replace('#model/', '')) || null;
  if (!id) return;
  clearTimeout(tClose); openFor = a; const my = ++seq, p = el();
  a.setAttribute('aria-describedby', 'pv');
  if (!cache.has(id)) {
    mount(p, html`<div class="pv-load"><i></i><i></i><i></i></div>`); paint(a);
    try { cache.set(id, await api('/models/' + mid(id) + '/preview')); }
    catch (e) { if (my === seq) { mount(p, html`<p class="pv-line">Preview not available. Open the model for details.</p>`); place(a); } return; }
  }
  if (my !== seq || openFor !== a) return;
  mount(p, card(cache.get(id))); p.classList.remove('on'); paint(a);
}

function hide(ms = 0) {
  clearTimeout(tOpen); clearTimeout(tClose);
  tClose = setTimeout(() => {
    seq++; if (openFor) openFor.removeAttribute('aria-describedby'); openFor = null;
    if (pv) { pv.classList.remove('on'); pv.hidden = true; }
  }, ms);
}

// Touch: the same card as a bottom sheet. Opened by the Quick look button; closed by the backdrop, the close button, Escape or navigating.
let scrim;
async function sheet(id) {
  if (!scrim) { scrim = document.createElement('div'); scrim.className = 'pv-scrim'; scrim.hidden = true; scrim.addEventListener('click', closeSheet); document.body.append(scrim); }
  const p = el(), my = ++seq; clearTimeout(tOpen); clearTimeout(tClose); if (openFor) openFor.removeAttribute('aria-describedby'); openFor = null;
  for (const k of ['left', 'top', 'width']) p.style.removeProperty(k);
  p.classList.add('sheet'); p.classList.remove('up'); scrim.hidden = false; p.hidden = false;
  mount(p, html`<div class="pv-load"><i></i><i></i><i></i></div>`); requestAnimationFrame(() => { p.classList.add('on'); scrim.classList.add('on'); });
  try { if (!cache.has(id)) cache.set(id, await api('/models/' + mid(id) + '/preview')); }
  catch (e) { if (my === seq) mount(p, html`<p class="pv-line">Preview not available. Open the model for details.</p><button type="button" class="pv-x">Close</button>`); return wireClose(p); }
  if (my !== seq) return;
  mount(p, html`<span class="pv-grab" aria-hidden="true"></span>${card(cache.get(id))}<button type="button" class="pv-x">Close</button>`);
  p.querySelectorAll('.pv-bar i').forEach(i => i.style.setProperty('--v', i.dataset.v + '%')); wireClose(p);
}
const wireClose = p => { const x = p.querySelector('.pv-x'); if (x) x.onclick = closeSheet; };
function closeSheet() {
  seq++; if (scrim) { scrim.classList.remove('on'); scrim.hidden = true; }
  if (pv && pv.classList.contains('sheet')) { pv.classList.remove('on', 'sheet'); pv.hidden = true; }
}

export function initPreview() {
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-ql]'); if (b) { e.preventDefault(); sheet(b.dataset.ql); } });
  addEventListener('hashchange', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
  const near = e => (e.target.closest ? e.target.closest(TRIGGER) : null);
  document.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const a = near(e); if (!a || a === openFor) return;
    clearTimeout(tOpen); clearTimeout(tClose); tOpen = setTimeout(() => show(a), openFor ? 60 : 320);
  });
  document.addEventListener('pointerout', e => {
    if (e.pointerType !== 'mouse') return;
    const a = near(e); if (!a) return;
    if (e.relatedTarget && (a.contains(e.relatedTarget) || (pv && pv.contains(e.relatedTarget)))) return;
    hide(180);
  });
  document.addEventListener('focusin', e => { const a = near(e); if (a && e.target.matches(':focus-visible')) show(a); });
  document.addEventListener('focusout', e => { if (near(e) && !(pv && pv.contains(e.relatedTarget))) hide(120); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(0); });
  addEventListener('hashchange', () => hide(0));
  addEventListener('scroll', () => { if (openFor) hide(0); }, { passive: true });
}
