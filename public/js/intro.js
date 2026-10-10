// First-visit intro: a live map of the AI ecosystem. Each node is a lab we track; its size reflects how many of
// its models we have actually stored, and the small satellites are those models. Nothing here is invented.
import { $, api, html, mount, num } from './lib.js';

const SEEN = 'ss_intro_seen';
export const introSeen = () => { try { return localStorage.getItem(SEEN) === '1'; } catch (e) { return false; } };
const markSeen = () => { try { localStorage.setItem(SEEN, '1'); } catch (e) { /* storage unavailable */ } };

export async function showIntro(go) {
  const el = document.createElement('div'); el.id = 'intro'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Welcome to Signalstack');
  document.body.append(el);
  mount(el, html`<canvas id="universe" aria-hidden="true"></canvas><div class="intro-tip" id="itip"></div>
    <button class="intro-skip" id="iskip">Skip intro</button>
    <div class="intro-copy"><h1>Every AI model, paper and release in one live view</h1>
    <p>Signalstack reads Hugging Face, arXiv, GitHub and official lab blogs, then shows what is new with the source beside it.</p>
    <div class="intro-stat" id="istat"></div>
    <div class="intro-cta"><button class="pri" id="iexp">Explore the AI Universe →</button><button id="inow">See What’s Happening Now</button></div></div>`);
  let stop = () => {};
  const close = to => { stop(); markSeen(); el.remove(); document.body.style.overflow = ''; go(to); };
  document.body.style.overflow = 'hidden';
  $('#iskip').onclick = () => close('now'); $('#iexp').onclick = () => close('models'); $('#inow').onclick = () => close('now');
  addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && document.getElementById('intro')) { removeEventListener('keydown', esc); close('now'); } });
  $('#iexp').focus();
  let companies = [], status = null;
  try { [companies, status] = await Promise.all([api('/companies'), api('/status')]); } catch (e) { /* draw an empty map */ }
  const c = status && status.counts;
  if (c && (c.models || c.papers)) mount($('#istat'), html`<span>${num(c.models)} models tracked</span><span>${num(c.papers)} paper${c.papers === 1 ? '' : 's'} collected</span><span>${num(c.eventsWeek)} signals this week</span>`);
  stop = drawUniverse($('#universe'), $('#itip'), companies);
}

function drawUniverse(cv, tip, companies) {
  const ctx = cv.getContext('2d'), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, raf = 0, t0 = performance.now(), hover = -1, mx = -1, my = -1;
  const nodes = companies.map((c, i) => ({
    c, ring: 0, ang: (i / Math.max(1, companies.length)) * Math.PI * 2 + 0.4, r: 5 + Math.min(14, Math.sqrt(c.models) * 1.6),
    sats: Array.from({ length: Math.min(c.models, 10) }, (_, k) => ({ a: Math.random() * 6.28, d: 12 + k * 2.2 + Math.random() * 8, s: (0.25 + Math.random() * 0.5) * (k % 2 ? 1 : -1) })),
    sp: 0.018 + (i % 3) * 0.006, x: 0, y: 0,
  }));
  const fit = () => { const dpr = Math.min(2, devicePixelRatio || 1); W = cv.clientWidth; H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  const draw = now => {
    const t = (now - t0) / 1000; ctx.clearRect(0, 0, W, H);
    const cx = W / 2, narrow = W < 700, cy = H * (narrow ? 0.22 : 0.3), R = narrow ? Math.min(W * 0.42, H * 0.19) : Math.min(W * 0.44, H * 0.25);
    for (const k of [0.45, 0.75, 1]) { ctx.beginPath(); ctx.ellipse(cx, cy, R * k, R * k * 0.62, 0, 0, 6.283); ctx.strokeStyle = 'rgba(53,212,244,' + (0.07 + 0.03 * k) + ')'; ctx.lineWidth = 1; ctx.stroke(); }
    nodes.forEach((n, i) => {
      const k = [0.45, 0.75, 1][i % 3], a = n.ang + t * n.sp * (reduce ? 0 : 1);
      n.x = cx + Math.cos(a) * R * k; n.y = cy + Math.sin(a) * R * k * 0.62;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y); ctx.strokeStyle = 'rgba(53,212,244,.07)'; ctx.stroke();
    });
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 46); g.addColorStop(0, 'rgba(53,212,244,.55)'); g.addColorStop(1, 'rgba(53,212,244,0)');
    ctx.fillStyle = g; ctx.fillRect(cx - 50, cy - 50, 100, 100); ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 6.283); ctx.fillStyle = '#35d4f4'; ctx.fill();
    nodes.forEach((n, i) => {
      const hot = i === hover;
      const gl = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 3); gl.addColorStop(0, hot ? 'rgba(53,212,244,.5)' : 'rgba(53,212,244,.22)'); gl.addColorStop(1, 'rgba(53,212,244,0)');
      ctx.fillStyle = gl; ctx.fillRect(n.x - n.r * 3, n.y - n.r * 3, n.r * 6, n.r * 6);
      n.sats.forEach(s => { const sa = s.a + t * s.s * (reduce ? 0 : 1); ctx.beginPath(); ctx.arc(n.x + Math.cos(sa) * s.d, n.y + Math.sin(sa) * s.d * 0.8, 1.6, 0, 6.283); ctx.fillStyle = 'rgba(160,230,250,.75)'; ctx.fill(); });
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.283); ctx.fillStyle = hot ? '#9ae9fb' : '#1c6f8a'; ctx.fill(); ctx.strokeStyle = '#35d4f4'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = '600 12px Figtree, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = hot ? '#fff' : '#9fb2d4'; ctx.fillText(n.c.name, n.x, n.y + n.r + 17);
    });
    if (!reduce) raf = requestAnimationFrame(draw);
  };
  const move = e => {
    const b = cv.getBoundingClientRect(); mx = e.clientX - b.left; my = e.clientY - b.top; hover = -1;
    nodes.forEach((n, i) => { if ((n.x - mx) ** 2 + (n.y - my) ** 2 < (n.r + 8) ** 2) hover = i; });
    const n = nodes[hover];
    if (n) { tip.style.display = 'block'; tip.style.left = Math.min(mx + 14, W - 180) + 'px'; tip.style.top = my + 14 + 'px'; tip.textContent = n.c.name + ': ' + n.c.models + ' model' + (n.c.models === 1 ? '' : 's') + ' tracked'; } else tip.style.display = 'none';
    if (reduce) draw(performance.now());
  };
  cv.parentElement.addEventListener('pointermove', move);
  const onResize = () => { fit(); if (reduce) draw(performance.now()); };
  addEventListener('resize', onResize); fit(); draw(performance.now());
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', onResize); };
}
