// Admin: source health, review queue, users, test email.
import { api, html, pageHead, $, mount, ago, stamp } from '../lib.js';
import * as sourcesView from './admin-sources.js';
import * as signalsView from './admin-signals.js';
import { adminTabs } from './admin-sources.js';

// The numbers at the top: what the public sees, how many sources work, and when a crawl last succeeded.
const tiles = s => {
  const h = s.sourceHealth, ok = h.healthy + h.warning, bad = h.failing + h.stale, active = h.total - h.paused;
  const t = (n, l, sub, href, cls = '') => html`<a class="otile ${cls}" href="${href}"><b>${n}</b><span>${l}</span>${sub ? html`<small>${sub}</small>` : ''}</a>`;
  return html`<div class="otiles">${t(s.live.models.toLocaleString(), 'Models', '', '#models')}${t(s.live.papers.toLocaleString(), 'Papers', '', '#research')}${t(s.live.signals24h.toLocaleString(), 'Signals, last 24 hours', '', '#admin/signals')}${t(s.live.signals7d.toLocaleString(), 'Signals, last 7 days', s.live.hidden ? `${s.live.hidden} hidden` : '', '#admin/signals')}
    ${t(ok, 'Sources healthy', `of ${active} active`, '#admin/sources', 'ok')}${t(bad, 'Sources failing', bad ? 'need attention' : 'none right now', '#admin/sources', bad ? 'bad' : '')}${t(s.lastCrawl ? ago(s.lastCrawl) : 'None yet', 'Last successful crawl', s.lastCrawl ? stamp(s.lastCrawl) : '', '#admin/sources')}</div>`;
};

export async function render(arg = '') {
  if (arg === 'sources') return sourcesView.render();
  if (arg === 'signals') return signalsView.render();
  const [s, log, pend, users] = await Promise.all([api('/admin/summary'), api('/admin/log'), api('/admin/pending'), api('/admin/users')]);
  const reviewList = (kind, items, label) => html`<div class="panel"><h3>${label} (${items.length})</h3>${items.length ? html`<p class="tags mt"><button class="mini" data-bulk="${kind}" data-bulkact="approve">Approve all</button><button class="mini" data-bulk="${kind}" data-bulkact="reject">Reject all</button></p>` : ''}
    <div class="rows">${items.map(i => html`<div>${i.name || i.title}<p class="tags"><button class="mini" data-rev="${i.id}" data-type="${kind}" data-act="approve">Approve</button><button class="mini" data-rev="${i.id}" data-type="${kind}" data-act="reject">Reject</button></p></div>`)}${items.length ? '' : html`<div class="na">Nothing pending.</div>`}</div></div>`;
  return {
    title: 'Admin',
    html: html`${adminTabs('overview')}${pageHead('Admin', 'The numbers that matter, then source health, review queue and users.')}
      ${tiles(s)}
          <section class="blk">
        <header><h2>Database backup</h2></header>
        <p class="fine">Download a copy of your SignalStack database.</p>
        <button id="backup">Download database backup</button>
        <p id="backup-result" class="fine"></p>
      </section>
      <p class="snapshot">${[['Users', s.users], ['Models', s.models], ['Papers', s.papers], ['Signals', s.events], ['Pending review', s.pendingModels + s.pendingPapers], ['Emails sent', s.emailsSent], ['Emails failed', s.emailsFailed]].map(([l, n]) => html`<span><b>${n}</b>${l}</span>`)}</p>
      ${s.emailConfigured ? '' : html`<p class="warn mt">Email is not set up. Add RESEND_API_KEY to the environment to enable email alerts.</p>`}
      <section class="blk"><header><h2>Test email</h2></header><div class="toolbar"><input id="temail" type="email" placeholder="Send a test email to" aria-label="Test email address"><button id="tsend">Send test email</button></div><div id="tresult"></div></section>
      <section class="blk"><header><h2>Sources</h2><a class="btn-sec" href="#admin/sources">Manage sources</a></header>
        <div class="panel"><p class="snapshot">${[['Sources', s.sources.length], ['Working', s.sources.filter(x => x.enabled && x.last_status !== 'error' && x.last_run).length], ['Failing', s.sources.filter(x => x.enabled && x.last_status === 'error').length], ['Paused', s.sources.filter(x => !x.enabled).length]].map(([l, n]) => html`<span><b>${n}</b>${l}</span>`)}</p>
          ${s.sources.some(x => x.enabled && x.last_status === 'error') ? html`<p class="warn mt">${s.sources.filter(x => x.enabled && x.last_status === 'error').length} source(s) failed on their last run. <a href="#admin/sources">See which</a>.</p>` : html`<p class="fine mt">Pause, refresh, add or remove sources on the Sources page. <button class="link" id="runnow">Run ingestion now</button></p>`}</div></section>
      <section class="blk"><header><h2>Review queue</h2></header><div class="two">${reviewList('model', pend.models, 'Models')}${reviewList('paper', pend.papers, 'Papers')}</div><p class="fine">Items only wait here when REQUIRE_REVIEW is set to true.</p></section>
      <section class="blk"><header><h2>Ingestion log</h2></header><div class="tw"><table><tr><th>Time</th><th>Source</th><th>Status</th><th>Message</th></tr>${log.map(l => html`<tr><td>${l.ts.replace('T', ' ').slice(0, 16)}</td><td>${l.source_id}</td><td class="${l.status === 'error' ? 'bad' : 'ok'}">${l.status}</td><td>${l.message}</td></tr>`)}${log.length ? '' : html`<tr><td colspan="4" class="na">No runs yet.</td></tr>`}</table></div></section>
      <section class="blk"><header><h2>Users</h2></header><div class="panel rows">${users.map(u => html`<div>${u.email} ${u.role === 'admin' ? html`<span class="tag">admin</span>` : ''} <button class="mini" data-id="${u.id}" data-role="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? 'Demote' : 'Make admin'}</button></div>`)}</div></section>`,
    after(root) {
      const again = () => dispatchEvent(new HashChangeEvent('hashchange'));
      root.addEventListener('click', async e => {
        const t = e.target.closest('button'); if (!t) return;
        if (t.id === 'backup') {
          t.disabled = true; t.textContent = 'Preparing backup…';
          const result = $('#backup-result', root);
          try {
            const response = await fetch('/api/admin/backup', { credentials: 'same-origin' });
            if (!response.ok) throw new Error('Backup failed (HTTP ' + response.status + ').');
            const url = URL.createObjectURL(await response.blob());
            const a = document.createElement('a');
            a.href = url;
            a.download = (response.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'signalstack-backup.sqlite';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            result.textContent = 'Backup downloaded. Keep it somewhere safe.';
          } catch (err) { result.textContent = err.message; }
          finally { t.disabled = false; t.textContent = 'Download database backup'; }
          return;
        }
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
