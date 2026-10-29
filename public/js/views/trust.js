// Trust pages: About, Methodology, Data Sources, Changelog, Contact / Report an issue, and the "Why trust Signalstack?" panel.
// Every number here comes from the live site (score weights, check interval, source counts); nothing is hard-coded that could drift.
import { api, html, pageHead, state, VER, num, ago, stamp, mount, $, empty } from '../lib.js';

const LEGAL_DATE = '27 October 2026';

// The short version, shown on Now and on About. Each point links to the page that proves it.
export const whyTrust = () => html`<section class="why-trust" aria-labelledby="wt-h"><header><h2 id="wt-h">Why trust Signalstack?</h2><a href="#methodology">Read the methodology</a></header>
  <div class="wt-grid">
    <article><span class="wt-ico" aria-hidden="true">↗</span><h3>Every item links to its original source</h3><p>Each signal has an “Open original source” link to the lab, repository, paper or catalogue it came from. If we have no link, we say so instead of hiding it.</p></article>
    <article><span class="wt-ico" aria-hidden="true">✓</span><h3>Verification levels are always visible</h3><p>${Object.values(VER).slice(0, 3).map(v => html`<span class="wt-v">${v[0]} ${v[1]}</span>`)} A catalogue listing is never presented as an official release.</p></article>
    <article><span class="wt-ico" aria-hidden="true">≡</span><h3>Scores are transparent</h3><p>Open “Why this score” on any card to see each part, its weight and the evidence behind it. A part with no data is left out, never counted as zero.</p></article>
  </div></section>`;

export const about = {
  async render() {
    return {
      title: 'About',
      html: html`${pageHead('About Signalstack', 'A source-checked view of new AI models, papers and releases.')}
      <div class="prose">
        <p>Signalstack watches the places where AI work is first published (lab websites, Hugging Face, arXiv, GitHub releases and a public model catalogue) and turns what it finds into one feed. Every item shows where it came from and how far that source can be trusted.</p>
        <h2>What it is for</h2>
        <ul><li>Seeing what is new in AI today, without reading ten feeds.</li><li>Checking whether a release is official or only listed somewhere.</li><li>Following the labs and model families you care about.</li></ul>
        <h2>What it does not do</h2>
        <ul><li>It does not claim to list every model or paper that exists.</li><li>It does not use AI to write its explanations. The “Why this matters” notes are built from the data by fixed rules, and any note written by hand is labelled as written by the SignalStack team.</li><li>It does not give investment, legal or technical advice.</li></ul>
      </div>
      ${whyTrust()}
      <div class="prose"><p>Questions, corrections or missing sources? <a href="#contact">Get in touch</a> or <a href="#report">report an issue</a>.</p></div>`,
    };
  },
};

export const methodology = {
  async render(arg) {
    let src = null; try { src = await api('/sources/public'); } catch (e) { /* the page still explains everything else */ }
    const sc = (state.status && state.status.score) || { weights: { freshness: .15, relevance: .25, technical: .2, popularity: .2, impact: .2 }, significant: 60, major: 80 };
    const W = { freshness: 'Freshness', relevance: 'Relevance', technical: 'Technical importance', popularity: 'Popularity', impact: 'Impact' };
    return {
      title: 'Methodology',
      html: html`${pageHead('Methodology', 'How Signalstack finds, checks and scores what it shows.')}
      <div class="prose">
        <h2>1. Finding things</h2>
        <p>Signalstack reads ${src ? html`<b>${num(src.total)}</b> sources` : 'its sources'} automatically${src ? html`, about every <b>${src.intervalMin}</b> minutes` : ''}. See <a href="#sources">Data Sources</a> for the full list by type. Finding something in a feed does not make it official; that is what verification is for.</p>
        <h2 id="badges">2. Verification levels (the badges)</h2>
        <dl class="vdl">${Object.values(VER).map(v => html`<dt>${v[0]} ${v[1]}</dt><dd>${v[2]}</dd>`)}</dl>
        <h2 id="score">3. The Signal Score</h2>
        <p>Each signal gets a score from 0 to 100, the weighted average of the parts below. A part with no data is skipped and the other weights are scaled up, so missing data never counts as zero. Open “Why this score” on any card to see the real numbers for that item.</p>
        <table class="wtable"><thead><tr><th>Part</th><th>What it measures</th><th>Weight</th></tr></thead><tbody>
          ${[['freshness', 'How new it is. Fades over about three days.'], ['relevance', 'How closely it is tied to a lab we track.'], ['technical', 'Model size or context window, or version size of a release.'], ['popularity', 'Likes and downloads, where they are public.'], ['impact', 'Downloads per day since release, where public.']].map(([k, d]) => html`<tr><td>${W[k]}</td><td>${d}</td><td>${Math.round((sc.weights[k] || 0) * 100)}%</td></tr>`)}</tbody></table>
        <p><b>Normal</b> is under ${sc.significant}, <b>Important</b> is ${sc.significant} to ${sc.major - 1}, and <b>Major</b> is ${sc.major} or higher. Closed models have no public likes or downloads, so for them Popularity and Impact read “No public adoption data available yet.” and are left out.</p>
        <h3 id="freshness">Freshness decay</h3>
        <p>Freshness starts at 100 when something is published and falls smoothly as it ages: about <b>72</b> after one day, <b>37</b> after three days and <b>10</b> after a week. That is why a day-old release can outrank an older one with a similar score.</p>
        <p>Evidence quality (the verification level of the source) is shown next to the score for transparency. It does not change the number.</p>
        <h2>4. Human corrections</h2>
        <p>The SignalStack team can change a score, mark a signal Major, hide a bad signal, rewrite a note, or add a signal the crawler missed. A changed score shows both the team’s value and the calculated one, a rewritten note says it was written by the team, and a hand-added signal is marked Source Verified only when its link is on the lab’s own website.</p>
        <h2>5. Ranking on Now</h2>
        <p>Now shows the highest-scoring items first, fading each score as the item ages, so a fresh 75 can appear above a three-day-old 85.</p>
        <h2>6. Limits</h2>
        <ul><li>Coverage depends on the sources we watch. Some things will be missed or arrive late.</li><li>The score is our estimate, not an objective measure of quality.</li><li>If a source is down we keep the last good data and show when it was last updated.</li></ul>
        <p>Found a mistake? <a href="#report">Report an issue</a>.</p>
      </div>`,
      after() { const t = arg && document.getElementById(arg); if (t) requestAnimationFrame(() => t.scrollIntoView({ block: 'start' })); },
    };
  },
};

export const sources = {
  async render() {
    const d = await api('/sources/public');
    return {
      title: 'Data Sources',
      html: html`${pageHead('Data Sources', 'Where the information comes from.')}
      <div class="prose"><p>Signalstack currently watches <b>${num(d.total)}</b> sources, checked about every <b>${d.intervalMin}</b> minutes${d.lastRun ? html`. Last check: <b title="${stamp(d.lastRun)}">${ago(d.lastRun)}</b>` : ''}. Sources are grouped by type below. How we treat each type is explained in the <a href="#methodology">methodology</a>.</p></div>
      <div class="src-groups">${d.groups.map(g => html`<article class="panel src-g"><header><h3>${g.label}</h3><span class="cnt">${g.count}</span></header>
        <p class="sg-state ${g.healthy === g.count ? 'ok' : ''}">${g.healthy} of ${g.count} responding${g.lastOk ? html` · last good check ${ago(g.lastOk)}` : ''}</p>
        ${g.examples.length ? html`<ul class="plain">${g.examples.map(x => html`<li>${x}</li>`)}${g.count > g.examples.length ? html`<li class="dim">and ${g.count - g.examples.length} more</li>` : ''}</ul>` : ''}</article>`)}</div>
      <div class="prose"><p>Is a source missing? <a href="#contact">Tell us</a>. You can also use the data yourself through the <a href="#api">API and RSS feed</a>.</p></div>`,
    };
  },
};

// What changed and when, in plain words. Newest first.
const CHANGES = [
  ['29 Oct 2026', ['Signals: search by name, filters for source, evidence level, topic and minimum score, and sort by Newest, Highest signal or Trending. Your filters are remembered.', 'Every signal has its own shareable page with a preview card. A live status strip shows the last crawl, sources checked and failures.', 'Report a wrong or outdated signal from its card, and a weekly newsletter signup.']],
  ['27 Oct 2026', ['Compact and Detailed views for the Signals feed, a Why trust Signalstack? section, and About, Methodology, Data Sources, Changelog and Contact pages.', 'Saved pages show while the server wakes up, with an “Updating signals…” notice and a Retry button.', 'Phone navigation: Now, Signals, Models, Search and More. Search remembers recent searches and opens with the / key.', 'Clearer score explanations, including evidence quality.', 'Faster intro, a Top signal card on Now, and Signals falls back to the last 7 days when a short window is empty.', 'Admin: signal moderation (score, Major, hide, notes, add by hand), overview numbers, and source management.']],
  ['26 Oct 2026', ['Lab radar: which labs are active, their last signal and the sources we watch for each.', 'Models sorted best first, research lab chips, best-in-row marks on Compare, and a detailed Why this score.']],
  ['25 Oct 2026', ['Email digest (daily or weekly) with live preview and one-click unsubscribe.', 'Public API, RSS feed and an embeddable widget.', '“Why this matters” notes and saved collections.']],
  ['24 Oct 2026', ['Now became a daily briefing. Source provenance on every card. Follow labs and model series. Instant search suggestions.', 'Faster loading and better empty and error states.']],
  ['20 Oct 2026', ['Model pages explain the model in plain English, with price and size comparisons. Hover previews for models.']],
  ['12 Oct 2026', ['Discovery is separate from verification, and paper links need evidence.']],
];
export const changelog = {
  async render() {
    return { title: 'Changelog', html: html`${pageHead('Changelog', 'What changed in Signalstack, newest first.')}
      <div class="prose changelog">${CHANGES.map(([d, items]) => html`<section><h2>${d}</h2><ul>${items.map(i => html`<li>${i}</li>`)}</ul></section>`)}</div>` };
  },
};

// One form for Contact and Report an issue. The page the person came from can be passed as #report/<address>.
const KINDS = { issue: 'Something is broken or wrong on the site', data: 'A model, paper or signal has wrong or missing information', contact: 'A question or suggestion', other: 'Something else' };
const form = (kind, page) => html`<form class="panel rform" id="rf" novalidate>
  <label for="rk">What is this about?</label><select id="rk" name="kind">${Object.entries(KINDS).map(([k, l]) => html`<option value="${k}" ${k === kind ? 'selected' : ''}>${l}</option>`)}</select>
  <label for="rm">Message</label><textarea id="rm" name="message" rows="6" maxlength="2000" required placeholder="What happened? Include the model, paper or signal name if it is about one."></textarea>
  <label for="rp">Page or link (optional)</label><input id="rp" name="page" maxlength="300" value="${page}" placeholder="https://… or the name of the page">
  <label for="rc">Your email (optional, only if you want a reply)</label><input id="rc" name="contact" type="email" maxlength="120" autocomplete="email">
  <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  <p class="fine">Your message is stored so we can fix the problem. We use your email only to reply. See the <a href="/privacy">Privacy Policy</a>.</p>
  <p class="rerr" id="rerr" role="alert" hidden></p>
  <button class="pri" type="submit" id="rsend">Send message</button></form>`;
const contactView = (title, sub, kind0) => ({
  async render(arg) {
    const page = decodeURIComponent(arg || ''), kind = /\/s\/\d+/.test(page) ? 'data' : kind0;
    return {
      title,
      html: html`${pageHead(title, sub)}<div id="rbox">${form(kind, page)}</div>`,
      after(root) {
        const f = $('#rf', root); if (!f) return;
        f.onsubmit = async e => {
          e.preventDefault(); const err = $('#rerr', root), btn = $('#rsend', root), v = Object.fromEntries(new FormData(f));
          err.hidden = true; btn.disabled = true; btn.textContent = 'Sending…';
          try { await api('/report', 'POST', v); mount($('#rbox', root), empty('Thank you', 'Your message was sent. If you left an email address we may write back.', html`<a class="btn-sec" href="#now">Back to Now</a>`, 'signal')); }
          catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Send message'; }
        };
      },
    };
  },
});
export const contact = contactView('Contact', 'Questions, corrections or suggestions are welcome.', 'contact');
export const report = contactView('Report an issue', 'Tell us what is wrong and we will look into it.', 'issue');

export { LEGAL_DATE };
