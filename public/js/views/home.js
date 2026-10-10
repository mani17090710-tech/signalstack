// Home ("AI Now"): what matters right now, ranked by Signal Score, with the source and time on every item.
import { api, html, num, ago, pageHead, signalCard, modelCard, empty, checked, verLegend, safeUrl, host, stamp, verBadge } from '../lib.js';

export async function render() {
  const d = await api('/now');
  const none = !d.top.length && !d.newModels.length && !d.papers.length;
  return {
    title: 'Now',
    html: html`<div class="hero-now">${pageHead('AI right now', `Ranked by Signal Score, from the last ${d.usedWindow === '24h' ? '24 hours' : '7 days'}. Every item links to its source.`, checked(d.lastChecked))}
      <p class="snapshot"><span><b>${num(d.counts.last24h)}</b>signals in 24 h</span><span><b>${num(d.counts.significant)}</b>scoring 60 or higher</span><span><b>${num(d.counts.models)}</b>models tracked</span><span><b>${num(d.counts.papers)}</b>paper${d.counts.papers === 1 ? '' : 's'} collected</span></p></div>
      ${none ? empty('Collecting data', 'The first update starts shortly after the server boots and can take a few minutes. Check back soon.', html`<button data-action="reload">Refresh</button>`) : ''}
      ${verLegend()}
      ${d.top.length ? html`<section class="blk"><header><h2>Top signals</h2><a href="#signals">All signals</a></header><div class="stack">${d.top.map(signalCard)}</div></section>` : ''}
      ${d.newModels.length ? html`<section class="blk"><header><h2>New from the labs</h2><a href="#models">Model Universe</a></header><div class="grid">${d.newModels.slice(0, 6).map(modelCard)}</div></section>` : ''}
      ${d.trending.length ? html`<section class="blk"><header><h2>Trending on Hugging Face</h2><span class="checked">Community ranking</span></header><div class="grid">${d.trending.slice(0, 6).map(modelCard)}</div></section>` : ''}
      ${d.papers.length ? html`<section class="blk"><header><h2>New research</h2><a href="#research">All papers</a></header><div class="panel rows">${d.papers.map(p => html`<div><h3>${safeUrl(p.url) ? html`<a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.title}</a>` : p.title}</h3>
        <p class="meta">${host(p.url) || 'arXiv'}, published ${stamp(p.published_at || p.date)}, checked ${ago(p.retrieved_at)} ${verBadge(p.verification)}</p></div>`)}</div></section>` : ''}
      <p class="checked">Want the intro again? <button class="link" data-action="intro">Replay it</button></p>`,
  };
}
