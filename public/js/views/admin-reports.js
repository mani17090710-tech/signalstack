// Admin, Reports: messages sent from the Contact and Report an issue pages.
import { api, html, pageHead, $, mount, ago, stamp, empty } from '../lib.js';
import { adminTabs } from './admin-sources.js';

const KIND = { issue: 'Site issue', data: 'Wrong data', contact: 'Question', other: 'Other' };
const item = r => html`<article class="panel rep ${r.status === 'done' ? 'is-done' : ''}" data-id="${r.id}"><header><span class="mchip">${KIND[r.kind] || 'Other'}</span><time title="${stamp(r.ts)}">${ago(r.ts)}</time>${r.status === 'done' ? html`<span class="mchip">Done</span>` : ''}</header>
  <p class="rep-msg">${r.message}</p>
  ${r.page ? html`<p class="fine">About: ${r.page}</p>` : ''}${r.contact ? html`<p class="fine">Reply to: <a href="mailto:${r.contact}">${r.contact}</a></p>` : html`<p class="fine">No email left.</p>`}
  <button class="mini" data-st="${r.status === 'done' ? 'new' : 'done'}">${r.status === 'done' ? 'Reopen' : 'Mark done'}</button></article>`;

export async function render() {
  const d = await api('/admin/reports');
  return {
    title: 'Admin: Reports',
    html: html`${adminTabs('reports')}${pageHead('Reports', `Messages from the Contact and Report an issue pages. ${d.open} open.`)}<div id="replist">${d.items.length ? d.items.map(item) : empty('No messages yet', 'Anything people send from the Contact or Report an issue page shows up here.', '', 'signal')}</div>`,
    after(root) {
      root.onclick = async e => {
        const b = e.target.closest('[data-st]'); if (!b) return;
        const card = b.closest('[data-id]'); b.disabled = true;
        try { await api('/admin/reports/update', 'POST', { id: +card.dataset.id, status: b.dataset.st }); const o = await render(); mount($('#main'), o.html); o.after($('#main')); }
        catch (x) { b.disabled = false; alert(x.message); }
      };
    },
  };
}
