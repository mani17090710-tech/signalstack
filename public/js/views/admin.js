// Admin: source health, review queue, users, test email.
import { api, html, pageHead, $, mount, ago } from '../lib.js';

export async function render() {
  const [s, log, pend, users] = await Promise.all([api('/admin/summary'), api('/admin/log'), api('/admin/pending'), api('/admin/users')]);
  const reviewList = (kind, items, label) => html`<div class="panel"><h3>${label} (${items.length})</h3>${items.length ? html`<p class="tags mt"><button class="mini" data-bulk="${kind}" data-bulkact="approve">Approve all</button><button class="mini" data-bulk="${kind}" data-bulkact="reject">Reject all</button></p>` : ''}
    <div class="rows">${items.map(i => html`<div>${i.name || i.title}<p class="tags"><button class="mini" data-rev="${i.id}" data-type="${kind}" data-act="approve">Approve</button><button class="mini" data-rev="${i.id}" data-type="${kind}" data-act="reject">Reject</button></p></div>`)}${items.length ? '' : html`<div class="na">Nothing pending.</div>`}</div></div>`;
  return {
    title: 'Admin',
    html: html`${pageHead('Admin', 'Source health, review queue and users.')}
      <p class="snapshot">${[['Users', s.users], ['Models', s.models], ['Papers', s.papers], ['Signals', s.events], ['Pending review', s.pendingModels + s.pendingPapers], ['Emails sent', s.emailsSent], ['Emails failed', s.emailsFailed]].map(([l, n]) => html`<span><b>${n}</b>${l}</span>`)}</p>
      ${s.emailConfigured ? '' : html`<p class="warn mt">Email is not set up. Add RESEND_API_KEY to the environment to enable email alerts.</p>`}
      <section class="blk"><header><h2>Test email</h2></header><div class="toolbar"><input id="temail" type="email" placeholder="Send a test email to" aria-label="Test email address"><button id="tsend">Send test email</button></div><div id="tresult"></div></section>
      <section class="blk"><header><h2>Monitored sources</h2><button id="runnow">Run ingestion now</button></header>
        <div class="panel rows">${s.sources.map(x => html`<div><b>${x.label}</b><p class="meta">${x.kind}, last run ${x.last_run ? ago(x.last_run) : 'never'}, <span class="${x.last_status === 'error' ? 'bad' : x.last_status === 'warning' ? 'warn-t' : 'ok'}">${x.last_status || 'not run yet'}</span>${x.last_error ? ' ' + x.last_error : ''}</p><button class="mini" data-src="${x.id}" data-on="${x.enabled ? '0' : '1'}">${x.enabled ? 'Disable' : 'Enable'}</button></div>`)}</div></section>
      <section class="blk"><header><h2>Review queue</h2></header><div class="two">${reviewList('model', pend.models, 'Models')}${reviewList('paper', pend.papers, 'Papers')}</div><p class="fine">Items only wait here when REQUIRE_REVIEW is set to true.</p></section>
      <section class="blk"><header><h2>Ingestion log</h2></header><div class="tw"><table><tr><th>Time</th><th>Source</th><th>Status</th><th>Message</th></tr>${log.map(l => html`<tr><td>${l.ts.replace('T', ' ').slice(0, 16)}</td><td>${l.source_id}</td><td class="${l.status === 'error' ? 'bad' : 'ok'}">${l.status}</td><td>${l.message}</td></tr>`)}${log.length ? '' : html`<tr><td colspan="4" class="na">No runs yet.</td></tr>`}</table></div></section>
      <section class="blk"><header><h2>Users</h2></header><div class="panel rows">${users.map(u => html`<div>${u.email} ${u.role === 'admin' ? html`<span class="tag">admin</span>` : ''} <button class="mini" data-id="${u.id}" data-role="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? 'Demote' : 'Make admin'}</button></div>`)}</div></section>`,
    after(root) {
      const again = () => dispatchEvent(new HashChangeEvent('hashchange'));
      root.addEventListener('click', async e => {
        const t = e.target.closest('button'); if (!t) return;
        if (t.dataset.rev) { await api('/admin/review', 'POST', { type: t.dataset.type, id: t.dataset.rev, action: t.dataset.act }); again(); }
        if (t.dataset.bulk) { if (t.dataset.bulkact === 'reject' && !confirm('Permanently delete all pending ' + t.dataset.bulk + 's?')) return; await api('/admin/review/bulk', 'POST', { type: t.dataset.bulk, action: t.dataset.bulkact }); again(); }
        if (t.dataset.src) { await api('/admin/sources', 'POST', { id: t.dataset.src, enabled: t.dataset.on === '1' }); again(); }
        if (t.dataset.role) { await api('/admin/users/role', 'POST', { id: +t.dataset.id, role: t.dataset.role }); again(); }
        if (t.id === 'runnow') { t.textContent = 'Running'; t.disabled = true; await api('/admin/ingest/run', 'POST'); setTimeout(again, 4000); }
        if (t.id === 'tsend') {
          const to = $('#temail', root).value; if (!to) return; t.disabled = true;
          try { await api('/admin/test-email', 'POST', { to }); mount($('#tresult', root), html`<p class="note">Sent. Check ${to}, including spam.</p>`); } catch (x) { mount($('#tresult', root), html`<p class="warn">Failed: ${x.message}</p>`); }
          t.disabled = false;
        }
      });
    },
  };
}
