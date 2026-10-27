'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseUpdate, parseNew } = require('../lib/moderation');
const ctx = { companyIds: ['openai', 'qwen'], isOfficial: (c, u) => c === 'openai' && new URL(u).hostname === 'openai.com', now: Date.parse('2026-10-26T12:00:00Z') };

test('edits are parsed strictly; null means back to automatic', () => {
  assert.deepStrictEqual(parseUpdate({ score: '85' }), { score: 85 });
  assert.deepStrictEqual(parseUpdate({ score: null, matters: null }), { score: null, matters: null });
  assert.deepStrictEqual(parseUpdate({ matters: '  A   note \n here ' }), { matters: 'A note here' });
  assert.deepStrictEqual(parseUpdate({ matters: '' }), { matters: '' }, 'empty means "show no note"');
  assert.deepStrictEqual(parseUpdate({ hidden: true }), { hidden: 1 });
  assert.deepStrictEqual(parseUpdate({ reset: true }), { reset: true });
  for (const b of [{}, { score: 101 }, { score: -1 }, { score: 7.5 }, { score: 'abc' }, { matters: 'x'.repeat(401) }]) assert.throws(() => parseUpdate(b), e => e.code === 400, JSON.stringify(b).slice(0, 40));
});

test('a signal added by hand gets its provenance from the link, never from what was typed', () => {
  const ok = { title: 'OpenAI ships a thing', url: 'https://openai.com/index/thing', cat: 'Announcement', company: 'openai', ts: '2026-10-25' };
  const a = parseNew(ok, ctx);
  assert.deepStrictEqual([a.verification, a.ts, a.summary], ['source_verified', '2026-10-25 00:00', 'OpenAI ships a thing']);
  assert.strictEqual(parseNew({ ...ok, url: 'https://news.example.com/x' }, ctx).verification, 'aggregator_listed', 'a link off the lab’s own site is only "found elsewhere"');
  assert.strictEqual(parseNew({ ...ok, company: '' }, ctx).verification, 'aggregator_listed');
  assert.strictEqual(parseNew({ ...ok, verification: 'verified' }, ctx).verification, 'source_verified', 'a typed verification is ignored');
  assert.deepStrictEqual([parseNew({ ...ok, score: 90, matters: ' Why ' }, ctx).score, parseNew({ ...ok, score: 90, matters: ' Why ' }, ctx).matters], [90, 'Why']);
  for (const b of [{ ...ok, title: 'x' }, { ...ok, url: 'javascript:alert(1)' }, { ...ok, url: 'nope' }, { ...ok, cat: 'Other' }, { ...ok, company: 'zzz' }, { ...ok, ts: 'not a date' }, { ...ok, ts: '2026-12-31' }, { ...ok, score: 500 }, { ...ok, url: 'https://u:p@openai.com/x' }])
    assert.throws(() => parseNew(b, ctx), e => e.code === 400, JSON.stringify(b).slice(0, 60));
});

test('a signal with no model data gets a relevance from its source, not a free 100', () => {
  const { scoreSignal } = require('../lib/score');
  const now = Date.now();
  const base = { cat: 'Announcement', ts: new Date(now).toISOString(), meta: {}, now };
  const own = scoreSignal({ ...base, companyName: 'OpenAI', tier: 'primary' });
  const none = scoreSignal({ ...base, tier: 'aggregator' });
  assert.ok(own.score > none.score);
  assert.ok(none.score < 80, 'unattached signal must not be Major: ' + none.score);
});
