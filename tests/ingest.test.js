'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../lib/db');
const ingest = require('../ingest');

const hfItem = (id, o = {}) => ({ id, createdAt: new Date().toISOString(), likes: 10, downloads: 1000, tags: ['text-generation', 'license:apache-2.0'], pipeline_tag: 'text-generation', ...o });
const res = (body, ok = true, status = 200) => ({ ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: () => null } });

// Only the Hugging Face sources are exercised here; other sources are disabled so each test controls the traffic.
function setup() {
  const db = openDb(':memory:');
  db.exec("update sources_config set enabled=0 where kind!='huggingface' or id!='hf-new-models'");
  return db;
}

test('first run is a silent backfill; the second run adds nothing when nothing changed', async () => {
  const db = setup();
  const payload = [hfItem('Qwen/Qwen3-8B'), hfItem('someone/tiny')];
  const f = async () => res(payload);
  const a = await ingest.runAll(db, f);
  assert.ok(db.prepare("select count(*) n from models where id like 'hf:%'").get().n >= 2);
  assert.strictEqual(a.length, 0, 'backfill must not emit alerts');
  const before = db.prepare('select count(*) n from events').get().n;
  await ingest.runAll(db, f);
  assert.strictEqual(db.prepare('select count(*) n from events').get().n, before);
  assert.strictEqual(db.prepare("select last_status s from sources_config where id='hf-new-models'").get().s, 'unchanged');
});

test('a new model after the backfill is stored once, with company, category and verification', async () => {
  const db = setup();
  await ingest.runAll(db, async () => res([hfItem('someone/tiny')]));
  const f = async () => res([hfItem('Qwen/Qwen3-Coder-27B', { tags: ['text-generation', 'license:apache-2.0', 'arxiv:2501.00001'] }), hfItem('someone/tiny')]);
  await ingest.runAll(db, f);
  await ingest.runAll(db, f);
  const m = db.prepare("select * from models where id='hf:Qwen/Qwen3-Coder-27B'").get();
  assert.ok(m, 'model stored');
  assert.strictEqual(m.company_id, 'qwen');
  assert.strictEqual(m.license, 'apache-2.0');
  assert.strictEqual(m.arxiv, '2501.00001');
  assert.strictEqual(m.params_label, '27B');
  assert.match(m.cats, /coding/);
  assert.strictEqual(db.prepare("select count(*) n from models where id='hf:Qwen/Qwen3-Coder-27B'").get().n, 1);
});

test('a failing source is recorded and does not stop the run', async () => {
  const db = openDb(':memory:');
  const f = async () => res('nope', false, 503);
  await ingest.runAll(db, f);
  const row = db.prepare("select last_status s,last_error e from sources_config where id='hf-new-models'").get();
  assert.strictEqual(row.s, 'error');
  assert.match(row.e, /503/);
  assert.ok(db.prepare('select count(*) n from ingestion_log').get().n > 1, 'every source was attempted');
});

test('parsers reject unexpected payloads', () => {
  assert.throws(() => ingest.parseHuggingFace('{"error":"x"}'));
  assert.throws(() => ingest.parseGitHub('{"message":"rate limited"}'));
  assert.deepStrictEqual(ingest.parseArxiv('<feed></feed>'), []);
});

test('enrichModel fills exact parameter count from the model endpoint and backs off on failure', async () => {
  const db = setup();
  await ingest.runAll(db, async () => res([hfItem('someone/tiny')]));
  const ok = await ingest.enrichModel(db, 'hf:someone/tiny', async () => res({ lastModified: '2026-09-01T00:00:00.000Z', safetensors: { total: 7_240_000_000 }, cardData: { license: 'mit' }, config: { architectures: ['LlamaForCausalLM'] } }));
  assert.ok(ok);
  const m = db.prepare("select * from models where id='hf:someone/tiny'").get();
  assert.strictEqual(m.param_count, 7_240_000_000);
  assert.strictEqual(m.arch, 'LlamaForCausalLM');
  let calls = 0;
  const bad = async () => { calls++; return res('x', false, 500); };
  await ingest.enrichModel(db, 'hf:other/model', bad); await ingest.enrichModel(db, 'hf:other/model', bad);
  assert.strictEqual(calls, 1, 'second attempt is suppressed by the backoff');
});
