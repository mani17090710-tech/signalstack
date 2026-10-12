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
  assert.strictEqual((await api('/api/models?verification=source_verified')).body.total, 1);
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
