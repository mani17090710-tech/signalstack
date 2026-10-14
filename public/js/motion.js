// Motion helpers. No libraries: the blade runs on the Web Animations API (compositor only), reveals are CSS classes,
// and count-ups are a short requestAnimationFrame loop. Every helper does nothing when the person prefers reduced motion.
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let blade, bar, last = null, playing = false;

function ensureBlade() {
  if (blade) return;
  blade = document.createElement('div'); blade.id = 'blade'; blade.setAttribute('aria-hidden', 'true');
  bar = document.createElement('i'); const echo = document.createElement('b');
  blade.append(bar, echo); document.body.append(blade); blade.echo = echo;
}

// A diagonal blade sweeps once across the page area when the person moves to a different section.
export function leave(route) {
  const from = last; last = route;
  if (from === null || from === route || calm() || playing || document.querySelector('dialog[open], #intro')) return;
  ensureBlade(); playing = true;
  const W = innerWidth, ease = 'cubic-bezier(.65, 0, .35, 1)', opt = { duration: 620, easing: ease, fill: 'none' };
  const move = (el, from, to, o) => el.animate([{ transform: `translateX(${from}px) skewX(-12deg)`, opacity: 1 }, { transform: `translateX(${to}px) skewX(-12deg)`, opacity: 1 }], o);
  const a = move(bar, -0.5 * W, 1.15 * W, opt);
  move(blade.echo, -0.4 * W, 1.25 * W, { ...opt, duration: 560 });
  a.onfinish = a.oncancel = () => { playing = false; };
}

const REVEAL = '.sig, .mcard, .rows > *, a.panel';
const parse = t => { const m = /^(\d[\d,]*(?:\.\d+)?)([kMB])?$/.exec(t.trim()); return m ? { n: parseFloat(m[1].replace(/,/g, '')), dec: (m[1].split('.')[1] || '').length, suf: m[2] || '', comma: m[1].includes(',') } : null; };

function countUp(el) {
  const p = parse(el.textContent), final = el.textContent;
  if (!p || p.n === 0) return;
  const dur = 900, t0 = performance.now();
  (function step(now) {
    const k = Math.min((now - t0) / dur, 1), v = p.n * (1 - Math.pow(1 - k, 3));
    el.textContent = k === 1 ? final : (p.comma ? Math.round(v).toLocaleString('en-US') : v.toFixed(p.dec)) + p.suf;
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

let watcher;
function reveal(root) {
  root.querySelectorAll(REVEAL).forEach((el, i) => { if (el.classList.contains('m-in')) return; el.style.setProperty('--md', Math.min(i, 10) * 45 + 'ms'); el.classList.add('m-in'); });
  root.querySelectorAll('.score:not(.m-ring)').forEach((el, i) => { el.style.setProperty('--md', Math.min(i, 10) * 45 + 120 + 'ms'); el.classList.add('m-ring'); });
  root.querySelectorAll('.snapshot b:not([data-c]), .score b:not([data-c])').forEach(el => { el.dataset.c = '1'; countUp(el); });
}

// Called right after a page is mounted: cards rise in with a short stagger, score rings pop, numbers count up.
// Some pages fill their lists a moment later, so content added in the next 1.5 s is revealed too; later changes (typing in a filter) are not.
export function enter(root) {
  if (watcher) watcher.disconnect();
  if (calm() || !root) return;
  reveal(root);
  watcher = new MutationObserver(() => reveal(root));
  watcher.observe(root, { childList: true, subtree: true });
  setTimeout(() => { if (watcher) watcher.disconnect(); }, 1500);
}
