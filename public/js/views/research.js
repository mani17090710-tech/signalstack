// Research: papers from arXiv, with the labs they mention and the source on each.
import { api, html, pageHead, empty, skeleton, mount, $, stamp, ago, verBadge, safeUrl, host } from '../lib.js';
let COMPANY_NAMES = {};

const f = { q: '', company: '' };
let rows = 0, total = 0, token = 0;

const paper = p => html`<article class="sig"><div class="sig-main"><div class="tags"><span class="tag">${p.category || 'Paper'}</span>${p.entities.map(c => html`<a class="tag co" href="#company/${c}">${COMPANY_NAMES[c] || c}</a>`)}${verBadge(p.verification)}</div>
  <h3>${safeUrl(p.url) ? html`<a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.title}</a>` : p.title}</h3>
  ${p.authors ? html`<p class="detail">${p.authors}</p>` : ''}${p.summary ? html`<p class="detail">${p.summary.slice(0, 280)}${p.summary.length > 280 ? '…' : ''}</p>` : ''}
  <p class="src"><span>${host(p.url) || 'arXiv'}</span><span>Published ${stamp(p.published_at)}</span><span>Checked ${ago(p.retrieved_at)}</span></p></div></article>`;

export async function render() {
  const cos = await api('/companies');
  COMPANY_NAMES = Object.fromEntries(cos.map(c => [c.id, c.name]));
  return {
    title: 'Research',
    html: html`${pageHead('Research', 'Recent papers from arXiv (language, machine learning, AI and vision). Labs are listed only where the title or abstract names them.')}
      <div class="toolbar"><input id="rq" type="search" placeholder="Search title, author or topic" value="${f.q}" aria-label="Search papers"><select id="rco" aria-label="Lab mentioned"><option value="">Any lab mentioned</option>${cos.map(c => html`<option value="${c.id}" ${f.company === c.id ? 'selected' : ''}>${c.name}</option>`)}</select></div>
      <p class="checked" id="rcount"></p><div id="rlist">${skeleton(3)}</div><p><button id="rmore" hidden>Load more</button></p>`,
    after(root) {
      const load = async more => {
        const my = ++token, list = $('#rlist', root); if (!more) { rows = 0; mount(list, skeleton(3)); }
        try {
          const d = await api('/papers?' + new URLSearchParams({ limit: 20, offset: rows, ...(f.q && { q: f.q }), ...(f.company && { company: f.company }) })); if (my !== token) return;
          total = d.total; const cards = d.items.map(paper);
          if (more) list.firstElementChild.insertAdjacentHTML('beforeend', cards.join('')); else mount(list, d.items.length ? html`<div class="stack">${cards}</div>` : empty('No papers match', 'Clear the search or choose another lab.'));
          rows += d.items.length; $('#rmore', root).hidden = rows >= total; $('#rcount', root).textContent = `Showing ${rows.toLocaleString()} of ${total.toLocaleString()}`;
        } catch (e) { if (my === token) mount(list, empty('Couldn’t load papers', e.message)); }
      };
      let t; $('#rq', root).oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); };
      $('#rco', root).onchange = e => { f.company = e.target.value; load(); };
      root.addEventListener('click', e => { if (e.target.id === 'rmore') load(true); });
      load();
    },
  };
}
