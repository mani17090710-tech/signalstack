'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { categorize, parseParams } = require('../lib/classify');
const { scoreSignal } = require('../lib/score');

test('parseParams reads sizes from names and ignores context-length tokens', () => {
  assert.strictEqual(parseParams('Qwen/Qwen3.8-27B').label, '27B');
  assert.strictEqual(parseParams('x/model-1M'), null);
});
test('categorize detects coding and vision models', () => {
  assert.ok(categorize({ name: 'a/Coder-7B', pipeline: 'text-generation', tags: [] }).cats.includes('coding'));
  assert.ok(categorize({ name: 'a/vl', pipeline: 'image-text-to-text', tags: [] }).cats.length > 0);
});
test('scoreSignal stays in 0-100 and a fresh lab release outranks an old unmentioned paper', () => {
  const now = Date.now();
  const hi = scoreSignal({ cat: 'Model Release', ts: new Date(now - 3600e3).toISOString(), companyName: 'Qwen', tier: 'community' }, now);
  const lo = scoreSignal({ cat: 'Paper', ts: new Date(now - 3 * 864e5).toISOString(), mentions: [] }, now);
  assert.ok(hi.score <= 100 && lo.score >= 0);
  assert.ok(hi.score > lo.score);
  assert.ok(Array.isArray(hi.why) && hi.why.length > 0);
});
