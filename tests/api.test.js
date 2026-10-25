'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openDb } = require('../lib/db');
const ingest = require('../ingest');

const dbFile = path.join(os.tmpdir(), 'ss-test-' + process.pid + '.db');
const port = 3900 + (process.pid % 90);
let child;
const iso = h => new Date(Date.now() - h * 36e5).toISOString();
const res = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } });
const api = async (p, o) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, o); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text(), headers: r.headers }; };

test.before(async () => {
  const db = openDb(dbFile);
  db.exec("update sources_config set enabled=0 where id!='hf-org-qwen'");
  await ingest.runAll(db, async () => res([{ id: 'someone/old', createdAt: iso(500), likes: 1, downloads: 5, tags: [], pipeline_tag: 'text-generation' }]));
  await ingest.runAll(db, async () => res([
    { id: 'Qwen/Qwen3-Coder-27B', createdAt: iso(2), likes: 40, downloads: 9000, tags: ['text-generation', 'license:apache-2.0'], pipeline_tag: 'text-generation' },
    { id: 'Qwen/Qwen3-8B', createdAt: iso(50), likes: 12, downloads: 4000, tags: ['text-generation', 'license:apache-2.0'], pipeline_tag: 'text-generation' },
    { id: 'someone/old', createdAt: iso(500), likes: 1, downloads: 5, tags: [], pipeline_tag: 'text-generation' }]));
  db.close();
  child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: port, DB: dbFile, DISABLE_INGEST: 'true' }, stdio: 'ignore', cwd: path.join(__dirname, '..') });
  for (let i = 0; i < 50; i++) { try { await api('/api/status'); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
test.after(() => { child && child.kill(); for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(dbFile + s); } catch (e) { /* ok */ } });

test('shell, static assets and security headers', async () => {
  const r = await api('/');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.strictEqual((await api('/models/anything')).status, 200, 'SPA routes serve the shell');
  assert.notStrictEqual((await api('/..%2f..%2fetc%2fpasswd.txt')).status, 200, 'path traversal is refused');
});
test('now, signals and models report real ingested data', async () => {
  const now = (await api('/api/now')).body;
  assert.ok(now.top.length >= 1, 'a signal exists for the new lab model');
  assert.ok(now.top[0].score >= 0 && now.top[0].why.length > 0);
  assert.strictEqual(now.top[0].verification, 'source_verified', 'a release from a lab\'s own Hugging Face account comes straight from the publisher');
  const sig = (await api('/api/signals?window=24h')).body;
  assert.ok(sig.items.every(s => s.url && s.ts), 'every signal has a source link and a date');
  const f = (await api('/api/models/facets')).body;
  assert.ok(f.cats.find(c => c.id === 'coding').n >= 1);
  const list = (await api('/api/models?cat=coding&sort=new')).body;
  assert.strictEqual(list.items[0].id, 'hf:Qwen/Qwen3-Coder-27B');
  assert.strictEqual(list.items[0].company, 'Alibaba Qwen');
});
test('model detail, company and grouped search', async () => {
  const d = await api('/api/models/' + encodeURIComponent('hf:Qwen/Qwen3-Coder-27B'));
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.model.params, '27B');
  assert.ok(d.body.signal.why.length);
  assert.strictEqual((await api('/api/models/nope')).status, 404);
  assert.ok((await api('/api/companies/qwen')).body.models.length >= 1);
  const s = (await api('/api/search?q=qwen')).body;
  assert.ok(s.models.length && s.companies.length);
  assert.ok(s.models.every(x => x.type === 'model' && x.verification_label), 'search results say what they are and how they are sourced');
  assert.ok(s.companies.every(x => x.type === 'company'));
});
test('now is a ranked, grouped briefing and search matches words in any order', async () => {
  const now = (await api('/api/now')).body;
  assert.ok(Array.isArray(now.groups) && now.groups.every(g => g.items.length <= 5 && ['models', 'papers', 'labs'].includes(g.id)));
  assert.ok(now.lead && now.lead.rank >= 0 && !now.groups.some(g => g.items.some(i => i.id === now.lead.id)), 'the lead story is not repeated in its group');
  const ids = now.groups.flatMap(g => g.items.map(i => i.model_id || i.url));
  assert.strictEqual(new Set(ids).size, ids.length, 'each model or source appears once');
  for (const g of now.groups) for (let i = 1; i < g.items.length; i++) assert.ok(g.items[i - 1].rank >= g.items[i].rank, 'ranked best first');
  const fwd = (await api('/api/search?q=' + encodeURIComponent('qwen coder'))).body, rev = (await api('/api/search?q=' + encodeURIComponent('coder qwen'))).body;
  assert.ok(fwd.models.some(m => m.id === 'hf:Qwen/Qwen3-Coder-27B') && rev.models.some(m => m.id === 'hf:Qwen/Qwen3-Coder-27B'), 'word order does not matter');
  assert.strictEqual((await api('/api/search?q=' + encodeURIComponent('zzzzqqq'))).body.models.length, 0);
  const sig = (await api('/api/signals?window=30d&cat=' + encodeURIComponent('Model Release,Trending'))).body;
  assert.ok(sig.items.every(s => ['Model Release', 'Trending'].includes(s.cat)), 'several categories can be asked for at once');
  assert.ok((await api('/api/papers?days=7')).body.total >= 0);
});

test('lab pages list their series; a series has a timeline; the model page links to it', async () => {
  const c = (await api('/api/companies/qwen')).body;
  assert.ok(c.stats.models >= 2 && Array.isArray(c.papers) && c.company.hf.includes('Qwen'), 'lab page carries counts, papers and the accounts we monitor');
  assert.ok(c.series.some(g => g.key === 'qwen:qwen' && g.count >= 2));
  const f = await api('/api/families/qwen/qwen');
  assert.strictEqual(f.status, 200);
  assert.deepStrictEqual(f.body.generations.map(g => g.label), ['Qwen3', 'Qwen3 Coder']);
  assert.strictEqual((await api('/api/families/qwen/nope')).status, 404);
  const d = (await api('/api/models/' + encodeURIComponent('hf:Qwen/Qwen3-8B'))).body;
  assert.strictEqual(d.family.label, 'Qwen'); assert.ok(d.family.generations.some(g => g.current));
});

test('signals say whether the link is on the lab\'s own domain, and now reports trust figures', async () => {
  const now = (await api('/api/now')).body;
  assert.ok(typeof now.counts.week === 'number' && now.counts.sources > 0);
  assert.ok(now.top.every(s => typeof s.official_domain === 'boolean' && s.source_type));
});

test('hover preview returns the short version with a score and a source, and 404s unknown models', async () => {
  const d = await api('/api/models/' + encodeURIComponent('hf:Qwen/Qwen3-Coder-27B') + '/preview');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.model.params, '27B');
  assert.ok(d.body.signal.score >= 0 && d.body.signal.score <= 100 && d.body.signal.why.length <= 3);
  assert.ok('source_url' in d.body);
  assert.strictEqual((await api('/api/models/nope/preview')).status, 404);
});

test('model page keeps verification (evidence) separate from discovery (sources)', async () => {
  const d = (await api('/api/models/' + encodeURIComponent('hf:Qwen/Qwen3-Coder-27B'))).body;
  assert.strictEqual(d.verification.status, 'source_verified', 'an official Hugging Face namespace is source verified, not verified');
  assert.notStrictEqual(d.verification.status, 'verified', 'only the provider\'s own documentation can make a model Verified');
  assert.ok(d.verification.evidence.some(e => e.kind === 'publisher_namespace' && /huggingface\.co\/Qwen/.test(e.url)));
  assert.ok(d.verification.last_verified);
  assert.ok(d.discovery.some(x => x.source === 'huggingface'), 'discovery lists where it was found');
  assert.ok(Array.isArray(d.papers));
  const list = (await api('/api/models?verification=verified')).body;
  assert.strictEqual(list.total, 0, 'nothing is Verified without official evidence');
  assert.strictEqual((await api('/api/models?verification=source_verified')).body.total, 2);
  assert.match((await api('/api/status')).body.coverage, /does not claim to list every/);
});
test('auth requires accepting the terms; personal routes need login', async () => {
  const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b) });
  assert.strictEqual((await post('/api/signup', { email: 'a@b.co', password: 'longenough' })).status, 400);
  const ok = await post('/api/signup', { email: 'a@b.co', password: 'longenough', accept: true });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual((await api('/api/watchlist')).status, 401);
  assert.strictEqual((await api('/api/admin/summary')).status, 401);
});
test('admin database backup downloads a valid SQLite file and is admin-only', async () => {
  const base = `http://127.0.0.1:${port}`;
  assert.strictEqual((await fetch(base + '/api/admin/backup')).status, 401, 'no login, no backup');
  const login = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'longenough' }) });
  assert.strictEqual(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await fetch(base + '/api/admin/backup', { headers: { cookie } });
  assert.strictEqual(r.status, 200, 'the first account is the admin');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="signalstack-backup-.*\.sqlite"/);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 15).toString(), 'SQLite format 3', 'a real SQLite database');
  const temp = fs.readdirSync(os.tmpdir()).filter(f => /^signalstack-[0-9a-f]{24}\.sqlite$/.test(f));
  assert.strictEqual(temp.length, 0, 'the temporary copy is deleted after sending');
});

test('following labs and series is private and feeds the Watching list', async () => {
  const base = `http://127.0.0.1:${port}`, post = (path, body, cookie, method = 'POST') => fetch(base + path, { method, headers: { cookie: cookie || '' }, body: JSON.stringify(body || {}) });
  assert.strictEqual((await fetch(base + '/api/follows')).status, 401);
  const login = await post('/api/login', { email: 'a@b.co', password: 'longenough' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await post('/api/follows', { kind: 'lab', key: 'nope' }, cookie)).status, 400, 'unknown labs are refused');
  assert.strictEqual((await post('/api/follows', { kind: 'bogus', key: 'qwen' }, cookie)).status, 400);
  let r = await (await post('/api/follows', { kind: 'lab', key: 'qwen' }, cookie)).json();
  assert.deepStrictEqual(r, [{ kind: 'lab', key: 'qwen' }]);
  await post('/api/follows', { kind: 'family', key: 'qwen:qwen' }, cookie);
  const w = await (await fetch(base + '/api/watching', { headers: { cookie } })).json();
  assert.ok(w.items.length >= 1 && w.items.every(i => i.because), 'every item says why it is there');
  assert.strictEqual(w.follows.labs[0].id, 'qwen');
  r = await (await post('/api/follows', { kind: 'lab', key: 'qwen' }, cookie, 'DELETE')).json();
  assert.deepStrictEqual(r, [{ kind: 'family', key: 'qwen:qwen' }]);
});
