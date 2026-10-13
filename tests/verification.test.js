'use strict';
// Discovery vs verification, canonical records, Hugging Face policy, and the research-paper pipeline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openDb } = require('../lib/db');
const ingest = require('../ingest');
const { keepReason, pruneModels } = require('../lib/policy');
const { linkModelPapers } = require('../lib/links');

const res = body => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: () => null } });
const hfItem = (id, o = {}) => ({ id, createdAt: new Date().toISOString(), likes: 30, downloads: 5000, tags: ['text-generation'], pipeline_tag: 'text-generation', ...o });
const orModel = (id, o = {}) => ({ id, canonical_slug: id, hugging_face_id: '', created: Math.floor(Date.now() / 1000) - 3600, context_length: 128000,
  architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: [], ...o });
const only = (db, ...ids) => db.exec(`update sources_config set enabled=0 where id not in (${ids.map(i => `'${i}'`).join(',')})`);
const arxivEntry = (id, o = {}) => `<entry><id>http://arxiv.org/abs/${id}v1</id><updated>${o.updated || '2026-10-02T10:00:00Z'}</updated><published>2026-10-01T10:00:00Z</published>
  <title>${o.title || 'A Paper'}</title><summary>${o.summary || 'An abstract that is much longer than six hundred characters. '.repeat(30)}</summary>
  ${(o.authors || ['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six', 'G Seven', 'H Eight', 'I Nine', 'J Ten']).map(a => `<author><name>${a}</name></author>`).join('')}
  <arxiv:primary_category term="cs.CL"/><category term="cs.CL"/><category term="cs.LG"/></entry>`;
const feed = (...entries) => `<?xml version="1.0"?><feed>${entries.join('')}</feed>`;

test('Hugging Face: official namespaces are Source Verified, community uploads are Aggregator Listed, none are Verified', async () => {
  const db = openDb(':memory:'); only(db, 'hf-new-models');
  await ingest.runAll(db, async () => res([hfItem('Qwen/Qwen3-8B', { likes: 0, downloads: 0 }), hfItem('someone/popular', { likes: 400 })]));
  const v = id => db.prepare('select verification v,provider_url p from models where id=?').get(id);
  assert.strictEqual(v('hf:Qwen/Qwen3-8B').v, 'source_verified');
  assert.strictEqual(v('hf:someone/popular').v, 'aggregator_listed');
  assert.strictEqual(v('hf:someone/popular').p, null, 'a community upload has no official provider URL');
  assert.strictEqual(db.prepare("select count(*) n from models where verification='verified'").get().n, 0);
});

test('one canonical record per model: Hugging Face and OpenRouter listings attach to the same row, look-alike names do not', async () => {
  const db = openDb(':memory:'); only(db, 'hf-new-models', 'openrouter-models');
  await ingest.runAll(db, async u => (String(u).includes('openrouter') ? res({ data: [orModel('qwen/qwen3-8b'), orModel('qwen/qwen3-8b-instruct')] }) : res([hfItem('Qwen/Qwen3-8B')])));
  const rows = db.prepare("select id,canon_key from models where canon_key like 'qwen/qwen3-8b%' order by canon_key").all();
  assert.strictEqual(rows.length, 2, 'qwen3-8b and qwen3-8b-instruct stay separate');
  const one = db.prepare("select * from models where canon_key='qwen/qwen3-8b'").get();
  assert.strictEqual(one.id, 'hf:Qwen/Qwen3-8B', 'the Hugging Face record survives');
  assert.deepStrictEqual(db.prepare('select source from model_sources where model_id=? order by source').all(one.id).map(r => r.source), ['huggingface', 'openrouter']);
  assert.strictEqual(one.ctx_tokens, 128000); assert.strictEqual(one.ctx_source, 'openrouter', 'context from a catalogue is labelled as such');
  assert.strictEqual(one.verification, 'source_verified', 'a second listing never changes the verification status');
  assert.strictEqual(require('../lib/canon').resolveId(db, 'or:qwen/qwen3-8b'), one.id, 'the old OpenRouter id still resolves');
  // the same models seen again do not multiply
  await ingest.runAll(db, async u => (String(u).includes('openrouter') ? res({ data: [orModel('qwen/qwen3-8b')] }) : res([hfItem('Qwen/Qwen3-8B')])));
  assert.strictEqual(db.prepare("select count(*) n from models where canon_key='qwen/qwen3-8b'").get().n, 1);
});

test('migration gives old rows a canonical key and evidence, merges duplicates, and keeps old ids and watchlists working', () => {
  const file = path.join(os.tmpdir(), 'mig-' + process.pid + '.db');
  let db = openDb(file);
  db.prepare("insert into users(id,email,pw) values(1,'a@b.c','x')").run();
  const ins = db.prepare("insert into models(id,name,org_id,open,verified,source_type,creator,company_id,verification,url,ctx_tokens) values(?,?,?,?,1,?,?,?,?,?,?)");
  ins.run('hf:Qwen/Qwen3-8B', 'Qwen/Qwen3-8B', 'hf', 1, 'huggingface', 'Qwen', 'qwen', 'verified', 'https://huggingface.co/Qwen/Qwen3-8B', null);
  ins.run('or:qwen/qwen3-8b', 'qwen/qwen3-8b', 'or', 0, 'openrouter', 'qwen', 'qwen', 'reported', 'https://openrouter.ai/qwen/qwen3-8b', 32000);
  ins.run('hf:someone/x', 'someone/x', 'hf', 1, 'huggingface', 'someone', null, 'community', 'https://huggingface.co/someone/x', null);
  db.prepare("insert into watchlist values(1,'or:qwen/qwen3-8b')").run();
  db.prepare("insert into events(sev,ts,model_id,cat,summary) values('Normal','2026-10-01 00:00','or:qwen/qwen3-8b','Model Release','x')").run();
  db.close();
  db = openDb(file);
  assert.strictEqual(db.prepare("select count(*) n from models where canon_key='qwen/qwen3-8b'").get().n, 1);
  const m = db.prepare("select * from models where canon_key='qwen/qwen3-8b'").get();
  assert.strictEqual(m.id, 'hf:Qwen/Qwen3-8B'); assert.strictEqual(m.verification, 'source_verified'); assert.strictEqual(m.ctx_tokens, 32000);
  assert.strictEqual(db.prepare('select model_id m from watchlist').get().m, m.id);
  assert.strictEqual(db.prepare('select model_id m from events').get().m, m.id);
  assert.strictEqual(db.prepare("select verification v from models where id='hf:someone/x'").get().v, 'aggregator_listed');
  db.close(); for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(file + s); } catch (e) { /* ok */ }
});

test('policy keeps official, trending and popular models; cleanup removes only stale low-traction ones with no references', () => {
  assert.strictEqual(keepReason({ likes: 0, downloads: 0 }, { official: true }), 'official');
  assert.strictEqual(keepReason({ likes: 12, downloads: 0 }, { trending: true }), 'trending');
  assert.strictEqual(keepReason({ likes: 3, downloads: 0 }, { trending: true }), null, 'a trending entry with almost no likes or downloads is skipped');
  assert.strictEqual(keepReason({ likes: 25, downloads: 0 }), 'popular');
  assert.strictEqual(keepReason({ likes: 3, downloads: 100 }), null);
  const db = openDb(':memory:');
  db.prepare("insert into users(id,email,pw) values(1,'a@b.c','x')").run();
  const old = '2026-01-01T00:00:00.000Z';
  const ins = db.prepare("insert into models(id,name,org_id,verified,likes,downloads,company_id,seen_at,retrieved_at,rel) values(?,?,'hf',1,?,?,?,?,?,'2026-01-01')");
  ins.run('hf:a/stale', 'a/stale', 1, 10, null, old, old);
  ins.run('hf:a/watched', 'a/watched', 1, 10, null, old, old);
  ins.run('hf:a/cited', 'a/cited', 1, 10, null, old, old);
  ins.run('hf:Qwen/official', 'Qwen/official', 1, 10, 'qwen', old, old);
  ins.run('hf:a/fresh', 'a/fresh', 1, 10, null, new Date().toISOString(), new Date().toISOString());
  ins.run('hf:a/liked', 'a/liked', 15, 10, null, old, old); // above the prune floor but under the keep bar, not seen for a long time
  ins.run('hf:a/big', 'a/big', 500, 99999, null, old, old);
  db.prepare("insert into watchlist values(1,'hf:a/watched')").run();
  db.prepare("insert into model_papers(model_id,arxiv_id,kind) values('hf:a/cited','2401.00001','model_card_tag')").run();
  pruneModels(db);
  const left = db.prepare('select id from models').all().map(r => r.id).sort();
  assert.deepStrictEqual(left, ['hf:Qwen/official', 'hf:a/big', 'hf:a/cited', 'hf:a/fresh', 'hf:a/watched']);
});

test('papers keep the full abstract, every author and all categories from arXiv, with last-checked and primary source role', async () => {
  const db = openDb(':memory:'); only(db, 'arxiv-cs-cl');
  await ingest.runAll(db, async () => res(feed(arxivEntry('2610.00001', { title: 'Qwen Scaling' }))), { arxivDelayMs: 0 });
  const p = db.prepare("select * from papers where arxiv_id='2610.00001'").get();
  assert.ok(p.abstract.length > 1500, 'abstract is not truncated');
  assert.strictEqual(p.authors.split(', ').length, 10, 'all authors are stored');
  assert.strictEqual(p.categories, 'cs.CL,cs.LG'); assert.strictEqual(p.primary_cat, 'cs.CL');
  assert.strictEqual(p.source_role, 'primary'); assert.strictEqual(p.verification, 'source_verified');
  assert.ok(p.last_checked && p.updated_at);
  const first = p.last_checked;
  await new Promise(r => setTimeout(r, 15));
  db.prepare("update sources_config set last_seen=null,last_hash=null where id='arxiv-cs-cl'").run();
  await ingest.runAll(db, async () => res(feed(arxivEntry('2610.00001', { title: 'Qwen Scaling v2' }))), { arxivDelayMs: 0 });
  const q = db.prepare("select * from papers where arxiv_id='2610.00001'").get();
  assert.strictEqual(q.title, 'Qwen Scaling v2'); assert.ok(q.last_checked > first, 'a repeat sighting refreshes the last-checked time');
});

test('model-paper links exist only with evidence; cited papers are fetched from arXiv by id', async () => {
  const db = openDb(':memory:'); only(db, 'hf-new-models', 'arxiv-cs-cl', 'arxiv-cited');
  const urls = [];
  const f = async u => {
    urls.push(String(u));
    if (String(u).includes('huggingface')) return res([hfItem('Qwen/Qwen3-8B', { tags: ['text-generation', 'arxiv:2610.00002'] }), hfItem('someone/popular', { likes: 400, tags: ['arxiv:2610.00003'] }), hfItem('someone/qwen-3-8b-lookalike', { likes: 400 })]);
    if (String(u).includes('id_list')) return res(feed(arxivEntry('2610.00002', { title: 'The Qwen3 Report' }), arxivEntry('2610.00003', { title: 'Popular Tuning' })));
    return res(feed(arxivEntry('2610.00004', { title: 'Qwen3 8B similar name only' }), arxivEntry('2610.00005', { title: 'Uses it', summary: 'Weights are at https://huggingface.co/someone/popular.' })));
  };
  await ingest.runAll(db, f, { arxivDelayMs: 0 });
  const links = db.prepare('select model_id,arxiv_id,kind,claimed_by from model_papers order by arxiv_id').all();
  assert.deepStrictEqual(links.map(l => `${l.model_id}|${l.arxiv_id}|${l.kind}|${l.claimed_by}`), [
    'hf:Qwen/Qwen3-8B|2610.00002|model_card_tag|publisher',
    'hf:someone/popular|2610.00003|model_card_tag|community',
    'hf:someone/popular|2610.00005|abstract_link|paper authors']);
  assert.ok(urls.some(u => u.includes('id_list=2610.00002') && u.includes('2610.00003')), 'cited papers are fetched by id');
  assert.strictEqual(db.prepare("select source_role r from papers where arxiv_id='2610.00002'").get().r, 'primary', 'metadata comes straight from arXiv');
  assert.strictEqual(db.prepare("select count(*) n from model_papers where arxiv_id='2610.00004'").get().n, 0, 'a similar name creates no link');
  assert.strictEqual(linkModelPapers(db), 0, 'linking is idempotent');
});
