// "What is this model?" — a plain-English explanation of a model, built only from facts we hold, with animated graphs
// for its Signal Score, price, context window and popularity. Where a source does not publish something, the page says so
// instead of guessing. The wording is written from fixed templates; it is not an AI-generated review.
import { html, raw, day, num, isApi, shortName, ctxLabel, dateLabel } from '../lib.js';

// What the common task labels mean, in one line each.
export const TASK = {
  'text-generation': ['text generation', 'Writes and continues text: chat answers, summaries, code and drafts.'],
  'text2text-generation': ['text-to-text', 'Turns one piece of text into another, such as translation or summaries.'],
  'image-text-to-text': ['vision and language', 'Reads images together with text and replies in text.'],
  'text-to-image': ['image generation', 'Creates pictures from a written description.'],
  'image-to-image': ['image editing', 'Changes or restyles an existing picture.'],
  'text-to-video': ['video generation', 'Creates short videos from a written description.'],
  'text-to-speech': ['speech generation', 'Turns text into spoken audio.'],
  'automatic-speech-recognition': ['speech recognition', 'Turns speech into written text.'],
  'feature-extraction': ['embeddings', 'Turns text or data into numbers that make search and matching possible.'],
  'sentence-similarity': ['text similarity', 'Measures how close in meaning two pieces of text are.'],
  'text-classification': ['text classification', 'Sorts text into labels, for example by topic or sentiment.'],
  'token-classification': ['text tagging', 'Marks parts of a text, such as names, places or dates.'],
  'question-answering': ['question answering', 'Finds the answer to a question inside a given passage.'],
  'summarization': ['summarization', 'Shortens long text while keeping the main points.'],
  'translation': ['translation', 'Translates text from one language to another.'],
  'fill-mask': ['masked language modelling', 'Predicts missing words in a sentence.'],
  'image-classification': ['image classification', 'Says what a picture shows.'],
  'object-detection': ['object detection', 'Finds and labels the objects in a picture.'],
  'image-to-text': ['image captioning', 'Describes what is in a picture.'],
  'visual-question-answering': ['visual question answering', 'Answers questions about a picture.'],
  'any-to-any': ['multimodal', 'Takes in and produces several kinds of media, such as text, images and audio.'],
};
const CAP = {
  reasoning: 'Works through a problem step by step before it answers.',
  'tool-use': 'Can call tools or functions you give it, such as search or a database.',
};
const MODAL = { text: 'Text', image: 'Images', audio: 'Audio', video: 'Video', file: 'Files' };

const PARTS = {
  impact: ['Impact', 'How fast people picked it up: downloads per day since it came out.'],
  popularity: ['Popularity', 'How much people use it: likes and downloads, or likes of models that cite a paper.'],
  technical: ['Technical importance', 'How big it is: parameters, context window, or version size of a release.'],
  relevance: ['Relevance', 'How closely it is tied to a lab we track. Official sources rate highest.'],
  freshness: ['Freshness', 'How new it is. This fades over about three days.'],
};
const MISSING = { impact: 'No public adoption data available yet.', popularity: 'No public adoption data available yet.', technical: 'No public technical details available yet.', relevance: 'No link to a tracked lab available yet.', freshness: 'No publication date available yet.' };

const ICON = {
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  page: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.4 0-2.5.8-2.5 1.9 0 2.6 5.2 1.2 5.2 3.9 0 1.1-1.1 2-2.7 2-1.2 0-2.2-.5-2.7-1.4M12 6.5V8m0 8v1.5"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M12 9v11M4 13h16M12 9c-2-4-6-3-5 0M12 9c2-4 6-3 5 0"/>',
};
const icon = k => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ex-ico">${raw(ICON[k])}</svg>`;

const money = v => '$' + (v >= 100 ? Math.round(v) : v >= 1 ? +v.toFixed(2) : v >= .01 ? +v.toFixed(3) : +v.toFixed(5));
const compact = n => (n >= 1e9 ? +(n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const pages = tokens => { const p = Math.round((tokens * 0.75) / 500); return p >= 1000 ? 'about ' + num(Math.round(p / 100) * 100) + ' pages' : p >= 2 ? 'about ' + num(p) + ' pages' : 'about a page'; };

// position (0-100) of a value inside a peer range, on a log scale because prices and sizes span orders of magnitude
const pos = (v, st) => {
  if (!(st.max > st.min) || !(st.min > 0)) return 50;
  return Math.max(0, Math.min(100, 100 * (Math.log(v) - Math.log(st.min)) / (Math.log(st.max) - Math.log(st.min))));
};
const rangeBar = (label, st, fmt, note) => !st ? '' : html`<div class="rb ex-reveal" data-x="${pos(st.value, st)}" data-a="${pos(st.p25, st)}" data-b="${pos(st.p75, st)}" data-m="${pos(st.median, st)}">
  <div class="rb-head"><b>${label}</b><span class="rb-val">${fmt(st.value)}</span></div>
  <div class="rb-track"><i class="rb-band"></i><i class="rb-med"></i><i class="rb-dot"></i></div>
  <div class="rb-scale"><span>${fmt(st.min)}</span><span>most are ${fmt(st.p25)} to ${fmt(st.p75)}</span><span>${fmt(st.max)}</span></div>
  <p class="rb-note">${note}</p></div>`;

// Signal Score radar: five axes, one per part; parts with no data sit at the centre and are labelled.
function radar(parts) {
  const keys = Object.keys(PARTS), C = 150, R = 80, pt = (i, f) => { const a = (-90 + i * (360 / keys.length)) * Math.PI / 180; return [C + R * f * Math.cos(a), C + R * f * Math.sin(a)]; };
  const poly = f => keys.map((_, i) => pt(i, f).map(n => n.toFixed(1)).join(',')).join(' ');
  const shape = keys.map((k, i) => pt(i, (parts[k] == null ? 0 : parts[k]) / 100).map(n => n.toFixed(1)).join(',')).join(' ');
  return html`<svg class="radar" viewBox="0 0 300 300" role="img" aria-label="Signal Score parts: ${keys.map(k => PARTS[k][0] + ' ' + (parts[k] == null ? 'no data' : parts[k])).join(', ')}">
    ${[.25, .5, .75, 1].map(f => html`<polygon class="r-grid" points="${poly(f)}"/>`)}
    ${keys.map((_, i) => html`<line class="r-axis" x1="${C}" y1="${C}" x2="${pt(i, 1)[0].toFixed(1)}" y2="${pt(i, 1)[1].toFixed(1)}"/>`)}
    <g class="r-shape"><polygon class="r-fill" points="${shape}"/>${keys.map((k, i) => parts[k] == null ? '' : html`<circle class="r-dot" cx="${pt(i, parts[k] / 100)[0].toFixed(1)}" cy="${pt(i, parts[k] / 100)[1].toFixed(1)}" r="4"/>`)}</g>
    ${keys.map((k, i) => { const [x, y] = pt(i, 1.22); return html`<text class="r-label ${parts[k] == null ? 'off' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${x < C - 8 ? 'end' : x > C + 8 ? 'start' : 'middle'}" dominant-baseline="middle">${PARTS[k][0]}</text>`; })}
  </svg>`;
}

const flow = modality => {
  const [i, o] = String(modality || '').includes('->') ? modality.split('->') : [modality || '', ''];
  const chips = s => String(s).split('+').map(x => x.trim().toLowerCase()).filter(Boolean).map(x => html`<span class="mod">${MODAL[x] || x}</span>`);
  return o ? html`<div class="flow ex-reveal"><div class="flow-in">${chips(i)}</div><svg viewBox="0 0 24 24" class="flow-arrow" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg><div class="flow-out">${chips(o)}</div></div>`
    : html`<div class="flow ex-reveal"><div class="flow-in">${chips(i)}</div></div>`;
};

export function explainer(d) {
  const m = d.model, s = d.signal, p = d.peers || {}, api = isApi(m), name = shortName(m.id).split('/').pop();
  const who = m.company || m.creator || 'an unknown publisher', task = TASK[m.pipeline];
  const dateWord = dateLabel(m);
  const sentence = `${name} is ${api ? 'a closed model that you use through an API' : 'an open-weight model whose files you can download'}, published by ${who}${task ? `, and built for ${task[0]}` : ''}.`
    + (!api && m.params ? ` It has ${m.params} parameters.` : '') + (m.released_at ? ` ${dateWord}: ${day(m.released_at)}.` : '');
  const ctx = m.context_length;
  const caps = m.capabilities.filter(c => CAP[c]);
  const hasPrice = m.price_in != null && m.price_out != null;

  const tiles = html`<div class="ex-tiles">
    <div class="ex-tile ex-reveal">${icon('cube')}<span class="k">Type</span><b>${api ? 'Closed model, via API' : 'Open weights'}</b><p>${api ? 'You send requests to the provider; the model files are not public.' : (m.license ? `Files are public under the ${m.license} license.` : 'Files are public. Check the license before using it.')}</p></div>
    <div class="ex-tile ex-reveal">${icon('chip')}<span class="k">Size</span><b>${api ? 'Not published' : (m.params || 'Not listed')}</b><p>Parameters are the numbers a model learns. More usually means more capable, and slower and costlier to run.</p></div>
    <div class="ex-tile ex-reveal">${icon('page')}<span class="k">Context window</span><b>${ctx ? ctxLabel(ctx) : 'Not listed'}</b><p>${ctx ? `How much it can read at once: ${pages(ctx)} of text.` : 'How much text it can read at once. The sources do not state it for this model.'}</p></div>
    <div class="ex-tile ex-reveal">${icon(api ? 'coin' : 'gift')}<span class="k">Price</span><b>${api ? (hasPrice ? `${money(m.price_in)} in / ${money(m.price_out)} out` : 'Not listed') : 'Free to download'}</b><p>${api ? (hasPrice ? 'Per 1 million tokens. A token is about three quarters of a word.' : 'No price is listed in the sources we read.') : 'You pay for the computer that runs it, or for a host that serves it.'}</p></div>
  </div>`;

  const abilities = html`<section class="ex-card panel ex-reveal"><h2>What it can do</h2>
    ${task ? html`<p class="ex-lead2"><b>${task[0][0].toUpperCase() + task[0].slice(1)}.</b> ${task[1]}</p>` : (m.pipeline ? html`<p class="ex-lead2">Task label from the source: <b>${m.pipeline}</b>.</p>` : '')}
    ${m.modality ? html`<h3 class="ex-h">What goes in and what comes out</h3>${flow(m.modality)}` : ''}
    ${caps.length ? html`<h3 class="ex-h">Listed abilities</h3><ul class="abil">${caps.map(c => html`<li><b>${c === 'tool-use' ? 'Tool use' : 'Reasoning'}</b><span>${CAP[c]}</span></li>`)}</ul>` : ''}
    ${!task && !m.pipeline && !m.modality && !caps.length ? html`<p class="na">The sources we read do not describe what this model can do.</p>` : html`<p class="fine">Abilities come from what the sources state (task labels, tags, supported inputs). They are not tested by SignalStack. See benchmark results below when available.</p>`}
  </section>`;

  const barRows = Object.keys(PARTS).map((k, i) => html`<div class="part2" data-i="${i}"><div class="p-top"><b>${PARTS[k][0]}</b><span class="p-w">${Math.round((s.weights ? s.weights[k] : 0) * 100)}% of score</span><span class="p-v">${s.parts[k] == null ? 'No data' : s.parts[k]}</span></div>
    <span class="track2"><i data-v="${s.parts[k] == null ? 0 : s.parts[k]}"></i></span><p>${s.parts[k] == null ? html`${MISSING[k]} Left out of the score, not counted as zero.` : PARTS[k][1]}</p></div>`);
  const score = html`<section class="ex-card panel ex-reveal ex-score"><h2>Signal Score</h2>
    <div class="score-head"><div class="ringbox"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-bg" cx="60" cy="60" r="52"/><circle class="ring-fg" cx="60" cy="60" r="52" data-score="${s.score}"/></svg><b data-count="${s.score}">${s.score}</b></div>
      <div><span class="imp imp-${String(s.importance).toLowerCase()}">${s.importance}</span><p class="detail">SignalStack’s own estimate of how much attention this deserves right now, from 0 to 100. It is built from the five parts below.</p></div></div>
    <div class="score-body">${radar(s.parts)}<div class="parts2">${barRows}</div></div>
    ${s.why.length ? html`<h3 class="ex-h">What went into it</h3><ul class="why2">${s.why.map(w => html`<li>${w}</li>`)}</ul>` : ''}
    <p class="fine">A heuristic, not an objective measure. Parts with no evidence are left out and the rest are re-weighted.</p></section>`;

  let market;
  if (api) {
    market = html`<section class="ex-card panel ex-reveal"><h2>Price and context</h2>
      ${hasPrice || ctx ? '' : html`<p class="na">No price or context window is listed for this model.</p>`}
      ${m.price_in === 0 && m.price_out === 0 ? html`<p class="ex-lead2"><b>Listed as free.</b> Free tiers can change or be rate-limited.</p>` : ''}
      ${rangeBar('Input price per 1M tokens', p.price_in, money, `Cheaper than ${100 - (p.price_in || {}).percentile}% of ${(p.price_in || {}).n} ${p.group}.`)}
      ${rangeBar('Output price per 1M tokens', p.price_out, money, `Cheaper than ${100 - (p.price_out || {}).percentile}% of ${(p.price_out || {}).n} ${p.group}.`)}
      ${rangeBar('Context window', p.context, compact, `Larger than ${(p.context || {}).percentile}% of ${(p.context || {}).n} ${p.group}. That is ${ctx ? pages(ctx) : ''} of text.`)}
      ${hasPrice && (m.price_in > 0 || m.price_out > 0) ? html`<h3 class="ex-h">Estimate your cost</h3>
        <div class="calc" data-pin="${m.price_in}" data-pout="${m.price_out}">
          <label>Input tokens per request<input id="c-in" type="number" min="0" step="100" value="2000" inputmode="numeric"></label>
          <label>Output tokens per request<input id="c-out" type="number" min="0" step="100" value="500" inputmode="numeric"></label>
          <label>Requests per day<input id="c-n" type="number" min="0" step="100" value="1000" inputmode="numeric"></label>
          <div class="calc-out"><div><span>Per request</span><b id="r-one"></b></div><div><span>Per 1,000 requests</span><b id="r-k"></b></div><div><span>Per 30 days</span><b id="r-mo"></b></div></div></div>
        <p class="fine">An example only. It multiplies the listed per-million-token prices. Real bills depend on the provider, caching, rate limits and extra fees.</p>` : ''}
      ${m.price_source === 'openrouter' || m.context_source === 'openrouter' ? html`<p class="fine">Figures come from OpenRouter’s catalogue, which can differ from the provider’s own.</p>` : ''}
    </section>`;
  } else {
    market = html`<section class="ex-card panel ex-reveal"><h2>Size and popularity</h2>
      ${rangeBar('Size (parameters)', p.size, compact, `Larger than ${(p.size || {}).percentile}% of ${(p.size || {}).n} ${p.group}.`)}
      ${rangeBar('Likes', p.likes, v => num(Math.round(v)), `More liked than ${(p.likes || {}).percentile}% of ${(p.likes || {}).n} ${p.group}.`)}
      ${rangeBar('Downloads', p.downloads, v => num(Math.round(v)), `More downloaded than ${(p.downloads || {}).percentile}% of ${(p.downloads || {}).n} ${p.group}.`)}
      ${p.size || p.likes || p.downloads ? '' : html`<p class="na">There are not enough similar models yet to compare this one fairly.</p>`}
      <p class="fine">Compared with ${p.group || 'similar models'} that SignalStack tracks. This is a comparison within our own list, not the whole of Hugging Face.</p></section>`;
  }

  return html`<section class="ex-hero ex-reveal"><span class="ex-kicker">In plain English</span><p class="ex-sentence">${sentence}</p>${tiles}
    <p class="fine">Written from the facts on this page with fixed wording. It is not an AI-generated review.</p></section>
    <div class="ex-grid">${abilities}${market}</div>${score}`;
}

// Wires up the animation and the calculator after the page is in the DOM.
export function animateExplainer(root) {
  const calm0 = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!calm0) root.classList.add('ex-armed'); // hidden-until-seen only once the script is running, so the page is complete without it
  const setBars = () => {
    root.querySelectorAll('.track2 i').forEach(el => el.style.setProperty('--v', (+el.dataset.v || 0) + '%'));
    root.querySelectorAll('.part2').forEach(el => el.style.setProperty('--i', el.dataset.i));
    const C = 2 * Math.PI * 52;
    root.querySelectorAll('.ring-fg').forEach(el => { el.style.setProperty('--len', C.toFixed(1)); el.style.setProperty('--off', (C * (1 - (+el.dataset.score || 0) / 100)).toFixed(1)); });
    root.querySelectorAll('.rb').forEach(el => {
      el.style.setProperty('--x', el.dataset.x + '%'); el.style.setProperty('--m', el.dataset.m + '%');
      el.style.setProperty('--a', el.dataset.a + '%'); el.style.setProperty('--w', Math.max(2, +el.dataset.b - +el.dataset.a) + '%');
    });
  };
  setBars();
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show = el => {
    el.classList.add('in');
    el.querySelectorAll('[data-count]').forEach(n => countUp(n, calm));
  };
  const targets = [...root.querySelectorAll('.ex-reveal')];
  if (!('IntersectionObserver' in window) || calm) targets.forEach(show);
  else {
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } }), { threshold: .2 });
    targets.forEach((el, i) => { el.style.setProperty('--d', Math.min(i, 6) * 60 + 'ms'); io.observe(el); });
    setTimeout(() => targets.forEach(el => { if (!el.classList.contains('in') && el.getBoundingClientRect().top < innerHeight) show(el); }), 50);
  }
  const calc = root.querySelector('.calc');
  if (calc) {
    const pin = +calc.dataset.pin, pout = +calc.dataset.pout, v = id => Math.max(0, +root.querySelector(id).value || 0);
    const run = () => {
      const one = (v('#c-in') / 1e6) * pin + (v('#c-out') / 1e6) * pout, n = v('#c-n');
      root.querySelector('#r-one').textContent = money(one); root.querySelector('#r-k').textContent = money(one * 1000); root.querySelector('#r-mo').textContent = money(one * n * 30);
    };
    calc.addEventListener('input', run); run();
  }
}

function countUp(el, calm) {
  const to = +el.dataset.count; if (calm || !(to > 0)) return;
  const t0 = performance.now();
  (function step(now) { const k = Math.min((now - t0) / 1000, 1); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); })(t0);
}

// One-line "what is it" used by the hover preview, from the same fixed wording as the full page.
export function plainLine(m) {
  const api = isApi(m), task = TASK[m.pipeline], who = m.company || m.creator || 'an unknown publisher';
  return `${api ? 'A closed model used through an API' : 'An open-weight model you can download'} from ${who}${task ? `, built for ${task[0]}` : ''}.`;
}
