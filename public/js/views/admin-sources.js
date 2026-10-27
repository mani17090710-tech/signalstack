// Admin, Sources: every place SignalStack reads from, which ones work, and the controls to pause, refresh, add and remove them.
import { api, html, pageHead, $, mount, ago, stamp, safeUrl } from '../lib.js';
import { toast } from '../saved.js';

export const adminTabs = on => html`<nav class="atabs" aria-label="Admin sections"><a href="#admin" class="${on === 'overview' ? 'on' : ''}">Overview</a><a href="#admin/signals" class="${on === 'signals' ? 'on' : ''}">Signals</a><a href="#admin/sources" class="${on === 'sources' ? 'on' : ''}">Sources</a></nav>`;

const STATE = { healthy: 'Working', failing: 'Failing', stale: 'Not run recently', warning: 'Working, with warnings', new: 'Not run yet', paused: 'Paused' };
const NEEDS = ['failing', 'stale', 'warning'];
const TYPES = [['huggingface', 'Hugging Face account'], ['github', 'GitHub repository'], ['feed', 'Blog or RSS feed']];

const hist = s => html`<span class="hist" role="img" aria-label="Last ${s.history.length} runs, oldest first">${s.history.slice().reverse().map(h => html`<i class="h-${h.status}" title="${stamp(h.ts)}: ${h.status}. ${h.message}"></i>`)}${s.history.length ? '' : html`<em>No runs recorded in the last 14 days</em>`}</span>`;

const row = (s, open, busy) => html`<article class="srow st-${s.state}" data-id="${s.id}">
  <div class="sr-head"><span class="dot" aria-hidden="true"></span><div class="sr-title"><b>${s.label}</b><span class="srcb">${s.kind_label}</span>${s.builtin ? '' : html`<span class="tag">Added by you</span>`}${s.tier === 'primary' ? html`<span class="tag">Official</span>` : ''}</div><span class="sr-state">${STATE[s.state]}</span></div>
  <p class="sr-watch">${safeUrl(s.watch_url) ? html`<a href="${s.watch_url}" target="_blank" rel="noopener noreferrer">${s.watch} <span aria-hidden="true">↗</span></a>` : s.watch}</p>
  <p class="sr-meta">${s.last_run ? `Last run ${ago(s.last_run)}` : 'Never run'}${s.last_ok ? ` · last success ${ago(s.last_ok)}` : ''}${s.failures > 1 ? ` · ${s.failures} failures in a row` : ''}</p>
  ${s.last_error && (s.state === 'failing' || s.state === 'warning') ? html`<p class="sr-err" role="status">${s.last_error}</p>` : ''}
  ${hist(s)}
  <div class="sr-act"><button class="mini" data-do="toggle" ${busy ? 'disabled' : ''}>${s.enabled ? 'Pause' : 'Resume'}</button><button class="mini" data-do="refresh" ${busy ? 'disabled' : ''}>${busy ? 'Refreshing…' : 'Refresh now'}</button><button class="mini" data-do="more" aria-expanded="${open}">${open ? 'Hide history' : 'History'}</button>${s.builtin ? '' : html`<button class="mini danger" data-do="remove" ${busy ? 'disabled' : ''}>Remove</button>`}</div>
  ${open ? html`<div class="sr-log"><table><tr><th>Time</th><th>Result</th><th>What happened</th></tr>${s.history.map(h => html`<tr><td>${stamp(h.ts)}</td><td class="${h.status === 'error' ? 'bad' : h.status === 'warning' ? 'warn-t' : 'ok'}">${h.status}</td><td>${h.message}</td></tr>`)}${s.history.length ? '' : html`<tr><td colspan="3" class="na">Nothing recorded. The log keeps 14 days.</td></tr>`}</table></div>` : ''}
</article>`;

export async function render() {
  let d = await api('/admin/sources'), companies = [];
  const f = { q: '', view: 'all', kind: '' }, open = new Set(), busy = new Set();
  let tested = null; // { key, ok } for the add form, so Add is only offered for something that was checked
  return {
    title: 'Admin: Sources',
    html: html`${adminTabs('sources')}${pageHead('Sources', 'Every place SignalStack reads from. Pause or fix what is failing and add what is missing. Clean sources mean clean data.')}
      <div id="ssum"></div>
      <div class="toolbar tb-main"><input id="sq" type="search" placeholder="Search sources" aria-label="Search sources"><select id="sk" aria-label="Type"><option value="">All types</option>${TYPES.concat([['arxiv', 'arXiv'], ['openrouter', 'OpenRouter']]).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select><button class="pri" id="sadd" aria-expanded="false" aria-controls="sform">Add a source</button></div>
      <section class="panel addsrc" id="sform" hidden>
        <h2>Add a source</h2>
        <div class="seg" id="stype" role="radiogroup" aria-label="Source type">${TYPES.map(([k, l], i) => html`<button role="radio" aria-checked="${i === 0}" class="${i === 0 ? 'on' : ''}" data-t="${k}">${l}</button>`)}</div>
        <div class="af" id="afields"></div>
        <div class="tags mt"><button id="stest">Test it</button><button class="pri" id="sgo" disabled>Add source</button></div>
        <div id="sres" aria-live="polite"></div>
        <p class="fine">Testing reads the address once and shows what it found. Nothing is saved until you add it.</p>
      </section>
      <div id="slist"></div>`,
    async after(root) {
      const again = async () => { d = await api('/admin/sources'); draw(); };
      const matches = s => (!f.q || (s.label + ' ' + s.watch + ' ' + s.id).toLowerCase().includes(f.q.toLowerCase())) && (!f.kind || s.kind === f.kind || (f.kind === 'arxiv' && s.kind === 'arxiv_cited'))
        && (f.view === 'all' || (f.view === 'attention' ? NEEDS.includes(s.state) : f.view === 'new' ? s.state === 'new' : s.state === f.view));
      const draw = () => {
        const m = d.summary, att = m.failing + m.stale + m.warning, tile = (v, n, l, cls) => html`<button class="stile ${cls} ${f.view === v ? 'on' : ''}" data-view="${v}"><b>${n}</b><span>${l}</span></button>`;
        mount($('#ssum', root), html`<div class="stiles">${tile('all', m.total, 'All sources', '')}${tile('healthy', m.healthy, 'Working', 'ok')}${tile('attention', att, 'Need attention', att ? 'bad' : '')}${tile('paused', m.paused, 'Paused', '')}${tile('new', m.new, 'Not run yet', '')}</div>
          <p class="sfoot">${m.running ? 'A full run is in progress. ' : ''}${m.lastRun ? `Last run ${ago(m.lastRun)}` : 'No run yet'} · the site reads every source about every ${m.intervalMin} minutes. <button class="link" id="runall" ${m.running ? 'disabled' : ''}>Run everything now</button></p>`);
        const list = d.sources.filter(matches);
        mount($('#slist', root), list.length ? html`<div class="srows">${list.map(s => row(s, open.has(s.id), busy.has(s.id)))}</div>` : html`<div class="empty"><h3>No sources match</h3><p>${f.view === 'attention' ? 'Nothing needs attention right now.' : 'Try another filter.'}</p></div>`);
      };
      // ----- add form -----
      let type = 'huggingface';
      const fields = () => {
        const co = html`<label>Lab (optional)<select id="fco"><option value="">None, or not a lab</option>${companies.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></label>`;
        const tier = html`<label>How far to trust it<select id="ftier"><option value="community">Community: anyone can publish there</option><option value="primary">Official: straight from the lab</option></select></label><p class="fine">Only choose Official for the lab’s own account or site. Items from it will show as Source Verified.</p>`;
        mount($('#afields', root), type === 'huggingface' ? html`<label>Hugging Face user or organisation<input id="fin" placeholder="Qwen" autocomplete="off"></label>${co}${tier}`
          : type === 'github' ? html`<label>Repository<input id="fin" placeholder="owner/name or a github.com link" autocomplete="off"></label>${co}${tier}`
          : html`<label>Feed address<input id="fin" placeholder="https://example.com/blog/rss.xml" autocomplete="off"></label><label>Name<input id="fname" placeholder="Example Lab, blog"></label>${co}${tier}`);
      };
      const body = () => ({ kind: type, ...(type === 'huggingface' ? { author: $('#fin', root).value } : type === 'github' ? { repo: $('#fin', root).value } : { url: $('#fin', root).value, label: $('#fname', root).value }), company: $('#fco', root).value, tier: $('#ftier', root).value });
      const key = () => JSON.stringify(body());
      const stale = () => { tested = null; $('#sgo', root).disabled = true; };
      // ----- events -----
      let t; $('#sq', root).oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); draw(); }, 150); };
      $('#sk', root).onchange = e => { f.kind = e.target.value; draw(); };
      root.addEventListener('input', e => { if (e.target.closest('#afields')) { stale(); mount($('#sres', root), html``); } });
      root.addEventListener('change', e => { if (e.target.closest('#afields')) { stale(); mount($('#sres', root), html``); } });
      root.addEventListener('click', async e => {
        const v = e.target.closest('[data-view]'); if (v) { f.view = f.view === v.dataset.view && v.dataset.view !== 'all' ? 'all' : v.dataset.view; draw(); return; }
        const ty = e.target.closest('[data-t]'); if (ty) { type = ty.dataset.t; root.querySelectorAll('#stype button').forEach(b => { b.classList.toggle('on', b === ty); b.setAttribute('aria-checked', String(b === ty)); }); fields(); stale(); mount($('#sres', root), html``); return; }
        if (e.target.closest('#sadd')) { const p = $('#sform', root), o = p.hidden; p.hidden = !o; $('#sadd', root).setAttribute('aria-expanded', String(o)); if (o) { if (!companies.length) api('/companies').then(c => { companies = c; fields(); }).catch(() => {}); fields(); $('#fin', root).focus(); } return; }
        if (e.target.id === 'runall') { e.target.disabled = true; try { await api('/admin/ingest/run', 'POST'); toast('Started. Sources update as they finish.'); setTimeout(again, 5000); setTimeout(again, 20000); } catch (x) { toast(x.message); } return; }
        if (e.target.id === 'stest') {
          const b = e.target; b.disabled = true; b.textContent = 'Testing…'; const res = $('#sres', root), k = key();
          try {
            const r = await api('/admin/sources/test', 'POST', body());
            tested = r.ok ? { key: k } : null; $('#sgo', root).disabled = !r.ok;
            mount(res, r.ok ? html`<p class="note ok-n"><b>Looks good: ${r.label}.</b> Found ${r.found} item${r.found === 1 ? '' : 's'}${r.sample.length ? '. Latest: ' + r.sample.join('; ') : ''}.${r.note ? ' ' + r.note : ''}</p>` : html`<p class="warn">Could not read it: ${r.error}</p>`);
          } catch (x) { mount(res, html`<p class="warn">${x.message}</p>`); }
          b.disabled = false; b.textContent = 'Test it'; return;
        }
        if (e.target.id === 'sgo') {
          if (!tested || tested.key !== key()) { mount($('#sres', root), html`<p class="warn">Test it first.</p>`); return; }
          const b = e.target; b.disabled = true; b.textContent = 'Adding…';
          try {
            const r = await api('/admin/sources/add', 'POST', body());
            toast(r.result.status === 'error' ? 'Added, but the first read failed: ' + r.result.message : 'Added. ' + r.result.message);
            $('#sform', root).hidden = true; $('#sadd', root).setAttribute('aria-expanded', 'false'); tested = null; mount($('#sres', root), html``); await again();
          } catch (x) { mount($('#sres', root), html`<p class="warn">${x.message}</p>`); }
          b.textContent = 'Add source'; return;
        }
        const btn = e.target.closest('[data-do]'); if (!btn) return;
        const card = btn.closest('[data-id]'), id = card.dataset.id, s = d.sources.find(x => x.id === id), act = btn.dataset.do;
        if (act === 'more') { open.has(id) ? open.delete(id) : open.add(id); draw(); return; }
        if (act === 'toggle') { try { await api('/admin/sources/toggle', 'POST', { id, enabled: !s.enabled }); toast(s.enabled ? 'Paused. It will not be read until you resume it.' : 'Resumed.'); await again(); } catch (x) { toast(x.message); } return; }
        if (act === 'remove') { if (!confirm(`Remove "${s.label}"? Items it already collected stay on the site.`)) return; try { await api('/admin/sources/remove', 'POST', { id }); toast('Removed.'); await again(); } catch (x) { toast(x.message); } return; }
        if (act === 'refresh') {
          busy.add(id); draw();
          try { const r = await api('/admin/sources/refresh', 'POST', { id }); toast(`${s.label}: ${r.result.message}`); } catch (x) { toast(x.message); }
          busy.delete(id); await again();
        }
      });
      draw();
    },
  };
}
