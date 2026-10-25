// API and embed: documentation for the public, read-only JSON API, the RSS feed and the embeddable widget, with live samples.
import { api, html, pageHead, $, mount } from '../lib.js';
import { toast } from '../saved.js';

const ENDPOINTS = [
  ['/api/v1/now', 'The most important items right now (importance plus recency).', 'none'],
  ['/api/v1/signals', 'The full feed, newest first.', 'window (1h, 6h, 24h, 7d, 30d), cat (Model Release, Trending, Research, Open Source, Announcement; comma-separate several), company (lab id), verification, minScore (0 to 100), sort (time or score), limit (max 200), offset'],
  ['/api/v1/models', 'Tracked models.', 'q (name), company, cat, license, task, source (huggingface or api), verification, sort (new, trending, popular, downloads, params), limit, offset'],
  ['/api/v1/labs', 'The labs we follow, with their ids.', 'none'],
];
const copy = async (text, what = 'Copied') => { try { await navigator.clipboard.writeText(text); toast(what); } catch (e) { toast('Could not copy; select the text by hand'); } };

export async function render() {
  const origin = location.origin;
  const labs = await api('/v1/labs').catch(() => ({ data: [] }));
  return {
    title: 'API and embed',
    html: html`${pageHead('API and embed', 'Use Signalstack data on your own site or in your own tools. It is free and read-only, and every item links to its original source.')}
      <section class="panel apidoc"><h2>Terms of use</h2><ul class="plain"><li>Free to use, with up to 300 requests a minute per IP address. Please cache responses; they are refreshed about every 30 minutes.</li><li>Credit Signalstack when you republish items, and keep the link to the original source.</li><li>The service is provided as is, with no uptime promise. Fields can be added, but the version 1 fields shown here will not change meaning.</li><li>Signalstack does not own the underlying announcements, models or papers; follow each source’s own terms.</li></ul></section>
      <section class="blk"><header><h2>JSON API</h2></header>
        <div class="tw"><table><tr><th>Endpoint</th><th>What it returns</th><th>Parameters</th></tr>${ENDPOINTS.map(([p, d, q]) => html`<tr><td><code>${p}</code></td><td>${d}</td><td class="fine">${q}</td></tr>`)}</table></div>
        <p class="fine">Every response is <code>{ "data": [...], "meta": { "total", "generated_at", "attribution" } }</code>. Any website may call it from the browser (CORS is open).</p>
        <div class="apiex"><h3>Try it</h3><pre class="code" id="ex-curl">curl "${origin}/api/v1/signals?window=24h&amp;minScore=60&amp;limit=5"</pre><button data-copy="ex-curl">Copy</button>
          <pre class="code" id="ex-js">fetch("${origin}/api/v1/now").then(r =&gt; r.json()).then(d =&gt; console.log(d.data[0].title, d.data[0].source.url));</pre><button data-copy="ex-js">Copy</button>
          <h3>Live sample</h3><pre class="code sample" id="sample">Loading…</pre></div></section>
      <section class="blk"><header><h2>RSS feed</h2></header>
        <p class="sub">Follow it in any feed reader, or connect it to a Telegram, Slack or Discord feed bot. Build the address you want:</p>
        <div class="toolbar"><select id="fb-co" aria-label="Lab"><option value="">All labs</option>${labs.data.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select>
          <select id="fb-cat" aria-label="Type"><option value="">All types</option><option value="Model Release,Trending">Models</option><option value="Research">Papers</option><option value="Open Source,Announcement">Lab updates</option></select>
          <select id="fb-min" aria-label="Minimum score"><option value="">Any score</option><option value="60">Important (60+)</option><option value="80">Major only (80+)</option></select></div>
        <pre class="code" id="fb-url"></pre><div class="labact"><button data-copy="fb-url">Copy feed address</button><a class="btn-sec" id="fb-open" target="_blank" rel="noopener">Open feed</a></div></section>
      <section class="blk"><header><h2>Embeddable widget</h2></header>
        <p class="sub">A small list of the top items, ready to place on any page. It has no scripts and updates itself.</p>
        <div class="toolbar"><select id="em-n" aria-label="Items"><option>3</option><option selected>5</option><option>8</option><option>10</option></select><select id="em-th" aria-label="Theme"><option value="dark">Dark</option><option value="light">Light</option></select></div>
        <pre class="code" id="em-code"></pre><button data-copy="em-code">Copy snippet</button>
        <div class="embedprev"><iframe id="em-frame" title="Widget preview" loading="lazy"></iframe></div></section>`,
    after(root) {
      api('/v1/signals?limit=1').then(d => { $('#sample', root).textContent = JSON.stringify(d, null, 2).slice(0, 1800); }).catch(() => { $('#sample', root).textContent = 'The live sample could not be loaded.'; });
      const feed = () => { const a = new URLSearchParams(); const co = $('#fb-co', root).value, cat = $('#fb-cat', root).value, min = $('#fb-min', root).value; if (co) a.set('company', co); if (cat) a.set('cat', cat); if (min) a.set('minScore', min); a.set('window', '7d'); return `${origin}/feed.xml?${a}`; };
      const emb = () => { const n = $('#em-n', root).value, th = $('#em-th', root).value; return `${origin}/embed/now?limit=${n}&theme=${th}`; };
      const draw = () => {
        $('#fb-url', root).textContent = feed(); $('#fb-open', root).href = feed();
        const src = emb(); $('#em-code', root).textContent = `<iframe src="${src}" width="100%" height="${60 + Math.min(+$('#em-n', root).value, 10) * 62}" style="border:0" loading="lazy" title="AI news from Signalstack"></iframe>`;
        const f = $('#em-frame', root); if (f.getAttribute('src') !== src) f.setAttribute('src', src);
      };
      root.addEventListener('change', e => { if (e.target.closest('.toolbar')) draw(); });
      root.addEventListener('click', e => { const b = e.target.closest('[data-copy]'); if (b) copy($('#' + b.dataset.copy, root).textContent); });
      draw();
    },
  };
}
