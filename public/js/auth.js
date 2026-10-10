// Sign up / log in / password reset in a native dialog. Guests can browse everything; accounts add watchlist and alerts.
import { $, api, html, mount, state } from './lib.js';

let mode = 'login', resetEmail = '', onDone = () => {};
const TITLE = { login: 'Log in', signup: 'Create your account', forgot: 'Reset your password', reset: 'Enter your reset code' };
const dlg = () => $('#authdlg');

export function openAuth(m = 'login', done) { mode = m; if (done) onDone = done; draw(); const d = dlg(); if (!d.open) d.showModal(); }
export const closeAuth = () => { const d = dlg(); if (d.open) d.close(); };

function draw(msg = '') {
  const d = dlg();
  mount(d, html`<h2 id="authtitle">${TITLE[mode]}</h2>
  <form id="af" novalidate>
    ${mode === 'signup' ? html`<input name="name" placeholder="Your name" autocomplete="name" aria-label="Your name">` : ''}
    ${mode === 'forgot' ? html`<p class="sub">Enter your email and we’ll send a 6-digit code.</p>` : ''}
    ${mode === 'reset' ? html`<p class="sub">We sent a code to ${resetEmail}. It expires in 10 minutes.</p><input name="code" placeholder="6-digit code" inputmode="numeric" pattern="[0-9]{6}" required aria-label="Reset code">` : ''}
    <input name="email" type="email" placeholder="Email" required autocomplete="email" aria-label="Email" value="${resetEmail}" ${mode === 'reset' ? 'hidden' : ''}>
    ${mode === 'login' || mode === 'signup' ? html`<input name="password" type="password" placeholder="Password (8+ characters)" required autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" aria-label="Password">` : ''}
    ${mode === 'reset' ? html`<input name="password" type="password" placeholder="New password (8+ characters)" required autocomplete="new-password" aria-label="New password">` : ''}
    ${mode === 'signup' ? html`<label class="chk"><input type="checkbox" name="accept" required><span>I have read and agree to the <a href="/terms" target="_blank" rel="noopener">Terms &amp; Conditions</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>` : ''}
    ${msg ? html`<div class="note" role="status">${msg}</div>` : ''}
    <div class="err" id="er" role="alert"></div>
    <button class="pri" id="go">${{ login: 'Log in', signup: 'Sign up', forgot: 'Send reset code', reset: 'Reset password' }[mode]}</button>
    <div class="dlg-links">
      <button type="button" class="link" id="sw">${{ login: 'New here? Create an account', signup: 'Have an account? Log in', forgot: 'Back to log in', reset: 'Back to log in' }[mode]}</button>
      ${mode === 'login' ? html`<button type="button" class="link" id="fp">Forgot password?</button>` : ''}
      <button type="button" class="link" id="cl">Keep browsing</button>
    </div>
    <p class="fine"><a href="/terms" target="_blank" rel="noopener">Terms</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy</a></p>
  </form>`);
  $('#sw').onclick = () => { mode = mode === 'login' ? 'signup' : 'login'; draw(); };
  const fp = $('#fp'); if (fp) fp.onclick = () => { mode = 'forgot'; draw(); };
  $('#cl').onclick = closeAuth;
  $('#af').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target)), er = $('#er'), go = $('#go');
    if (mode === 'signup') f.accept = f.accept === 'on';
    go.disabled = true;
    try {
      if (mode === 'forgot') { const r = await api('/forgot-password', 'POST', f); resetEmail = f.email; mode = 'reset'; draw(r.message); }
      else if (mode === 'reset') { await api('/reset-password', 'POST', f); mode = 'login'; resetEmail = ''; draw('Password updated. Log in with your new password.'); }
      else { await api('/' + mode, 'POST', f); closeAuth(); onDone(); }
    } catch (x) { er.textContent = x.message; go.disabled = false; }
  };
  const first = d.querySelector('input:not([hidden])'); if (first) first.focus();
}
