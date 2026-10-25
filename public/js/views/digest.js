// Email digest settings: how often, at what local hour, a live preview of the email, and a test send.
import { api, html, pageHead, $ } from '../lib.js';
import { toast } from '../saved.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const label = h => (h % 12 || 12) + (h < 12 ? ' am' : ' pm');
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'your time zone'; } };

export async function render() {
  const d = await api('/digest');
  return {
    title: 'Email digest',
    html: html`${pageHead('Email digest', 'The most important AI items, in one email, with a link to each original source.')}
      <div class="panel dg">
        <div class="seg" role="radiogroup" aria-label="How often">${[['off', 'Off'], ['daily', 'Every day'], ['weekly', 'Every Monday']].map(([v, t]) => html`<button role="radio" aria-checked="${d.freq === v}" class="${d.freq === v ? 'on' : ''}" data-f="${v}">${t}</button>`)}</div>
        <label class="dg-row">Send at <select id="dh" aria-label="Hour">${HOURS.map(h => html`<option value="${h}" ${h === d.hour ? 'selected' : ''}>${label(h)}</option>`)}</select> <span class="meta">in ${zone()} time</span></label>
        <p class="note" id="dn">${d.freq === 'off' ? 'You will not get any email until you turn this on.' : `You will get it ${d.freq === 'weekly' ? 'every Monday' : 'every day'} at ${label(d.hour)}. If the site was asleep at that time, it is sent when it wakes up.`}</p>
        ${d.emailConfigured ? '' : html`<p class="note warn">Email sending is not set up on this server yet, so nothing will be sent until the site owner adds a RESEND_API_KEY. You can still preview it below.</p>`}
        <div class="tags mt"><button class="pri" id="dt" ${d.emailConfigured ? '' : 'disabled'}>Send me a test email</button><button id="dp">Refresh preview</button></div>
      </div>
      ${d.telegram ? html`<p class="note mt">A daily post also goes to this site's Telegram channel.</p>` : ''}
      <section class="blk"><header><h2>Preview</h2><span class="meta">What your email looks like right now</span></header>
        <iframe id="dv" class="dg-frame" title="Email preview" src="/digest/preview?freq=${d.freq === 'weekly' ? 'weekly' : 'daily'}"></iframe></section>`,
    after(root) {
      let cur = { ...d };
      const save = async () => { try { cur = { ...cur, ...(await api('/digest', 'POST', { freq: cur.freq, hour: cur.hour, tz_offset: -new Date().getTimezoneOffset() })) }; toast('Saved'); } catch (e) { toast(e.message || 'Could not save'); } };
      root.querySelectorAll('[data-f]').forEach(b => b.onclick = async () => { cur.freq = b.dataset.f; await save(); dispatchEvent(new HashChangeEvent('hashchange')); });
      $('#dh', root).onchange = async e => { cur.hour = +e.target.value; await save(); dispatchEvent(new HashChangeEvent('hashchange')); };
      $('#dp', root).onclick = () => { const f = $('#dv', root); f.src = '/digest/preview?freq=' + (cur.freq === 'weekly' ? 'weekly' : 'daily') + '&t=' + Date.now(); };
      $('#dt', root).onclick = async e => { e.target.disabled = true; try { await api('/digest/test', 'POST', { freq: cur.freq === 'weekly' ? 'weekly' : 'daily' }); toast('Test email sent. Check your inbox.'); } catch (x) { toast(x.message); } e.target.disabled = false; };
    },
  };
}
