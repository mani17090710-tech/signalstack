'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { v1Signal, rss, embedHtml, xml } = require('../lib/publicapi');

const sig = { id: 7, ts: '2026-10-20 08:30', cat: 'Model Release', source_type: 'huggingface', title: 'New <b>model</b> & "co"', summary: 'x', detail: 'A detail', url: 'https://huggingface.co/x/y', verification: 'source_verified', verification_label: 'Source Verified', company_id: 'qwen', company: 'Alibaba Qwen', model_id: 'hf:x/y', score: 81, importance: 'Major', matters: 'Because.', official_domain: false };

test('v1 signals have a small stable shape with the source and verification', () => {
  const v = v1Signal(sig);
  assert.deepStrictEqual(Object.keys(v), ['id', 'type', 'title', 'summary', 'published_at', 'source', 'lab', 'model_id', 'score', 'importance', 'why_it_matters']);
  assert.strictEqual(v.type, 'model'); assert.strictEqual(v.published_at, '2026-10-20T08:30:00.000Z');
  assert.deepStrictEqual(v.source, { name: 'Hugging Face', url: 'https://huggingface.co/x/y', verification: 'source_verified', on_official_domain: false });
  assert.strictEqual(v1Signal({ ...sig, url: 'javascript:alert(1)' }).source.url, null, 'only http(s) links are published');
});

test('feed and widget escape everything and drop characters XML cannot hold', () => {
  const feed = rss([sig, { ...sig, id: 8, title: 'bad \u0001 char' }], { base: 'https://x.test', title: 'T', desc: 'D', self: 'https://x.test/feed.xml' });
  assert.match(feed, /<title>New &lt;b&gt;model&lt;\/b&gt; &amp; &quot;co&quot;<\/title>/);
  assert.doesNotMatch(feed, /\u0001/); assert.match(feed, /<guid isPermaLink="false">signalstack-7<\/guid>/); assert.match(feed, /Why this matters: Because\./);
  const w = embedHtml([sig, { ...sig, url: 'javascript:alert(1)' }], { base: 'https://x.test', title: 'T' });
  assert.doesNotMatch(w, /<script|javascript:|style=/i, 'no scripts, unsafe links or inline styles');
  assert.match(w, /New &lt;b&gt;model&lt;\/b&gt;/);
  assert.strictEqual(xml(null), '');
});
