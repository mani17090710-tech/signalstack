'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { build, watches, health, privateHost } = require('../lib/sources');
const ctx = { companyIds: ['qwen', 'openai'], version: 5 };

test('new sources are validated and turned into complete rows', () => {
  const hf = build({ kind: 'huggingface', author: 'https://huggingface.co/meta-llama/', company: 'qwen' }, ctx);
  assert.deepStrictEqual([hf.id, hf.config.author, hf.config.company, hf.config.tier, hf.config.v], ['hf-org-meta-llama', 'meta-llama', 'qwen', 'community', 5]);
  const gh = build({ kind: 'github', repo: 'https://github.com/ggml-org/llama.cpp.git', tier: 'primary' }, ctx);
  assert.deepStrictEqual([gh.id, gh.config.owner, gh.config.repo, gh.config.tier], ['gh-ggml-org-llama-cpp', 'ggml-org', 'llama.cpp', 'primary']);
  const fd = build({ kind: 'feed', url: 'https://example.com/blog/rss.xml', label: ' Example Lab ' }, ctx);
  assert.deepStrictEqual([fd.id, fd.label, fd.config.org.name], ['feed-example-com-blog-rss-xml', 'Example Lab', 'Example Lab']);
  assert.strictEqual(build({ kind: 'feed', url: 'https://www.example.com/x' }, ctx).label, 'example.com', 'label falls back to the host');
});

test('bad input is refused with a plain message', () => {
  const bads = [{ kind: 'arxiv' }, { kind: 'huggingface', author: '' }, { kind: 'huggingface', author: 'a b' }, { kind: 'github', repo: 'justone' }, { kind: 'github', repo: 'a/b', company: 'nope' },
    { kind: 'feed', url: 'http://example.com/rss' }, { kind: 'feed', url: 'not a url' }, { kind: 'feed', url: 'https://user:pw@example.com/rss' },
    { kind: 'feed', url: 'https://localhost/rss' }, { kind: 'feed', url: 'https://127.0.0.1/rss' }, { kind: 'feed', url: 'https://192.168.1.5/rss' }, { kind: 'feed', url: 'https://10.0.0.1/x' }, { kind: 'feed', url: 'https://intranet/x' }, { kind: 'feed', url: 'https://[::1]/x' }];
  for (const b of bads) assert.throws(() => build(b, ctx), e => e.code === 400 && e.message.length > 10, JSON.stringify(b));
  assert.ok(privateHost('169.254.169.254') && privateHost('172.20.1.1') && !privateHost('172.32.0.1') && !privateHost('openai.com'));
});

test('an existing source says what it watches', () => {
  assert.deepStrictEqual(watches({ kind: 'github', config: '{"owner":"vllm-project","repo":"vllm"}' }), { text: 'Releases of vllm-project/vllm', url: 'https://github.com/vllm-project/vllm/releases' });
  assert.match(watches({ kind: 'huggingface', config: '{"author":"Qwen"}' }).text, /Qwen/);
  assert.strictEqual(watches({ kind: 'feed', config: '{"url":"https://a.b/rss"}' }).url, 'https://a.b/rss');
  assert.strictEqual(watches({ kind: 'huggingface', config: 'not json' }).url, 'https://huggingface.co/models', 'a broken config does not crash');
});

test('health: paused, new, failing (with streak), stale, warning, healthy', () => {
  const now = Date.parse('2026-10-26T12:00:00Z'), run = h => new Date(now - h * 36e5).toISOString();
  const row = o => ({ enabled: 1, last_run: run(0.2), last_status: 'ok', ...o });
  assert.strictEqual(health(row({ enabled: 0 }), [], now).state, 'paused');
  assert.strictEqual(health(row({ last_run: null }), [], now).state, 'new');
  assert.strictEqual(health(row({ last_status: 'unchanged' }), [], now).state, 'healthy');
  assert.strictEqual(health(row({ last_status: 'warning' }), [], now).state, 'warning');
  assert.strictEqual(health(row({ last_run: run(5) }), [], now).state, 'stale', 'no run for over 3 hours');
  const log = [{ ts: '3', status: 'error' }, { ts: '2', status: 'error' }, { ts: '1', status: 'ok' }, { ts: '0', status: 'error' }];
  const h = health(row({ last_status: 'error' }), log, now);
  assert.deepStrictEqual([h.state, h.failures, h.failingSince, h.lastOk], ['failing', 2, '2', '1'], 'the streak counts only the newest unbroken errors');
});
