// Collections: save signals, models and papers for later and sort them into named lists. Saving works from any card; with several
// collections a small menu asks which ones. The #saved page manages them. Everything is per account.
import { api, html, mount, state, $, $$, pageHead, empty, safeUrl, host, mid, ago, stamp, shortName } from './lib.js';

let menu, menuFor = null;

export function applyState(r) { state.collections = r.collections; state.saved = new Set(r.saved); markSaved(); }
export function markSaved() {
  $$('[data-save]').forEach(b => { const on = state.saved.has(b.dataset.save); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.querySelector('span').textContent = on ? 'Saved' : 'Save'; b.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none'); });
}
export function toast(msg, href) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  mount(t, html`${msg}${href ? html` <a href="${href}">View</a>` : ''}`); t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 3200);
}
const split = v => { const i = v.indexOf('|'); return [v.slice(0, i), v.slice(i + 1)]; };

// Click on a Save button: one collection toggles directly; several open a menu.
export async function onSave(btn) {
  const [kind, ref] = split(btn.dataset.save);
  if (state.collections.length > 1) return openMenu(btn, kind, ref);
  btn.disabled = true;
  try {
    const on = state.saved.has(btn.dataset.save);
    applyState(await api('/saved', on ? 'DELETE' : 'POST', { kind, ref }));
    toast(on ? 'Removed from Saved' : 'Saved', on ? '' : '#saved');
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

async function openMenu(anchor, kind, ref) {
  closeMenu(); menuFor = anchor;
  menu = document.createElement('div'); menu.className = 'cmenu'; menu.setAttribute('role', 'menu'); document.body.append(menu);
  let inIds = []; try { inIds = (await api(`/saved/where?kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}`)).collections; } catch (e) { /* menu still works */ }
  const draw = () => mount(menu, html`<p class="cm-h">Save to</p>${state.collections.map(c => html`<button role="menuitemcheckbox" aria-checked="${inIds.includes(c.id)}" data-c="${c.id}" class="${inIds.includes(c.id) ? 'on' : ''}"><span class="cm-box" aria-hidden="true"></span>${c.name}</button>`)}
    <form class="cm-new"><input placeholder="New collection" maxlength="40" aria-label="New collection name"><button class="pri">Add</button></form>`);
  draw();
  const r = anchor.getBoundingClientRect(), w = Math.min(260, innerWidth - 16);
  menu.style.setProperty('width', w + 'px'); menu.style.setProperty('left', Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px');
  menu.style.setProperty('top', Math.min(innerHeight - menu.offsetHeight - 8, r.bottom + 6) + 'px');
  menu.onclick = async e => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const id = +b.dataset.c, on = inIds.includes(id);
    try { applyState(await api('/saved', on ? 'DELETE' : 'POST', { kind, ref, collection_id: id })); inIds = on ? inIds.filter(x => x !== id) : [...inIds, id]; draw(); } catch (x) { toast(x.message); }
  };
  menu.onsubmit = async e => {
    e.preventDefault(); const name = menu.querySelector('input').value.trim(); if (!name) return;
    try { applyState(await api('/collections', 'POST', { name })); const c = state.collections.find(x => x.name === name); if (c) { applyState(await api('/saved', 'POST', { kind, ref, collection_id: c.id })); inIds.push(c.id); } draw(); } catch (x) { toast(x.message); }
  };
}
function closeMenu() { if (menu) { menu.remove(); menu = null; menuFor = null; } }
export function initSaved() {
  document.addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target) && !(menuFor && menuFor.contains(e.target))) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  addEventListener('hashchange', closeMenu);
}

// ---- The Saved page ----
let cur = null;
export const view = {
  async render(arg) {
    const want = +arg || cur;
    const col = state.collections.find(c => c.id === want) || state.collections[0];
    if (!col) return { title: 'Saved', html: html`${pageHead('Saved', 'Things you saved for later.')}${empty('Nothing saved yet', 'Use Save on any signal, model or paper to keep it here.', html`<a class="btn-sec" href="#signals">Browse signals</a>`)}` };
    cur = col.id;
    const d = await api('/saved?collection=' + col.id), first = state.collections[0].id === col.id;
    const link = it => (it.kind === 'model' ? html`<a href="#model/${mid(it.ref)}">${it.title}</a>` : safeUrl(it.url) ? html`<a href="${it.url}" target="_blank" rel="noopener noreferrer">${it.title}</a>` : it.title);
    return {
      title: 'Saved',
      html: html`${pageHead('Saved', 'Your collections. Items keep their title and source link even if the original later disappears.')}
        <div class="toolbar tb-main"><div class="seg" role="tablist" aria-label="Collections">${state.collections.map(c => html`<button role="tab" data-col="${c.id}" class="${c.id === col.id ? 'on' : ''}">${c.name}<span class="n">${c.n}</span></button>`)}</div>
          <form id="newcol" class="inline"><input placeholder="New collection" maxlength="40" aria-label="New collection name"><button>Create</button></form></div>
        <div class="labact colbar"><button id="copycol" ${d.items.length ? '' : 'disabled'}>Copy as list</button><button id="rencol">Rename</button>${first ? '' : html`<button id="delcol" class="danger">Delete collection</button>`}</div>
        ${d.items.length ? html`<div class="rows-sig">${d.items.map(it => html`<article class="sig-row saved-row"><span class="res-ico" aria-hidden="true">${it.kind === 'paper' ? '▤' : it.kind === 'model' ? '◎' : '◈'}</span>
          <div class="sr-main"><h3>${link(it)}</h3><p class="sr-meta"><span class="sc-type">${it.kind}</span><span class="srcb">${it.source}</span><time title="${stamp(it.saved_at)}">saved ${ago(it.saved_at)}</time></p></div>
          <div class="saved-act">${state.collections.length > 1 ? html`<select data-move="${it.kind}|${it.ref}" aria-label="Move ${it.title} to another collection"><option value="">Move to…</option>${state.collections.filter(c => c.id !== col.id).map(c => html`<option value="${c.id}">${c.name}</option>`)}</select>` : ''}<button data-rm="${it.kind}|${it.ref}" aria-label="Remove ${it.title}">Remove</button></div></article>`)}</div>`
          : empty('This collection is empty', 'Use Save on any signal, model or paper and choose this collection.', html`<a class="btn-sec" href="#signals">Browse signals</a><a class="btn-sec" href="#models">Browse models</a>`)}`,
      after(root) {
        const go = id => { cur = id; location.hash = 'saved/' + id; if (location.hash === '#saved/' + id) dispatchEvent(new HashChangeEvent('hashchange')); };
        root.onclick = async e => {
          const t = e.target.closest('[data-col]'); if (t) return go(+t.dataset.col);
          const rm = e.target.closest('[data-rm]');
          if (rm) { const [kind, ref] = split(rm.dataset.rm); try { applyState(await api('/saved', 'DELETE', { kind, ref, collection_id: col.id })); toast('Removed'); go(col.id); } catch (x) { toast(x.message); } return; }
          if (e.target.id === 'copycol') {
            const text = `${col.name}\n\n` + d.items.map(it => `- ${it.title} (${it.source})${safeUrl(it.url) ? ' ' + it.url : ''}`).join('\n');
            try { await navigator.clipboard.writeText(text); toast('Copied the list'); } catch (x) { toast('Could not copy; select the items by hand'); } return;
          }
          if (e.target.id === 'rencol') { const name = prompt('Rename collection', col.name); if (name && name.trim()) try { applyState(await api('/collections/rename', 'POST', { id: col.id, name })); go(col.id); } catch (x) { toast(x.message); } return; }
          if (e.target.id === 'delcol') { if (confirm(`Delete “${col.name}” and the ${d.items.length} item${d.items.length === 1 ? '' : 's'} in it?`)) try { applyState(await api('/collections', 'DELETE', { id: col.id })); go(state.collections[0].id); } catch (x) { toast(x.message); } }
        };
        root.onchange = async e => {
          const m = e.target.closest('[data-move]'); if (!m || !m.value) return; const [kind, ref] = split(m.dataset.move);
          try { applyState(await api('/saved/move', 'POST', { kind, ref, from: col.id, to: +m.value })); toast('Moved'); go(col.id); } catch (x) { toast(x.message); }
        };
        $('#newcol', root).onsubmit = async e => { e.preventDefault(); const name = e.target.querySelector('input').value.trim(); if (!name) return; try { applyState(await api('/collections', 'POST', { name })); go(state.collections.find(c => c.name === name).id); } catch (x) { toast(x.message); } };
      },
    };
  },
};
