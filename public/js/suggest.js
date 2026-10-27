// Instant search suggestions under the header search box. Typing shows the best few models, labs and papers; Enter (or "See all results")
// opens the full results page. Arrow keys move through the list, Esc closes it. Nothing here navigates until the person chooses.
import { api, html, mount, mid, shortName, safeUrl, host } from './lib.js';

let box, input, items = [], at = -1, seq = 0, timer;
const MIN = 2;

// Recent searches live only in this browser. Newest first, no duplicates, at most 6.
const RK = 'ss_recent';
export const recents = () => { try { const a = JSON.parse(localStorage.getItem(RK)); return Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(0, 6) : []; } catch (e) { return []; } };
export const forgetOne = q => { try { localStorage.setItem(RK, JSON.stringify(recents().filter(x => x.toLowerCase() !== String(q).trim().toLowerCase()))); } catch (e) { /* storage unavailable */ } };
export const remember = q => { q = String(q || '').trim().slice(0, 80); if (q.length < MIN) return; try { localStorage.setItem(RK, JSON.stringify([q, ...recents().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 6))); } catch (e) { /* storage unavailable */ } };
const forget = () => { try { localStorage.removeItem(RK); } catch (e) { /* storage unavailable */ } };
// Real labs to suggest: the ones with the most models stored. Saved copy is used while the server wakes up.
export const topLabs = async n => { try { const c = await api('/companies'); return (Array.isArray(c) ? c : []).slice().sort((a, b) => (b.models || 0) - (a.models || 0)).slice(0, n); } catch (e) { return []; } };
const labChips = labs => labs.map(c => html`<a class="sg-chip" role="option" href="#search/${encodeURIComponent(c.name)}">${c.name}</a>`);

// Shown when the box is focused and empty: recent searches, then labs worth trying.
async function paintStart() {
  const my = ++seq, rec = recents(), labs = await topLabs(5);
  if (my !== seq || input.value.trim().length >= MIN) return;
  if (!rec.length && !labs.length) { close(); return; }
  mount(box, html`${rec.length ? html`<div class="sg-h">Recent searches <button type="button" class="sg-clear" data-clear-recent>Clear</button></div>${rec.map(q => html`<a role="option" class="sg-item" href="#search/${encodeURIComponent(q)}"><span class="sg-kind">Recent</span><span class="sg-t">${q}</span></a>`)}` : ''}
    ${labs.length ? html`<div class="sg-h">Try a lab</div><div class="sg-chips">${labChips(labs)}</div>` : ''}
    <p class="sg-tip">Search models, papers, labs and arXiv IDs. Press <kbd>/</kbd> anywhere to jump here.</p>`);
  box.hidden = false; input.setAttribute('aria-expanded', 'true'); at = -1;
}

function close() { if (box) box.hidden = true; at = -1; input.setAttribute('aria-expanded', 'false'); }
function mark(i) {
  at = i; [...box.querySelectorAll('[role=option]')].forEach((el, k) => { el.classList.toggle('on', k === i); el.setAttribute('aria-selected', String(k === i)); if (k === i) el.scrollIntoView({ block: 'nearest' }); });
}
const opt = (href, kind, title, sub, ext) => html`<a role="option" class="sg-item" href="${href}" ${ext ? html`target="_blank" rel="noopener noreferrer"` : ''}><span class="sg-kind">${kind}</span><span class="sg-t">${title}</span><span class="sg-s">${sub}</span></a>`;

function paint(r, q) {
  const parts = [];
  const sec = (label, list, row) => { if (list && list.length) parts.push(html`<div class="sg-h">${label}</div>`, ...list.map(row)); };
  sec('Models', r.models.slice(0, 4), m => opt('#model/' + mid(m.id), 'Model', shortName(m.id).split('/').pop(), m.company || m.creator || '', false));
  sec('Labs', r.companies.slice(0, 2), c => opt('#company/' + c.id, 'Lab', c.name, c.models + ' model' + (c.models === 1 ? '' : 's'), false));
  sec('Papers', r.papers.slice(0, 3), p => opt(safeUrl(p.url) || '#research', 'Paper', p.title, 'arXiv ' + p.arxiv_id, !!safeUrl(p.url)));
  const found = parts.length > 0;
  mount(box, html`${found ? parts : html`<p class="sg-none">No quick matches for “${q}”. Check the spelling, or try a shorter word.</p>`}<a role="option" class="sg-all" href="#search/${encodeURIComponent(q)}">See all results for “${q}” <span aria-hidden="true">→</span></a>`);
  box.hidden = false; input.setAttribute('aria-expanded', 'true'); at = -1;
}

async function run(q) {
  const my = ++seq;
  try { const r = await api('/search?q=' + encodeURIComponent(q)); if (my === seq && input.value.trim() === q) paint(r, q); }
  catch (e) { if (my === seq) { mount(box, html`<p class="sg-none">Search is slow to answer. Press Enter to try the full search.</p>`); box.hidden = false; } }
}

export function initSuggest(inp, form) {
  input = inp; box = document.createElement('div'); box.id = 'sg'; box.className = 'sg'; box.hidden = true; box.setAttribute('role', 'listbox'); box.setAttribute('aria-label', 'Search suggestions');
  form.append(box); input.setAttribute('role', 'combobox'); input.setAttribute('aria-controls', 'sg'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-autocomplete', 'list');
  input.addEventListener('input', () => { clearTimeout(timer); const q = input.value.trim(); if (q.length < MIN) { seq++; paintStart(); return; } timer = setTimeout(() => run(q), 180); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= MIN) { if (box.childElementCount) box.hidden = false; } else paintStart(); });
  // "/" jumps to search from anywhere, unless you are already typing in a field.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = t && t.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    e.preventDefault(); document.getElementById('sopen') && getComputedStyle(document.getElementById('sopen')).display !== 'none' ? document.getElementById('sopen').click() : (input.focus(), input.select());
  });
  input.addEventListener('keydown', e => {
    const list = [...box.querySelectorAll('[role=option]')];
    if (e.key === 'Escape') { close(); return; }
    if (box.hidden || !list.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mark((at + 1) % list.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark((at - 1 + list.length) % list.length); }
    else if (e.key === 'Enter' && at >= 0) { e.preventDefault(); const a = list[at]; close(); a.click(); }
  });
  form.addEventListener('submit', () => { clearTimeout(timer); seq++; close(); });
  box.addEventListener('click', e => {
    if (e.target.closest('[data-clear-recent]')) { forget(); paintStart(); return; }
    const all = e.target.closest('.sg-all'); if (all) remember(input.value);
    if (e.target.closest('a')) close();
  });
  document.addEventListener('pointerdown', e => { if (!form.contains(e.target)) close(); });
  addEventListener('hashchange', close);
}
