// One signal on its own page (#signal/<id>). The shareable address is /s/<id>, which is the same content rendered by the server.
import { api, html, pageHead, leadCard, empty } from '../lib.js';

export async function render(id) {
  let s;
  try { s = await api('/signals/' + encodeURIComponent(id)); }
  catch (e) { if (e.code === 404) return { title: 'Signal not found', html: html`${pageHead('Signal not found')}${empty('That signal was not found', 'It may have been removed, or the link is wrong.', html`<a class="btn-sec" href="#signals">See all signals</a>`, 'signal')}` }; throw e; }
  return { title: s.title, html: html`<p class="crumb"><a href="#signals">← All signals</a></p>${leadCard(s)}` };
}
