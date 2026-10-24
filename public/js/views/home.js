// Now: a short daily briefing. One lead story, then the most important items grouped as Models, Papers and Lab updates.
// Ranking is importance plus recency (see the note at the bottom). Everything links to its original source.
import { api, html, num, pageHead, leadCard, signalRow, modelCard, empty, checked, verLegend, trustBar, state, mount, $ } from '../lib.js';

const SEE_ALL = { models: 'cat=Model Release,Trending', papers: 'cat=Research', labs: 'cat=Announcement,Open Source' };
const TITLE = { models: ['Models today', 'Models this week'], papers: ['Papers today', 'Papers this week'], labs: ['Lab updates today', 'Lab updates this week'] };

// "Watching": what is new from the labs, model series and models you follow. Guests see an invitation instead.
const watchingView = w => {
  const chips = [...w.follows.labs.map(l => html`<a href="#company/${l.id}">${l.name}</a>`), ...w.follows.families.map(f => html`<a href="#family/${f.key.split(':')[0]}/${encodeURIComponent(f.key.split(':')[1])}">${f.label}</a>`), ...(w.follows.models ? [html`<a href="#watchlist">${w.follows.models} model${w.follows.models === 1 ? '' : 's'} watched</a>`] : [])];
  if (!chips.length) return html`<div class="watching"><h2>Watching</h2><p class="sub">Follow a lab or a model series and what is new from it shows up here. Or watch a single model from its page.</p><div class="labact"><a class="btn-src" href="#companies">Choose labs to follow</a><a class="btn-sec" href="#models">Browse models</a></div></div>`;
  return html`<div class="watching"><header class="phead-sm"><h2>Watching <span class="cnt">${w.total}</span></h2><a href="#you">Manage</a></header><div class="watch-chips">${chips}</div>
    ${w.items.length ? html`<div class="rows-sig">${w.items.map(signalRow)}</div>` : html`<p class="sub">Nothing new from what you follow in the last 30 days.</p>`}</div>`;
};
const watchingGuest = html`<div class="watching"><h2>Watching</h2><p class="sub">Log in to follow labs and model series. What is new from them will show up here, ahead of everything else.</p><div class="labact"><button class="pri" data-action="login">Log in</button><button data-action="signup">Sign up</button><a class="btn-sec" href="#companies">Browse labs</a></div></div>`;

export async function render() {
  const d = await api('/now');
  const none = !d.lead && !d.groups.length;
  const win = d.usedWindow === '24h' ? 'the last 24 hours' : 'the last 7 days';
  return {
    title: 'Now',
    html: html`<div class="hero-now">${pageHead('Today in AI', `The few things that matter right now, from ${win}, most important first.`, checked(d.lastChecked))}
      <p class="snapshot"><span><b>${num(d.counts.last24h)}</b>signals in 24 h</span><span><b>${num(d.counts.significant)}</b>scoring 60 or higher</span><span><b>${num(d.counts.models)}</b>models tracked</span><span><b>${num(d.counts.papers)}</b>paper${d.counts.papers === 1 ? '' : 's'} collected</span></p>
      ${trustBar({ week: d.counts.week, sources: d.counts.sources, lastChecked: d.lastChecked })}
      <p class="guide"><b>Now</b> is the short briefing. <a href="#signals">Signals</a> is the full feed with filters${d.counts.last24h ? html`, ${num(d.counts.last24h)} in the last day` : ''}.</p></div>
      ${none ? empty('Collecting data', 'The first update starts shortly after the server boots and can take a few minutes. Check back soon.', html`<button class="pri" data-action="reload">Refresh</button>`) : ''}
      ${verLegend()}
      ${d.lead ? html`<section class="blk"><header><h2>Top story</h2><a href="#signals">All signals</a></header>${leadCard(d.lead)}</section>` : ''}
      <section class="blk" id="watching" aria-live="polite"></section>
      ${d.groups.map(g => html`<section class="blk"><header><h2>${TITLE[g.id][g.window === '24h' ? 0 : 1]} <span class="cnt">${num(g.total)}</span></h2><a href="#signals/${encodeURIComponent(SEE_ALL[g.id] + '&window=' + (g.window === '24h' ? '24h' : '7d'))}">See all ${num(g.total)}</a></header>
        <div class="rows-sig">${g.items.map(signalRow)}</div></section>`)}
      ${d.trending.length ? html`<section class="blk"><header><h2>Trending on Hugging Face</h2><a href="#models">Model Universe</a></header><div class="grid">${d.trending.slice(0, 3).map(modelCard)}</div></section>` : ''}
      <details class="legend rankinfo"><summary>How Now is ranked</summary><p>Each item has a Signal Score from 0 to 100 (its importance). Now fades that score as the item ages, so a fresh 75 appears above a day-old 85. A model or source appears once. Nothing here is hand-picked, and a score is an estimate, not a verdict.</p></details>
      <p class="checked">Want the intro again? <button class="link" data-action="intro">Replay it</button></p>`,
    after(root) {
      const box = $('#watching', root); if (!box) return;
      state.whoReady.then(async () => {
        if (!root.contains(box)) return;
        if (!state.me) return mount(box, watchingGuest);
        try { mount(box, watchingView(await api('/watching'))); } catch (e) { box.remove(); }
      });
    },
  };
}
