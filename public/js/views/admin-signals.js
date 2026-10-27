// Admin, Signals: a plain table of what is on the site, with the controls to fix it.
import { api, html, pageHead, $, mount, ago, stamp, safeUrl, signalType, sourceInfo, CAT_LABEL } from '../lib.js';
import { toast } from '../saved.js';
import { adminTabs } from './admin-sources.js';

const CATS = [['Model Release', 'New model'], ['Trending', 'Trending'], ['Announcement', 'Announcement'], ['Open Source', 'Software release'], ['Research', 'Research']];
const PAGE = 40;

const row = (s, openNote) => html`<article class="mrow ${s.hidden ? 'is-hidden' : ''}" data-id="${s.id}">
  <div class="m-score"><label class="sr" for="sc${s.id}">Score for ${s.title}</label><input id="sc${s.id}" class="m-in" type="number" min="0" max="100" step="1" value="${s.score}" data-score inputmode="numeric">
    <span class="imp imp-${s.importance}">${s.importance}</span>${s.score_edited ? html`<small>calculated ${s.calculated}</small>` : ''}</div>
  <div class="m-main"><h3>${safeUrl(s.url) ? html`<a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</h3>
    <p class="m-meta"><span class="sc-type">${signalType(s)}</span><span class="srcb">${sourceInfo(s)[1]}</span><span>${s.company || 'No lab'}</span><time title="${stamp(s.ts)}">${ago(s.ts)}</time>
      ${s.hidden ? html`<span class="mchip bad">Hidden</span>` : ''}${s.manual ? html`<span class="mchip">Added by hand</span>` : ''}${s.score_edited ? html`<span class="mchip">Score edited</span>` : ''}${s.matters_edited ? html`<span class="mchip">Note edited</span>` : ''}</p>
    ${s.matters ? html`<p class="m-note"><b>Why this matters:</b> ${s.matters}</p>` : ''}
    ${s.edited.by ? html`<p class="fine">Last changed by ${s.edited.by}, ${ago(s.edited.at)}</p>` : ''}</div>
  <div class="m-act"><button class="mini" data-do="major" ${s.score >= 80 ? 'disabled' : ''} title="Sets the score to 85 so it counts as Major">${s.score >= 80 ? 'Major ✓' : 'Mark Major'}</button>
    <button class="mini" data-do="note" aria-expanded="${openNote}">Edit note</button>
    <button class="mini ${s.hidden ? '' : 'danger'}" data-do="hide">${s.hidden ? 'Show again' : 'Hide'}</button>
    ${s.edited.by || s.hidden ? html`<button class="mini" data-do="reset" title="Remove every change and go back to the automatic values">Reset</button>` : ''}</div>
  ${openNote ? html`<div class="m-edit"><label for="nt${s.id}">Why this matters (up to 400 characters, shown on the card)</label><textarea id="nt${s.id}" maxlength="400" rows="3">${s.matters || ''}</textarea>
    <p class="fine">${(s.matters_auto || (!s.matters_edited && s.matters)) ? 'Automatic note: ' + (s.matters_auto || s.matters) : 'The automatic rules have no note for this signal.'}</p>
    <div class="tags"><button class="pri mini" data-do="savenote">Save note</button><button class="mini" data-do="nonote">Show no note</button><button class="mini" data-do="autonote">Use automatic</button><button class="mini" data-do="note">Cancel</button></div></div>` : ''}
</article>`;

export async function render() {
  const f = { q: '', window: '7d', filter: 'all', cat: '' }, openNote = new Set(); let items = [], total = 0, companies = [], token = 0;
  return {
    title: 'Admin: Signals',
    html: html`${adminTabs('signals')}${pageHead('Signals', 'What is on the site right now. Change a score, mark something Major, hide a bad signal, fix a note, or add one the crawler missed.')}
      <div class="toolbar tb-main"><input id="mq" type="search" placeholder="Search title or link" aria-label="Search signals">
        <select id="mw" aria-label="Time">${[['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']].map(([k, l]) => html`<option value="${k}" ${k === f.window ? 'selected' : ''}>${l}</option>`)}</select>
        <select id="mc" aria-label="Type"><option value="">All types</option>${CATS.map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
        <button class="pri" id="madd" aria-expanded="false" aria-controls="mform">Add a signal</button></div>
      <div class="seg" id="mf" role="group" aria-label="Show">${[['all', 'All'], ['hidden', 'Hidden'], ['edited', 'Edited'], ['manual', 'Added by hand']].map(([k, l]) => html`<button class="${k === 'all' ? 'on' : ''}" data-f="${k}">${l}</button>`)}</div>
      <section class="panel addsrc" id="mform" hidden>
        <h2>Add a signal the crawler missed</h2>
        <div class="af"><label>Title<input id="ft" maxlength="200" placeholder="What happened, in one line"></label>
          <label>Link to the original source<input id="fu" placeholder="https://"></label>
          <label>Type<select id="fc">${CATS.map(([k, l]) => html`<option value="${k}" ${k === 'Announcement' ? 'selected' : ''}>${l}</option>`)}</select></label>
          <label>Lab (optional)<select id="fl"><option value="">None, or not a lab</option></select></label>
          <label>Published (optional, today if empty)<input id="fd" type="date"></label>
          <label>Summary (optional)<textarea id="fs" rows="2" maxlength="600"></textarea></label>
          <label>Why this matters (optional)<textarea id="fm" rows="2" maxlength="400"></textarea></label>
          <label>Score (optional, calculated if empty)<input id="fx" type="number" min="0" max="100" inputmode="numeric"></label></div>
        <p class="fine">The source label is set from the link, not typed: it shows as Source Verified only when the link is on the lab’s own website, and otherwise as found elsewhere. Anyone reading the card sees where it came from.</p>
        <div class="tags"><button class="pri" id="mgo">Add signal</button></div><div id="mres" aria-live="polite"></div>
      </section>
      <p class="checked" id="mcount" aria-live="polite"></p><div id="mlist"></div><p class="more"><button id="mmore" hidden>Load more</button></p>`,
    async after(root) {
      const draw = () => {
        mount($('#mlist', root), items.length ? html`<div class="mrows">${items.map(s => row(s, openNote.has(s.id)))}</div>` : html`<div class="empty"><h3>No signals match</h3><p>Try a wider time range or another filter.</p></div>`);
        $('#mcount', root).textContent = total ? `Showing ${items.length.toLocaleString()} of ${total.toLocaleString()} signals` : '';
        $('#mmore', root).hidden = items.length >= total;
      };
      const q = off => new URLSearchParams({ limit: PAGE, offset: off, window: f.window, filter: f.filter, ...(f.cat && { cat: f.cat }), ...(f.q && { q: f.q }) });
      const load = async more => {
        const my = ++token; if (!more) mount($('#mlist', root), html`<p class="checked">Loading…</p>`);
        try { const d = await api('/admin/signals?' + q(more ? items.length : 0)); if (my !== token) return; total = d.total; items = more ? items.concat(d.items) : d.items; draw(); }
        catch (e) { if (my === token) mount($('#mlist', root), html`<div class="empty"><h3>Couldn’t load signals</h3><p>${e.message}</p></div>`); }
      };
      const put = s => { const i = items.findIndex(x => x.id === s.id); if (i >= 0) items[i] = s; draw(); };
      const change = async (id, body, msg) => { try { const r = await api('/admin/signals/update', 'POST', { id, ...body }); put(r.signal); toast(msg); if (f.filter !== 'all') load(); } catch (x) { toast(x.message); draw(); } };
      let t; $('#mq', root).oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 250); };
      $('#mw', root).onchange = e => { f.window = e.target.value; load(); }; $('#mc', root).onchange = e => { f.cat = e.target.value; load(); };
      root.addEventListener('change', e => {
        const inp = e.target.closest('[data-score]'); if (!inp) return; const id = +inp.closest('[data-id]').dataset.id, v = inp.value.trim();
        change(id, { score: v === '' ? null : +v }, v === '' ? 'Back to the calculated score.' : `Score set to ${v}.`);
      });
      root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-score]')) e.target.blur(); });
      root.addEventListener('click', async e => {
        const fb = e.target.closest('[data-f]'); if (fb) { f.filter = fb.dataset.f; root.querySelectorAll('#mf button').forEach(b => b.classList.toggle('on', b === fb)); load(); return; }
        if (e.target.id === 'mmore') { load(true); return; }
        if (e.target.closest('#madd')) { const p = $('#mform', root), o = p.hidden; p.hidden = !o; $('#madd', root).setAttribute('aria-expanded', String(o));
          if (o) { if (!companies.length) api('/companies').then(c => { companies = c; $('#fl', root).insertAdjacentHTML('beforeend', c.map(x => String(html`<option value="${x.id}">${x.name}</option>`)).join('')); }).catch(() => {}); $('#ft', root).focus(); } return; }
        if (e.target.id === 'mgo') {
          const b = e.target, v = id => $(id, root).value.trim(); b.disabled = true; b.textContent = 'Adding…';
          try {
            const r = await api('/admin/signals/add', 'POST', { title: v('#ft'), url: v('#fu'), cat: v('#fc'), company: v('#fl'), ts: v('#fd'), summary: v('#fs'), matters: v('#fm'), score: v('#fx') });
            toast(`Added. It shows as ${r.signal.verification_label}.`); ['#ft', '#fu', '#fd', '#fs', '#fm', '#fx'].forEach(id => { $(id, root).value = ''; }); mount($('#mres', root), html``); $('#mform', root).hidden = true; $('#madd', root).setAttribute('aria-expanded', 'false');
            if (f.window === '24h' || f.window === '7d' || f.window === '30d' || f.window === 'all') await load();
          } catch (x) { mount($('#mres', root), html`<p class="warn">${x.message}${x.message.includes('already a signal') ? '' : ''}</p>`); }
          b.disabled = false; b.textContent = 'Add signal'; return;
        }
        const btn = e.target.closest('[data-do]'); if (!btn) return; const card = btn.closest('[data-id]'), id = +card.dataset.id, s = items.find(x => x.id === id), act = btn.dataset.do;
        if (act === 'major') return change(id, { score: Math.max(85, s.score) }, 'Marked Major.');
        if (act === 'hide') return change(id, { hidden: !s.hidden }, s.hidden ? 'Visible again.' : 'Hidden. It is gone from the site, the API and the feed.');
        if (act === 'reset') { if (!confirm('Remove every change to this signal?')) return; return change(id, { reset: true }, 'Back to automatic.'); }
        if (act === 'note') { openNote.has(id) ? openNote.delete(id) : openNote.add(id); draw(); const ta = $('#nt' + id, root); if (ta) ta.focus(); return; }
        if (act === 'savenote') { const text = $('#nt' + id, root).value; openNote.delete(id); return change(id, { matters: text }, text.trim() ? 'Note saved.' : 'The note was removed.'); }
        if (act === 'nonote') { openNote.delete(id); return change(id, { matters: '' }, 'This signal will show no note.'); }
        if (act === 'autonote') { openNote.delete(id); return change(id, { matters: null }, 'Using the automatic note.'); }
      });
      load();
    },
  };
}
