'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../lib/db');
const ingest = require('../ingest');

const hfItem = (id, o = {}) => ({ id, createdAt: new Date().toISOString(), likes: 30, downloads: 5000, tags: ['text-generation', 'license:apache-2.0'], pipeline_tag: 'text-generation', ...o });
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

const orModel = (id, o = {}) => ({ id, canonical_slug: id, hugging_face_id: '', created: Math.floor(Date.now() / 1000) - 3600, context_length: 1000000,
  architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000005' }, supported_parameters: ['reasoning', 'tools'], ...o });

test('OpenRouter adds closed models as Aggregator Listed, skips variants, and never duplicates Hugging Face models', async () => {
  const db = openDb(':memory:');
  db.exec("update sources_config set enabled=0 where id!='openrouter-models'");
  const f1 = async () => res({ data: [orModel('anthropic/claude-old', { created: 1700000000 })] });
  await ingest.runAll(db, f1);
  // a Hugging Face copy of an open model already exists
  db.prepare("insert into models(id,name,org_id,verified,source_type,canon_key) values('hf:qwen/open-one','qwen/open-one','hf',1,'huggingface','qwen/open-one')").run();
  const f2 = async () => res({ data: [orModel('anthropic/claude-old', { created: 1700000000 }), orModel('anthropic/claude-new'), orModel('anthropic/claude-new:batch'), orModel('qwen/open-one', { hugging_face_id: 'qwen/open-one' }), orModel('openai/gpt-x', { architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] } })] });
  const out = await ingest.runAll(db, f2);
  const m = db.prepare("select * from models where id='or:anthropic/claude-new'").get();
  assert.ok(m, 'closed model stored');
  assert.strictEqual(m.verification, 'aggregator_listed', 'a catalogue listing is never Verified');
  assert.strictEqual(m.or_url, 'https://openrouter.ai/anthropic/claude-new');
  assert.strictEqual(m.ctx_source, 'openrouter');
  assert.strictEqual(m.price_source, 'openrouter');
  assert.strictEqual(m.provider_url, null, 'no official URL without official evidence');
  assert.strictEqual(m.company_id, 'anthropic');
  assert.strictEqual(m.ctx_tokens, 1000000);
  assert.strictEqual(m.price_in, 1);
  assert.strictEqual(m.price_out, 5);
  assert.strictEqual(db.prepare("select count(*) n from models where id like 'or:%:batch'").get().n, 0, 'variants skipped');
  assert.strictEqual(db.prepare("select count(*) n from models where id='or:qwen/open-one'").get().n, 0, 'no duplicate of a Hugging Face model');
  assert.strictEqual(db.prepare("select ctx_tokens c from models where id='hf:qwen/open-one'").get().c, 1000000, 'context length attached to the Hugging Face model');
  assert.ok(out.some(e => e.cat === 'Model Release'), 'new closed models raise a release signal');
  assert.strictEqual(db.prepare("select verification v from events where model_id='or:anthropic/claude-new'").get().v, 'aggregator_listed');
});

test('Hugging Face feeds skip unimportant community uploads but keep official labs', async () => {
  const db = openDb(':memory:');
  db.exec("update sources_config set enabled=0 where id!='hf-new-models'");
  const items = [hfItem('rando/tiny-finetune', { likes: 0, downloads: 10 }), hfItem('Qwen/Qwen3-8B', { likes: 0, downloads: 10 }), hfItem('someone/popular', { likes: 500, downloads: 90000 })];
  await ingest.runAll(db, async () => res(items));
  const ids = db.prepare("select id from models").all().map(r => r.id);
  assert.ok(!ids.includes('hf:rando/tiny-finetune'));
  assert.ok(ids.includes('hf:Qwen/Qwen3-8B') && ids.includes('hf:someone/popular'));
});

test('hand-kept list: official entries become Verified with evidence, invalid ones are reported, an OpenRouter listing joins the same record', async () => {
  const os = require('node:os'), fs = require('node:fs'), pth = require('node:path');
  const file = pth.join(os.tmpdir(), 'cur-' + process.pid + '.json');
  const good = { id: 'openai/gpt-example', name: 'GPT Example', company: 'openai', released: '2026-10-10', url: 'https://openai.com/index/gpt-example/', docs_url: 'https://platform.openai.com/docs/models/gpt-example', provider_model_id: 'gpt-example', context: 400000, price_in: 2, price_out: 10, summary: 'A test model.' };
  const dupe = { id: 'anthropic/claude-both', name: 'Claude Both', company: 'anthropic', released: '2026-10-09', url: 'https://www.anthropic.com/news/claude-both' };
  const bad = [{ id: 'Bad Id', name: 'x', company: 'openai', released: '2026-10-10', url: 'https://openai.com/x' }, { id: 'openai/no-link', name: 'x', company: 'openai', released: '2026-10-10' },
    { id: 'nobody/model', name: 'x', company: 'nobody', released: '2026-10-10', url: 'https://x.test' }, { id: 'openai/lookalike', name: 'x', company: 'openai', released: '2026-10-10', url: 'https://openai.com.evil.test/x' }];
  fs.writeFileSync(file, JSON.stringify({ models: [] }));
  const db = openDb(':memory:');
  db.exec("update sources_config set enabled=0 where id not in ('curated-models','openrouter-models')");
  db.prepare("update sources_config set config=? where id='curated-models'").run(JSON.stringify({ v: 5, file, tier: 'primary' }));
  await ingest.runAll(db, async () => res({ data: [orModel('anthropic/claude-both')] })); // backfill with an empty list
  assert.strictEqual(db.prepare("select verification v from models where id='or:anthropic/claude-both'").get().v, 'aggregator_listed');
  db.prepare("insert or ignore into users(id,email,pw) values(1,'a@b.c','x')").run();
  db.prepare("insert into watchlist values(1,'or:anthropic/claude-both')").run();
  fs.writeFileSync(file, JSON.stringify({ models: [good, dupe, ...bad] }));
  const out = await ingest.runAll(db, async () => res({ data: [orModel('anthropic/claude-both')] }));
  const m = db.prepare("select * from models where id='cu:openai/gpt-example'").get();
  assert.ok(m); assert.strictEqual(m.verification, 'verified'); assert.strictEqual(m.source_type, 'curated'); assert.strictEqual(m.ctx_tokens, 400000); assert.strictEqual(m.url, good.url);
  assert.strictEqual(m.provider_url, good.url); assert.strictEqual(m.provider_model_id, 'gpt-example'); assert.strictEqual(m.ctx_source, 'official'); assert.strictEqual(m.price_source, 'official');
  assert.ok(m.verified_at, 'last verified timestamp is recorded');
  const kinds = db.prepare("select kind from model_evidence where model_id='cu:openai/gpt-example'").all().map(r => r.kind).sort();
  assert.deepStrictEqual(kinds, ['official_announcement', 'official_docs']);
  // the OpenRouter listing of the same model is folded into one record; the old id and the watchlist entry still work
  assert.strictEqual(db.prepare("select count(*) n from models where canon_key='anthropic/claude-both'").get().n, 1);
  const c = db.prepare("select * from models where canon_key='anthropic/claude-both'").get();
  assert.strictEqual(c.id, 'cu:anthropic/claude-both'); assert.strictEqual(c.verification, 'verified'); assert.strictEqual(c.or_url, 'https://openrouter.ai/anthropic/claude-both');
  assert.deepStrictEqual(db.prepare('select source from model_sources where model_id=? order by source').all(c.id).map(r => r.source), ['curated', 'openrouter']);
  assert.strictEqual(require('../lib/canon').resolveId(db, 'or:anthropic/claude-both'), c.id);
  assert.strictEqual(db.prepare('select model_id m from watchlist').get().m, c.id);
  assert.ok(out.some(e => db.prepare('select model_id m from events where id=?').get(e.id)?.m === 'cu:openai/gpt-example'), 'raises a new-model signal');
  const row = db.prepare("select last_status s,last_error e from sources_config where id='curated-models'").get();
  assert.strictEqual(row.s, 'warning'); assert.match(row.e, /Skipped 4 invalid entries/);
  fs.unlinkSync(file);
});
