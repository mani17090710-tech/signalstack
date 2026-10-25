'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { due, build, telegram } = require('../lib/digest');

// India time is UTC+5:30 (+330 minutes). 8:00 IST is 02:30 UTC.
const ist = (iso) => Date.parse(iso);
test('a daily digest is due once per day, after the chosen local hour', () => {
  const p = { freq: 'daily', hour: 8, tz_offset: 330, last_sent: '2026-10-23 02:35:00' }; // saving prefs stamps last_sent, so enabling never fires at once
  assert.strictEqual(due(p, ist('2026-10-24T02:00:00Z')), false, 'before 08:00 IST');
  assert.strictEqual(due(p, ist('2026-10-24T02:31:00Z')), true, 'just after 08:00 IST');
  assert.strictEqual(due({ ...p, last_sent: '2026-10-24 02:00:00' }, ist('2026-10-24T02:31:00Z')), true, 'stamped before the slot, so still due');
  assert.strictEqual(due({ ...p, last_sent: '2026-10-24 02:35:00' }, ist('2026-10-24T09:00:00Z')), false, 'already sent today');
  assert.strictEqual(due({ ...p, last_sent: '2026-10-23 02:35:00' }, ist('2026-10-24T09:00:00Z')), true, 'sent yesterday, due again');
  assert.strictEqual(due(p, ist('2026-10-24T20:00:00Z')), true, 'server woke up late the same day: still sent once');
  assert.strictEqual(due({ ...p, freq: 'off' }, ist('2026-10-24T09:00:00Z')), false);
});

test('a weekly digest means Monday, and catches up late if the server was asleep', () => {
  const p = { freq: 'weekly', hour: 8, tz_offset: 330, last_sent: '2026-10-19 02:35:00' }; // Monday 19 Oct 2026
  assert.strictEqual(due(p, ist('2026-10-22T09:00:00Z')), false, 'Thursday, already sent this week');
  assert.strictEqual(due({ ...p, last_sent: '2026-10-12 02:35:00' }, ist('2026-10-26T03:00:00Z')), true, 'Monday 26 Oct after 08:00 IST');
  assert.strictEqual(due({ ...p, last_sent: '2026-10-12 02:35:00' }, ist('2026-10-27T20:00:00Z')), true, 'Tuesday night: within the 72 h catch-up');
  assert.strictEqual(due({ ...p, last_sent: '2026-10-12 02:35:00' }, ist('2026-10-30T09:00:00Z')), false, 'Friday: too late for that Monday');
});

test('the digest names its sources, escapes everything and always carries an unsubscribe link', () => {
  const item = { id: 1, ts: '2026-10-24 06:00', title: 'A <b>big</b> model', source_type: 'huggingface', verification: 'source_verified', verification_label: 'Source Verified', url: 'https://huggingface.co/x', matters: 'It matters.' };
  const d = build({ freq: 'daily', groups: [{ label: 'Models', items: [item] }, { label: 'Papers', items: [] }], watching: [{ ...item, id: 2, because: 'You follow Qwen' }], base: 'https://x.test', unsubscribeUrl: 'https://x.test/u?t=1', name: 'Asha', now: Date.parse('2026-10-24T08:00:00Z') });
  assert.match(d.subject, /^Today in AI: A <b>big<\/b> model/);
  assert.match(d.html, /A &lt;b&gt;big&lt;\/b&gt; model/); assert.doesNotMatch(d.html, /<b>big<\/b>/);
  assert.match(d.html, /Hugging Face · Source Verified · 2 h ago/); assert.match(d.html, /From what you follow/); assert.match(d.html, /You follow Qwen/);
  assert.match(d.text, /Stop these emails: https:\/\/x\.test\/u\?t=1/); assert.doesNotMatch(d.html, /Papers/, 'empty groups are left out');
  const t = telegram([item, { ...item, title: 'x'.repeat(5000) }], 'https://x.test');
  assert.ok(t.length <= 4096); assert.match(t, /A &lt;b&gt;big&lt;\/b&gt; model/);
});
