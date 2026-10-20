// A 4-digit code field made of four boxes that behave like one input. One ring glides to the active box; each digit
// spins in on a short reel and a spark runs round the box edge. Real inputs underneath, so the numeric keypad, paste
// and one-time-code autofill all work. Motion is skipped for people who prefer reduced motion.
const LEN = 4;

export function codeBox(root, { onComplete = () => {} } = {}) {
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('code'); root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Verification code');
  const ring = document.createElement('span'); ring.className = 'code__cursor'; root.append(ring);
  const vals = Array(LEN).fill(''), slots = [], inputs = [];
  let locked = false;

  for (let i = 0; i < LEN; i++) {
    const label = document.createElement('label'); label.className = 'slot';
    label.innerHTML = `<input inputmode="numeric" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" aria-label="Digit ${i + 1} of ${LEN}">` +
      '<span class="slot__win"><span class="slot__digit"></span></span><svg class="slot__spark" aria-hidden="true"><rect pathLength="1"/></svg>';
    root.append(label); slots.push(label); inputs.push(label.querySelector('input'));
    const input = inputs[i];
    input.addEventListener('focus', () => { input.select(); place(i); });
    input.addEventListener('input', () => {
      const d = input.value.replace(/\D/g, '');
      if (!d) { set(i, ''); input.value = ''; } else fill(i, d); // one digit, or a whole code from autofill
    });
    input.addEventListener('paste', e => { e.preventDefault(); fill(i, (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '')); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !vals[i] && i > 0) { e.preventDefault(); set(i - 1, ''); inputs[i - 1].focus(); }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); inputs[i - 1].focus(); }
      else if (e.key === 'ArrowRight' && i < LEN - 1) { e.preventDefault(); inputs[i + 1].focus(); }
    });
  }

  function layout() {
    slots.forEach(s => {
      const r = s.querySelector('rect'), w = s.offsetWidth, h = s.offsetHeight;
      r.setAttribute('x', 1); r.setAttribute('y', 1); r.setAttribute('width', Math.max(w - 2, 0)); r.setAttribute('height', Math.max(h - 2, 0)); r.setAttribute('rx', 12);
    });
    const k = inputs.indexOf(document.activeElement); place(k < 0 ? 0 : k);
  }
  function place(i) {
    const s = slots[i]; if (!s || !s.offsetWidth) return;
    ring.style.width = s.offsetWidth + 8 + 'px'; ring.style.height = s.offsetHeight + 8 + 'px';
    ring.style.transform = `translate(${s.offsetLeft - 4}px, ${s.offsetTop - 4}px)`;
    requestAnimationFrame(() => root.classList.add('placed')); // glide only after the first placement
  }
  function set(i, d) {
    vals[i] = d;
    const digit = slots[i].querySelector('.slot__digit');
    digit.replaceChildren(); slots[i].classList.toggle('is-filled', !!d);
    if (d) {
      // a few random digits spin past the window, then the typed one settles
      const picks = []; let last = d;
      for (let k = 0; k < 5; k++) { let r; do { r = String(Math.floor(Math.random() * 10)); } while (r === last); picks.push(r); last = r; }
      const items = [...picks, d], reel = document.createElement('span');
      reel.className = 'reel'; reel.innerHTML = items.map(x => `<span>${x}</span>`).join('');
      digit.append(reel);
      const to = `translateY(${-(items.length - 1) * 100 / items.length}%)`;
      reel.style.transform = to;
      if (!calm()) {
        reel.animate([{ transform: 'translateY(0)', filter: 'blur(2.5px)' }, { transform: to, filter: 'blur(0px)' }], { duration: 560, easing: 'cubic-bezier(.16, .8, .2, 1)' })
          .onfinish = () => { slots[i].classList.remove('is-land'); void slots[i].offsetWidth; slots[i].classList.add('is-land'); };
        slots[i].classList.remove('is-spark'); void slots[i].offsetWidth; slots[i].classList.add('is-spark');
      }
    }
    inputs[i].value = d; root.classList.remove('is-bad');
  }
  function fill(i, digits) {
    if (locked) return;
    let k = i;
    for (const d of digits) { if (k >= LEN) break; set(k, d); k++; }
    const next = Math.min(k, LEN - 1); inputs[next].focus(); place(next);
    if (vals.every(Boolean)) onComplete(vals.join(''));
  }
  const clear = () => { locked = false; vals.forEach((_, k) => set(k, '')); };
  const focus = () => { const k = vals.findIndex(v => !v); inputs[k < 0 ? LEN - 1 : k].focus(); };

  root.addEventListener('click', e => { if (!e.target.closest('.slot')) focus(); });
  root.addEventListener('animationend', e => {
    if (e.target.closest('.slot__spark')) e.target.closest('.slot').classList.remove('is-spark');
    else if (e.animationName === 'land') e.target.classList.remove('is-land');
  });
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(root); else addEventListener('resize', layout);
  layout();

  return {
    value: () => vals.join(''),
    clear, focus,
    // the code was wrong: shake red, then empty the boxes ready for another try
    fail() { locked = true; root.classList.add('is-bad'); setTimeout(() => { clear(); focus(); }, calm() ? 400 : 750); },
  };
}
