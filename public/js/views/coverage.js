// How coverage works: what we track, how a model is found, and what each verification status means.
import { api, html, pageHead, VER, num, ago } from '../lib.js';

export async function render() {
  const c = await api('/coverage');
  const total = Object.values(c.models).reduce((a, b) => a + b, 0);
  return {
    title: 'How coverage works',
    html: html`${pageHead('How coverage works', 'What SignalStack tracks, where it comes from, and what “verified” means.')}
      <section class="panel"><h2>Finding is not verifying</h2>
        <p class="detail">A model can be found in a catalogue such as Hugging Face or OpenRouter. That only tells us it exists there. It earns a Verified badge when the provider’s own announcement or documentation says so. Catalogue listings never become Verified on their own.</p>
        <dl class="kv">${c.levels.map(l => html`<dt>${VER[l.id] ? VER[l.id][0] : ''} ${l.label}</dt><dd>${l.description} <b>${num(c.models[l.id] || 0)}</b> models</dd>`)}</dl></section>
      <section class="panel mt"><h2>What is covered</h2>
        <p class="detail">${num(total)} models and ${num(c.papers)} research papers so far. This is not every AI model or paper: Hugging Face is filtered to official lab releases and models with real likes, downloads or trending activity, OpenRouter lists the closed models it offers, and arXiv is limited to the AI and machine-learning categories we follow. Prices and context lengths are shown only when a source states them, with that source named. Last checked ${ago(c.lastChecked)}.</p></section>
      <section class="panel mt"><h2>Sources we check</h2>
        <div class="tw"><table><tr><th>Source</th><th>Type</th><th>Last run</th><th>Status</th></tr>${c.sources.map(s => html`<tr><td>${s.label}</td><td>${s.kind}</td><td>${s.last_run ? ago(s.last_run) : 'Not yet'}</td><td>${s.enabled ? (s.last_status || 'Pending') : 'Off'}</td></tr>`)}</table></div></section>
      <section class="panel mt"><h2>Models and papers</h2>
        <p class="detail">A model is linked to a paper only with evidence: the model’s own metadata cites the paper, the provider’s announcement lists it, or the paper names the model’s exact repository id. Similar names are never enough.</p></section>`,
  };
}
