// A small bar that offers the weekly email. It appears after the first scroll or 20 seconds, once, and never again after it is dismissed (30 days)
// or used. Nothing is sent until the person presses Subscribe.
import { api, html, mount, $ } from './lib.js';

const KEY = 'ss_nl', QUIET_MS = 30 * 864e5;
const state = () => { try { const x = JSON.parse(localStorage.getItem(KEY)); return x && typeof x === 'object' ? x : {}; } catch (e) { return {}; } };
const keep = v => { try { localStorage.setItem(KEY, JSON.stringify({ ...v, at: Date.now() })); } catch (e) { /* storage unavailable */ } };
const quiet = () => { const x = state(); return x.done || (x.at && Date.now() - x.at < QUIET_MS); };

function show() {
  if (quiet() || $('#nlbar')) return;
  // Stay out of the way of the intro, the sign-in dialog and the admin area.
  if ($('#intro') || document.body.dataset.route === 'admin' || ($('#authdlg') && $('#authdlg').open)) return void setTimeout(show, 5000);
  const bar = document.createElement('section'); bar.id = 'nlbar'; bar.className = 'nlbar'; bar.setAttribute('aria-label', 'Weekly newsletter');
  document.body.append(bar);
  mount(bar, html`<div class="nl-in"><p class="nl-t"><b>Get the top 5 AI signals weekly.</b> <span>Free, one email a week. Unsubscribe any time.</span></p>
    <form id="nlf" novalidate><label class="sr" for="nle">Email address</label><input id="nle" name="email" type="email" required maxlength="120" placeholder="you@example.com" autocomplete="email"><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="pri" type="submit" id="nls">Subscribe</button></form>
    <button type="button" class="nl-x" id="nlx" aria-label="Dismiss">×</button></div>
    <p class="nl-fine" id="nlm" role="status">By subscribing you agree to the <a href="/privacy">Privacy Policy</a>.</p>`);
  $('#nlx').onclick = () => { keep({}); bar.remove(); };
  $('#nlf').onsubmit = async e => {
    e.preventDefault(); const f = e.target, b = $('#nls'), m = $('#nlm'), v = Object.fromEntries(new FormData(f));
    b.disabled = true; b.textContent = 'Subscribing…';
    try { await api('/subscribe', 'POST', { email: v.email, website: v.website, source: 'bar' }); keep({ done: true }); mount(bar, html`<div class="nl-in"><p class="nl-t"><b>You’re on the list.</b> <span>Look out for the weekly email.</span></p><button type="button" class="nl-x" id="nlx2" aria-label="Close">×</button></div>`); $('#nlx2').onclick = () => bar.remove(); setTimeout(() => bar.remove(), 6000); }
    catch (x) { b.disabled = false; b.textContent = 'Subscribe'; m.textContent = x.message; m.classList.add('nl-err'); }
  };
}

export function initNewsletter() {
  if (quiet()) return;
  let armed = true; const go = () => { if (!armed) return; armed = false; removeEventListener('scroll', onScroll); show(); };
  const onScroll = () => { if (scrollY > 120) go(); };
  addEventListener('scroll', onScroll, { passive: true }); setTimeout(go, 20000);
}
