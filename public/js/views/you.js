// "You": account, watchlist and alerts, plus the tools that don't fit in the main navigation.
import { api, html, pageHead, empty, modelCard, state, $ } from '../lib.js';

export const gate = () => html`<div class="empty"><h3>Log in to continue</h3><p>Create a free account to follow models and set alerts. Everything else works without one.</p><div class="tags"><button class="pri" data-action="login">Log in</button><button data-action="signup">Sign up</button></div></div>`;

export async function render() {
  const m = state.me, c = state.status.counts || {};
  return {
    title: 'You',
    html: html`${pageHead(m ? (m.name || 'Your account') : 'You', m ? m.email : 'Browsing as a guest')}
      ${m ? '' : html`<div class="panel"><h2>Make it yours</h2><p class="sub">An account lets you follow models and get alerts. It is optional.</p><div class="tags mt"><button class="pri" data-action="login">Log in</button><button data-action="signup">Sign up</button></div></div>`}
      <section class="blk"><header><h2>Your tools</h2></header><div class="grid">
        ${m ? html`<a class="panel" href="#watchlist"><h3>Watchlist</h3><p class="sub">${state.watch.length} model${state.watch.length === 1 ? '' : 's'} followed</p></a><a class="panel" href="#alerts"><h3>Alerts</h3><p class="sub">Get notified about what matters to you</p></a>` : ''}
        <a class="panel" href="#compare"><h3>Compare models</h3><p class="sub">Side by side, only known facts</p></a>
        <a class="panel" href="#companies"><h3>Companies</h3><p class="sub">Labs we track and their releases</p></a>
        ${c.benchmarks ? html`<a class="panel" href="#benchmarks"><h3>Benchmarks</h3><p class="sub">Results with who measured them</p></a>` : ''}
        ${c.docs ? html`<a class="panel" href="#docs"><h3>Documentation changes</h3><p class="sub">Diff between versions</p></a>` : ''}
        ${m && m.role === 'admin' ? html`<a class="panel" href="#admin"><h3>Admin</h3><p class="sub">Sources, review queue, users</p></a>` : ''}
        <a class="panel" href="/terms"><h3>Terms</h3></a><a class="panel" href="/privacy"><h3>Privacy</h3></a></div></section>
      ${m ? html`<p class="mt"><button id="out">Log out</button></p>` : ''}`,
    after(root) { const o = $('#out', root); if (o) o.onclick = async () => { await api('/logout'); state.me = null; state.watch = []; location.reload(); }; },
  };
}

export const watchlist = {
  async render() {
    const items = state.watch.length ? (await api('/models?ids=' + state.watch.map(encodeURIComponent).join(','))).items : [];
    return { title: 'Watchlist', html: html`${pageHead('Watchlist', 'Models you follow.')}${items.length ? html`<div class="grid">${items.map(modelCard)}</div>` : empty('Nothing here yet', 'Open a model and choose Watch to follow it.', html`<a href="#models">Browse models</a>`)}` };
  },
};

const CATS = ['Model Release', 'Trending', 'Announcement', 'Open Source', 'Research'];
export const alerts = {
  async render() {
    const [d, orgs] = await Promise.all([api('/alerts'), api('/orgs')]);
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    return {
      title: 'Alerts',
      html: html`${pageHead('Alerts', 'Only events at or above your chosen level are matched.')}
        <p class="note">Browser notifications work while this tab is open (permission: ${perm}). Email alerts need email set up by the site admin.</p>
        <div class="toolbar mt"><select id="ao" aria-label="Organization"><option value="">Any organization</option>${orgs.map(x => html`<option value="${x.id}">${x.name}</option>`)}</select>
          <select id="ac" aria-label="Category"><option value="">Any category</option>${CATS.map(x => html`<option>${x}</option>`)}</select>
          <select id="as" aria-label="Severity"><option>All</option><option>Major only</option><option>Critical only</option></select>
          <label class="chk"><input type="checkbox" id="ae"><span>Also email me</span></label><button class="pri" id="aa">Create alert</button></div>
        <div class="panel rows">${d.alerts.map(a => html`<div>${a.org_id || 'Any organization'}, ${a.cat || 'any category'}, ${a.minsev}${a.channel === 'app+email' ? ' (email)' : ''} <button class="mini" data-ad="${a.id}">Delete</button></div>`)}${d.alerts.length ? '' : html`<div class="na">No alerts yet. Create one above.</div>`}</div>
        <section class="blk"><header><h2>Matching events</h2></header>${d.matches.length ? html`<div class="panel rows">${d.matches.slice(0, 40).map(e => html`<div><b>${e.sev}</b> ${e.summary}<p class="meta">${e.cat}, ${e.ts}</p></div>`)}</div>` : html`<div class="panel na">Nothing matches yet.</div>`}</section>`,
      after(root) {
        $('#aa', root).onclick = async () => { await api('/alerts', 'POST', { org_id: $('#ao', root).value, cat: $('#ac', root).value, minsev: $('#as', root).value, channel: $('#ae', root).checked ? 'app+email' : 'app' }); location.hash = 'alerts'; this.reload(); };
        root.querySelectorAll('[data-ad]').forEach(b => b.onclick = async () => { await api('/alerts', 'DELETE', { id: +b.dataset.ad }); this.reload(); });
        if ('Notification' in window && Notification.permission === 'default') setTimeout(() => Notification.requestPermission(), 800);
      },
      reload() { dispatchEvent(new HashChangeEvent('hashchange')); },
    };
  },
};
