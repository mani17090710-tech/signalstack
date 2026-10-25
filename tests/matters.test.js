'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { matters } = require('../lib/matters');

test('only important signals get a note, and it states only facts we hold', () => {
  assert.strictEqual(matters({ cat: 'Model Release', score: 59, companyName: 'Meta AI', model: { param_count: 7e9 } }), null);
  const open = matters({ cat: 'Model Release', score: 82, companyName: 'Alibaba Qwen', model: { param_count: 27e9, downloads: 9000, likes: 40, adoption: true, hoursOld: 30 } });
  assert.match(open, /open-weight model you can download from Alibaba Qwen, with 27B parameters/);
  assert.match(open, /9k downloads and 40 likes/);
  assert.match(open, /lab we track closely/);
  const api = matters({ cat: 'Model Release', score: 75, companyName: 'Meta AI', model: { ctx_tokens: 1048576, adoption: false } });
  assert.match(api, /call through an API/); assert.match(api, /1\.0M-token context window|1M-token context window/); assert.doesNotMatch(api, /downloads|likes/, 'no adoption claims for API models');
});

test('papers, releases and announcements', () => {
  assert.match(matters({ cat: 'Research', score: 70, mentionNames: ['OpenAI', 'Meta AI'] }), /names OpenAI, Meta AI/);
  assert.strictEqual(matters({ cat: 'Research', score: 70, mentionNames: [] }), null, 'a paper naming no lab has nothing to say');
  assert.match(matters({ cat: 'Open Source', score: 85, meta: { tag: 'v2.0.0', repo: 'acme/tool' }, companyName: 'Acme' }), /major release of acme\/tool.*Acme/);
  assert.strictEqual(matters({ cat: 'Open Source', score: 85, meta: { tag: 'nightly' } }), null);
  assert.match(matters({ cat: 'Announcement', score: 90, tier: 'primary', companyName: 'OpenAI' }), /official announcement from OpenAI/);
  assert.match(matters({ cat: 'Announcement', score: 66, tier: 'community' }), /not an official statement/);
});
