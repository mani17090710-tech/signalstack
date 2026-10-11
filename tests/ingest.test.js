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
const only = (db, ...ids) => db.exec(`update sources_config set enabled=0 where id not in (${ids.map(i => `'${i}'`).join(',')})`);

test('DISCOVERY IS NOT VERIFICATION: an OpenRouter-listed model is "Aggregator listed", never Verified', async () => {
  const db = openDb(':memory:'); only(db, 'openrouter-models');
  await ingest.runAll(db, async () => res({ data: [orModel('anthropic/claude-old', { created: 1700000000 })] }));
  const out = await ingest.runAll(db, async () => res({ data: [orModel('anthropic/claude-old', { created: 1700000000 }), orModel('anthropic/claude-new'), orModel('anthropic/claude-new:batch')] }));
  const m = db.prepare("select * from models where id='cm:anthropic/claude-new'").get();
  assert.ok(m, 'closed model stored under a canonical id');
  assert.strictEqual(m.verification, 'aggregator');
  assert.strictEqual(m.verified_at, null, 'no evidence, so no last-verified time');
  assert.strictEqual(db.prepare('select count(*) n from model_evidence where model_id=?').get(m.id).n, 0);
  assert.strictEqual(m.company_id, 'anthropic'); assert.strictEqual(m.ctx_tokens, 1000000); assert.strictEqual(m.price_in, 1); assert.strictEqual(m.price_source, 'openrouter');
  assert.match(m.capabilities, /vision/); assert.strictEqual(m.official_url, null, 'no official URL is invented');
  assert.strictEqual(db.prepare("select source from model_sources where model_id=?").all(m.id)[0].source, 'openrouter');
  assert.strictEqual(db.prepare("select count(*) n from models where id like '%:batch'").get().n, 0, 'variants skipped');
  const ev = db.prepare("select verification v from events where model_id=?").get(m.id);
  assert.strictEqual(ev.v, 'aggregator'); assert.ok(out.length >= 1);
});

test('a model on both Hugging Face and OpenRouter has ONE canonical record with both sources attached', async () => {
  const db = openDb(':memory:'); only(db, 'openrouter-models', 'hf-org-qwen');
  await ingest.runAll(db, async u => (String(u).includes('openrouter') ? res({ data: [] }) : res([hfItem('Qwen/Qwen3-Coder-27B')])));
  await ingest.runAll(db, async u => (String(u).includes('openrouter') ? res({ data: [orModel('qwen/qwen3-coder-27b', { hugging_face_id: 'Qwen/Qwen3-Coder-27B' })] }) : res([hfItem('Qwen/Qwen3-Coder-27B')])));
  const rows = db.prepare("select * from models where canon_key='qwen/qwen3-coder-27b'").all();
  assert.strictEqual(rows.length, 1, 'no duplicate record');
  assert.strictEqual(rows[0].id, 'hf:Qwen/Qwen3-Coder-27B');
  assert.deepStrictEqual(db.prepare('select source from model_sources where model_id=? order by source').all(rows[0].id).map(r => r.source), ['huggingface', 'openrouter']);
  assert.strictEqual(rows[0].ctx_tokens, 1000000, 'context length attached from the catalogue');
  assert.strictEqual(rows[0].verification, 'source_verified', 'the lab\u2019s own Hugging Face account is evidence; the catalogue adds none');
});

test('Hugging Face: official lab account is "Source verified"; a popular community upload is only "Aggregator listed"', async () => {
  const db = openDb(':memory:'); only(db, 'hf-new-models');
  const items = [hfItem('Qwen/Qwen3-8B', { likes: 0, downloads: 10 }), hfItem('someone/popular', { likes: 500, downloads: 90000 }), hfItem('rando/tiny-finetune', { likes: 0, downloads: 10 })];
  await ingest.runAll(db, async () => res(items));
  const v = id => db.prepare('select verification v from models where id=?').get(id)?.v;
  assert.strictEqual(v('hf:Qwen/Qwen3-8B'), 'source_verified');
  assert.strictEqual(v('hf:someone/popular'), 'aggregator');
  assert.strictEqual(v('hf:rando/tiny-finetune'), undefined, 'unimportant community uploads are not kept');
  const ev = db.prepare("select * from model_evidence where model_id='hf:Qwen/Qwen3-8B'").get();
  assert.strictEqual(ev.kind, 'official_account'); assert.match(ev.url, /huggingface\.co\/Qwen/);
});

const curatedFile = entries => { const os = require('node:os'), fs = require('node:fs'), pth = require('node:path'); const f = pth.join(os.tmpdir(), 'cur-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json'); fs.writeFileSync(f, JSON.stringify({ models: entries })); return f; };
const useCurated = (db, file) => db.prepare("update sources_config set config=? where id='curated-models'").run(JSON.stringify({ v: 4, file, tier: 'primary' }));

test('hand-kept list: the provider\u2019s announcement is evidence, so the model becomes Verified; invalid entries are reported', async () => {
  const fs = require('node:fs');
  const good = { id: 'openai/gpt-example', name: 'GPT Example', company: 'openai', released: '2026-10-10', url: 'https://openai.com/index/gpt-example/', context: 400000, price_in: 2, price_out: 10, summary: 'A test model.', papers: ['2501.00001'] };
  const bad = [{ id: 'Bad Id', name: 'x', company: 'openai', released: '2026-10-10', url: 'https://x.test' }, { id: 'openai/no-link', name: 'x', company: 'openai', released: '2026-10-10' }, { id: 'nobody/model', name: 'x', company: 'nobody', released: '2026-10-10', url: 'https://x.test' }];
  const file = curatedFile([]);
  const db = openDb(':memory:'); only(db, 'curated-models'); useCurated(db, file);
  await ingest.runAll(db, async () => res({}));
  fs.writeFileSync(file, JSON.stringify({ models: [good, ...bad] }));
  const out = await ingest.runAll(db, async () => res({}));
  const m = db.prepare("select * from models where id='cm:openai/gpt-example'").get();
  assert.ok(m); assert.strictEqual(m.verification, 'verified'); assert.ok(m.verified_at, 'last-verified time recorded');
  assert.strictEqual(m.official_url, good.url); assert.strictEqual(m.price_source, 'official'); assert.strictEqual(m.ctx_source, 'official');
  assert.strictEqual(db.prepare('select url from model_evidence where model_id=?').get(m.id).url, good.url);
  assert.ok(out.some(e => db.prepare('select model_id m from events where id=?').get(e.id)?.m === 'cm:openai/gpt-example'), 'raises a new-model signal');
  assert.strictEqual(db.prepare('select evidence_kind k from model_papers where model_id=?').get(m.id).k, 'official_announcement', 'paper linked via the announcement');
  const row = db.prepare("select last_status s,last_error e from sources_config where id='curated-models'").get();
  assert.strictEqual(row.s, 'warning'); assert.match(row.e, /Skipped 3 invalid entries/);
  fs.unlinkSync(file);
});

test('a model found by OpenRouter and later confirmed by the provider upgrades the SAME record; official numbers beat the aggregator\u2019s', async () => {
  const fs = require('node:fs');
  const file = curatedFile([]);
  const db = openDb(':memory:'); only(db, 'curated-models', 'openrouter-models'); useCurated(db, file);
  const orRes = async () => res({ data: [orModel('openai/gpt-both-20261009', { context_length: 128000 })] });
  await ingest.runAll(db, orRes);
  await ingest.runAll(db, orRes);
  assert.strictEqual(db.prepare("select verification v from models where canon_key='openai/gpt-both'").get().v, 'aggregator');
  fs.writeFileSync(file, JSON.stringify({ models: [{ id: 'openai/gpt-both', name: 'GPT Both', company: 'openai', released: '2026-10-09', url: 'https://openai.com/index/gpt-both/', context: 400000, price_in: 3, price_out: 12 }] }));
  await ingest.runAll(db, orRes);
  await ingest.runAll(db, orRes); // the aggregator runs again and must not overwrite the provider's numbers
  const rows = db.prepare("select * from models where canon_key='openai/gpt-both'").all();
  assert.strictEqual(rows.length, 1, 'one canonical record');
  assert.strictEqual(rows[0].verification, 'verified');
  assert.strictEqual(rows[0].ctx_tokens, 400000); assert.strictEqual(rows[0].price_in, 3);
  assert.deepStrictEqual(db.prepare('select source from model_sources where model_id=? order by source').all(rows[0].id).map(r => r.source), ['curated', 'openrouter']);
  fs.unlinkSync(file);
});

test('model-paper links exist only with evidence: HF arXiv tag, or the paper naming the exact repository id', async () => {
  const db = openDb(':memory:'); only(db, 'hf-org-qwen', 'arxiv-cs-cl');
  const iso = d => new Date(Date.now() - d * 864e5).toISOString();
  const feed = (id, title, abs) => `<entry><id>http://arxiv.org/abs/${id}v1</id><title>${title}</title><summary>${abs}</summary><published>${iso(3)}</published><arxiv:primary_category term="cs.CL"/><category term="cs.CL"/><category term="cs.LG"/><author><name>A. Author</name></author></entry>`;
  const hf = async () => res([hfItem('Qwen/Qwen3-8B', { tags: ['text-generation', 'arxiv:2610.00002'] })]);
  const ax = async () => res('<feed>' + feed('2610.00001', 'Scaling analysis', 'We evaluate Qwen/Qwen3-8B on reasoning.') + feed('2610.00003', 'A similar thing', 'We study Qwen3 style models and 8B scale.') + '</feed>');
  await ingest.runAll(db, async u => (String(u).includes('arxiv') ? ax() : hf()), { arxivDelayMs: 0 });
  await ingest.runAll(db, async u => (String(u).includes('arxiv') ? ax() : hf()), { arxivDelayMs: 0 });
  const links = db.prepare("select arxiv_id a, evidence_kind k from model_papers where model_id='hf:Qwen/Qwen3-8B' order by a").all().map(r => r.a + ':' + r.k);
  assert.deepStrictEqual(links, ['2610.00001:paper_names_model_id', '2610.00002:hf_model_tag'], 'similar names create no link');
  const p = db.prepare("select * from papers where arxiv_id='2610.00001'").get();
  assert.strictEqual(p.categories, 'cs.CL,cs.LG'); assert.strictEqual(p.verification, 'source_verified'); assert.ok(p.retrieved_at);
});

test('migration re-expresses old statuses: OpenRouter/community -> aggregator, official HF account -> source_verified with evidence', () => {
  const os = require('node:os'), pth = require('node:path'), fs = require('node:fs');
  const file = pth.join(os.tmpdir(), 'mig-' + process.pid + '.db');
  const db = openDb(file);
  db.exec("delete from meta; insert into models(id,name,org_id,verified,company_id,creator,url,source_type,verification) values('hf:Qwen/A','Qwen/A','hf',1,'qwen','Qwen','https://huggingface.co/Qwen/A','huggingface','verified'),('hf:x/b','x/b','hf',1,null,'x','https://huggingface.co/x/b','huggingface','community')");
  db.close();
  const db2 = openDb(file);
  const v = id => db2.prepare('select verification v from models where id=?').get(id).v;
  assert.strictEqual(v('hf:Qwen/A'), 'source_verified'); assert.strictEqual(v('hf:x/b'), 'aggregator');
  assert.strictEqual(db2.prepare("select count(*) n from model_evidence where model_id='hf:Qwen/A'").get().n, 1);
  assert.strictEqual(db2.prepare("select count(*) n from model_evidence where model_id='hf:x/b'").get().n, 0);
  db2.close(); for (const sfx of ['', '-wal', '-shm']) try { fs.unlinkSync(file + sfx); } catch (e) { /* ok */ }
});
