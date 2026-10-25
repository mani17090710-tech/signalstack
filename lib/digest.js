'use strict';
// Daily and weekly digests: when one is due, and what it says. Pure functions, so the schedule and the wording can be tested without a server.
//
// Schedule: a person picks daily or weekly (weekly means Monday) and an hour in their own time zone. Because the host may sleep through the exact hour,
// a digest that is late is still sent once the server is awake, as long as it is not stale (36 h for daily, 72 h for weekly) and has not been sent for that slot.

const { esc } = require('./publicapi');
const SLOT_MS = { daily: 36 * 36e5, weekly: 72 * 36e5 };

// The most recent scheduled moment at or before `now`, as a UTC timestamp. offsetMin is the person's UTC offset in minutes (India is +330).
function lastSlot(prefs, now) {
  const off = (+prefs.tz_offset || 0) * 6e4, local = new Date(now + off);
  let slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), +prefs.hour || 0);
  if (slot > local.getTime()) slot -= 864e5;
  if (prefs.freq === 'weekly') { const dow = new Date(slot).getUTCDay(); slot -= ((dow + 6) % 7) * 864e5; } // back to Monday
  return slot - off;
}
function due(prefs, now = Date.now()) {
  if (!prefs || !['daily', 'weekly'].includes(prefs.freq)) return false;
  const slot = lastSlot(prefs, now), sent = prefs.last_sent ? Date.parse(String(prefs.last_sent).replace(' ', 'T') + 'Z') : 0;
  return now >= slot && now - slot <= SLOT_MS[prefs.freq] && !(sent >= slot);
}

const SRC = { huggingface: 'Hugging Face', openrouter: 'OpenRouter', curated: 'Official list', arxiv: 'arXiv', 'github-release': 'GitHub', blog: 'Blog' };
const when = (t, now) => { const ms = Date.parse(/[zZ]$/.test(t) ? t : String(t).replace(' ', 'T') + 'Z'), h = Math.max(0, Math.round((now - ms) / 36e5)); return h < 1 ? 'just now' : h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago'; };
const line = (s, now) => `${SRC[s.source_type] || 'Source'} · ${s.verification_label || s.verification} · ${when(s.ts, now)}`;

/**
 * @param {object} o { freq, groups: [{label, items}], watching: [], base, unsubscribeUrl, name?, now }
 * @returns {{subject, text, html, count}}
 */
function build(o) {
  const now = o.now || Date.now(), weekly = o.freq === 'weekly', groups = (o.groups || []).filter(g => g.items.length);
  const all = groups.flatMap(g => g.items), count = all.length + (o.watching || []).length;
  const top = all[0];
  const subject = `${weekly ? 'This week in AI' : 'Today in AI'}${top ? `: ${top.title}`.slice(0, 80) : ''}`;
  const tItem = s => `- ${s.title}\n  ${line(s, now)}\n  ${s.matters ? 'Why it matters: ' + s.matters + '\n  ' : ''}${/^https?:/.test(s.url || '') ? s.url : o.base}`;
  const text = [`${weekly ? 'This week in AI' : 'Today in AI'}${o.name ? ', ' + o.name : ''}`, '',
    ...(o.watching && o.watching.length ? ['FROM WHAT YOU FOLLOW', ...o.watching.map(tItem), ''] : []),
    ...groups.flatMap(g => [g.label.toUpperCase(), ...g.items.map(tItem), '']),
    `Open Signalstack: ${o.base}`, `Stop these emails: ${o.unsubscribeUrl}`].join('\n');
  const card = s => `<tr><td style="padding:12px 0;border-top:1px solid #e3e9f4"><a href="${esc(/^https?:/.test(s.url || '') ? s.url : o.base)}" style="color:#0d1730;font-weight:600;font-size:16px;text-decoration:none">${esc(s.title)}</a><div style="color:#5b6a86;font-size:13px;margin-top:3px">${esc(line(s, now))}</div>${s.matters ? `<div style="font-size:14px;margin-top:6px;color:#26334f"><b>Why it matters:</b> ${esc(s.matters)}</div>` : ''}${s.because ? `<div style="font-size:12.5px;color:#0a7ea4;margin-top:4px">${esc(s.because)}</div>` : ''}</td></tr>`;
  const section = (label, items) => `<tr><td style="padding:22px 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0a7ea4;font-weight:700">${esc(label)}</td></tr>${items.map(card).join('')}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7fc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;padding:26px 28px"><tr><td style="font-size:22px;font-weight:700;color:#0d1730">${weekly ? 'This week in AI' : 'Today in AI'}</td></tr><tr><td style="color:#5b6a86;font-size:14px;padding-top:4px">${o.name ? esc(o.name) + ', here' : 'Here'} are the most important items${weekly ? ' from the last 7 days' : ' from the last day'}. Each one links to its original source.</td></tr>${o.watching && o.watching.length ? section('From what you follow', o.watching) : ''}${groups.map(g => section(g.label, g.items)).join('')}<tr><td style="padding-top:24px;border-top:1px solid #e3e9f4;font-size:12.5px;color:#7a88a5">Ranked by importance and recency. <a href="${esc(o.base)}" style="color:#0a7ea4">Open Signalstack</a> · <a href="${esc(o.unsubscribeUrl)}" style="color:#7a88a5">Stop these emails</a></td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html, count };
}

// A Telegram channel message (HTML parse mode, under Telegram's 4096-character limit).
function telegram(items, base, now = Date.now()) {
  const eh = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const out = [`<b>Today in AI</b>`];
  for (const s of items.slice(0, 6)) {
    const u = /^https?:/.test(s.url || '') ? s.url : base;
    out.push(`\n<a href="${eh(u).replace(/"/g, '&quot;')}">${eh(s.title)}</a>\n${eh(line(s, now))}${s.matters ? '\n' + eh(s.matters) : ''}`);
  }
  out.push(`\n${eh(base)}`);
  let m = out.join('\n'); if (m.length > 4000) m = m.slice(0, 3990).replace(/<[^>]*$/, '') + '…';
  return m;
}

module.exports = { due, lastSlot, build, telegram };
