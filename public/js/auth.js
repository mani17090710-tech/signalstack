// Log in / sign up / password reset in a native dialog. Guests can browse everything; accounts add watchlist and alerts.
// Log in and Create account trade places under a diagonal blade; the password-reset steps simply fade in.
import { $, $$, api, html, mount } from './lib.js';
import { codeBox } from './codebox.js';

let onDone = () => {}, cur = 'login', busy = false, resetEmail = '', box = null;
const dlg = () => $('#authdlg');
const RAKE = 12;
const SLIDE = {
  login: { title: html`Welcome <em>back.</em>`, sub: 'Log in to your watchlist and alerts.' },
  signup: { title: html`Join <em>us.</em>`, sub: 'Free account. Browsing never needs one.' },
};
const head = k => html`<div class="head"><div class="brand"><i></i>Signalstack</div><h2 class="title">${SLIDE[k].title}</h2><p class="sub">${SLIDE[k].sub}</p></div>`;
const field = (id, type, name, label, auto) => html`<div class="field"><input id="a-${id}" name="${name}" type="${type}" placeholder=" " autocomplete="${auto}"><label for="a-${id}">${label}</label></div>`;
const legal = html`<p class="fine"><a href="/terms" target="_blank" rel="noopener">Terms</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy</a></p>`;

export function openAuth(m = 'login', done) {
  if (done) onDone = done;
  const d = dlg();
  d.removeAttribute('aria-labelledby'); d.setAttribute('aria-label', 'Log in or create an account');
  build(m === 'signup' ? 'signup' : 'login');
  if (!d.open) d.showModal();
  focusFirst(cur);
}
export const closeAuth = () => { const d = dlg(); if (d.open) d.close(); };

function build(start) {
  cur = start; busy = false; resetEmail = '';
  mount(dlg(), html`<div class="auth" id="auth">
    <form class="pane" data-pane="login" novalidate>
      ${head('login')}
      <div class="note" role="status" hidden></div>
      ${field('le', 'email', 'email', 'Email', 'email')}
      ${field('lp', 'password', 'password', 'Password', 'current-password')}
      <button type="button" class="link fp" data-to="forgot">Forgot password?</button>
      <div class="err" role="alert"></div>
      <button class="go" type="submit">Log in</button>
      <div class="links"><button type="button" class="swap" data-to="signup">New here? <b>Create an account</b></button><button type="button" class="keep" data-close>Keep browsing</button></div>
      ${legal}
    </form>
    <form class="pane" data-pane="signup" novalidate>
      ${head('signup')}
      ${field('sn', 'text', 'name', 'Name', 'name')}
      ${field('se', 'email', 'email', 'Email', 'email')}
      ${field('sp', 'password', 'password', 'Password (8+ characters)', 'new-password')}
      <label class="chk"><input type="checkbox" name="accept"><span>I have read and agree to the <a href="/terms" target="_blank" rel="noopener">Terms &amp; Conditions</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
      <div class="err" role="alert"></div>
      <button class="go" type="submit">Sign up</button>
      <div class="links"><button type="button" class="swap" data-to="login">Have an account? <b>Log in</b></button><button type="button" class="keep" data-close>Keep browsing</button></div>
    </form>
    <form class="pane" data-pane="forgot" novalidate>
      <div class="head"><div class="brand"><i></i>Signalstack</div><h2 class="title">Reset your <em>password.</em></h2><p class="sub">Enter your email and we’ll send a 4-digit code.</p></div>
      ${field('fe', 'email', 'email', 'Email', 'email')}
      <div class="err" role="alert"></div>
      <button class="go" type="submit">Send reset code</button>
      <div class="links"><button type="button" class="swap" data-to="login">Back to <b>log in</b></button><button type="button" class="keep" data-close>Keep browsing</button></div>
    </form>
    <form class="pane" data-pane="reset" novalidate>
      <div class="head"><div class="brand"><i></i>Signalstack</div><h2 class="title">Enter your <em>code.</em></h2><p class="sub" id="resetsub">We sent a code to your email. It expires in 10 minutes.</p></div>
      <div class="note" role="status" hidden></div>
      <div id="codebox"></div>
      ${field('rp', 'password', 'password', 'New password (8+ characters)', 'new-password')}
      <div class="err" role="alert"></div>
      <button class="go" type="submit">Reset password</button>
      <div class="links"><button type="button" class="swap" data-to="login">Back to <b>log in</b></button><button type="button" class="keep" data-close>Keep browsing</button></div>
    </form>
    <div class="auth__band" id="band" aria-hidden="true">
      <span class="band__edge band__edge--lead"></span><span class="band__edge band__edge--trail"></span>
      <div class="band__inner"><div class="band__page" id="bandPage">
        ${['login', 'signup'].map(k => html`<div class="band__slide ${k === start ? 'is-on' : ''}" data-t="${k}">${head(k)}</div>`)}
      </div></div>
    </div>
    <span class="echo" id="echo" aria-hidden="true"></span>
  </div>`);
  box = codeBox($('#codebox'), { onComplete: () => { const p = $('#a-rp'); if (p) p.focus(); } });
  $('#codebox').addEventListener('input', () => showErr(pane('reset'), '')); // typing a new code clears the old error
  const a = $('#auth');
  $$('.pane', a).forEach(p => {
    const on = p.dataset.pane === start;
    p.classList.toggle('is-on', on); p.inert = !on;
    [...p.children].forEach((c, i) => c.style.setProperty('--i', i));
  });
  a.onclick = e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.close !== undefined) closeAuth();
    else if (t.dataset.to) go(t.dataset.to);
  };
  a.querySelectorAll('form').forEach(f => { f.onsubmit = e => { e.preventDefault(); submit(f.dataset.pane, f); }; });
}

const pane = k => $(`.pane[data-pane="${k}"]`);
function focusFirst(k) { const i = pane(k) && pane(k).querySelector('input:not([type=checkbox]):not([hidden])'); if (i) i.focus(); }
const showErr = (f, msg) => { f.querySelector('.err').textContent = msg || ''; };
function note(k, msg) { const n = pane(k).querySelector('.note'); n.textContent = msg || ''; n.hidden = !msg; }

// Swap which pane is showing. Used for the instant swaps and, mid-sweep, for the blade.
function show(next) {
  const from = pane(cur), to = pane(next);
  from.classList.remove('is-on'); from.inert = true;
  to.style.setProperty('--d', '0ms'); to.classList.add('is-on'); to.inert = false;
  cur = next;
  $$('.band__slide').forEach(s => s.classList.toggle('is-on', s.dataset.t === next));
}

const ease = t => (t < .5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function go(next) {
  if (busy || next === cur) return;
  const sweepable = (cur === 'login' && next === 'signup') || (cur === 'signup' && next === 'login');
  if (!sweepable || reduced()) { show(next); focusFirst(next); return; }
  busy = true;
  const auth = $('#auth'), band = $('#band'), page = $('#bandPage'), inner = $('.band__inner'), echo = $('#echo');
  auth.classList.add('is-busy');
  const W = auth.clientWidth, H = auth.clientHeight, pad = Math.tan(RAKE * Math.PI / 180) * H / 2;
  const Bw = 1.5 * W + 3 * pad, s0 = -Bw - pad, s1 = W + pad + 40, D = s1 - s0, pCover = (W + 2 * pad) / D;
  const DUR = 1250, swapAt = (pCover + .1) * DUR;
  band.style.width = Bw + 'px'; page.style.width = W + 'px';
  setTimeout(() => { show(next); pane(next).style.setProperty('--d', '260ms'); }, swapAt);
  const start = performance.now();
  (function frame(now) {
    const p = Math.min((now - start) / DUR, 1), s = s0 + ease(p) * D;
    band.style.transform = `skewX(-${RAKE}deg) translateX(${s}px)`;
    inner.style.transform = `translateX(${-s}px) skewX(${RAKE}deg)`;
    echo.style.transform = `skewX(-${RAKE}deg) translateX(${s + Bw + 26 + 60 * Math.sin(p * Math.PI)}px)`;
    if (p < 1) requestAnimationFrame(frame);
    else {
      band.style.transform = echo.style.transform = `skewX(-${RAKE}deg) translateX(-9999px)`;
      auth.classList.remove('is-busy'); busy = false; focusFirst(next);
    }
  })(start);
}

async function submit(k, f) {
  const v = Object.fromEntries(new FormData(f)), btn = f.querySelector('.go');
  showErr(f, '');
  if (k === 'signup') { v.accept = v.accept === 'on'; if (!v.accept) return showErr(f, 'Please accept the Terms & Conditions and Privacy Policy to continue.'); }
  btn.disabled = true;
  try {
    if (k === 'forgot') {
      const r = await api('/forgot-password', 'POST', v); resetEmail = v.email;
      $('#resetsub').textContent = `We sent a code to ${resetEmail}. It expires in 10 minutes.`;
      note('reset', r.message); go('reset'); focusFirst('reset');
    } else if (k === 'reset') {
      if (box.value().length < 4) { btn.disabled = false; return showErr(f, 'Enter the 4-digit code from your email.'); }
      await api('/reset-password', 'POST', { email: resetEmail, code: box.value(), password: v.password });
      resetEmail = ''; note('login', 'Password updated. Log in with your new password.'); go('login');
    } else { await api('/' + k, 'POST', v); closeAuth(); onDone(); }
  } catch (x) { showErr(f, x.message); if (k === 'reset' && /code/i.test(x.message)) box.fail(); }
  btn.disabled = false;
}
