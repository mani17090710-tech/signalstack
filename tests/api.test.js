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
  // Three papers: two name Qwen, one names OpenAI (entities is the list of labs a paper names).
  const ip = db.prepare('insert into papers(id,title,date,published_at,url,verified,entities,primary_cat,verification,source_type,source_role,arxiv_id) values(?,?,?,?,?,1,?,?,?,?,?,?)');
  ip.run('arxiv:2610.00001', 'Qwen scaling study', iso(30).slice(0, 10), iso(30).slice(0, 10), 'https://arxiv.org/abs/2610.00001', '["qwen"]', 'cs.CL', 'source_verified', 'arxiv', 'primary', '2610.00001');
  ip.run('arxiv:2610.00002', 'Qwen3 technical report', iso(10).slice(0, 10), iso(10).slice(0, 10), 'https://arxiv.org/abs/2610.00002', '["qwen"]', 'cs.CL', 'source_verified', 'arxiv', 'primary', '2610.00002');
  ip.run('arxiv:2610.00003', 'A GPT study', iso(5).slice(0, 10), iso(5).slice(0, 10), 'https://arxiv.org/abs/2610.00003', '["openai"]', 'cs.LG', 'source_verified', 'arxiv', 'primary', '2610.00003');
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

test('collections: save, organise, and keep a snapshot; important signals carry a plain "why this matters" note', async () => {
  const base = `http://127.0.0.1:${port}`, call = async (path, method, body, cookie) => { const r = await fetch(base + path, { method, headers: { cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }; };
  assert.strictEqual((await call('/api/collections', 'GET')).status, 401);
  const cookie = (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'longenough' }) })).headers.get('set-cookie').split(';')[0];
  let r = (await call('/api/collections', 'GET', null, cookie)).body;
  assert.strictEqual(r.collections.length, 1); const first = r.collections[0].id;
  const sig = (await api('/api/signals?window=30d')).body.items[0];
  r = (await call('/api/saved', 'POST', { kind: 'signal', ref: String(sig.id) }, cookie)).body;
  assert.ok(r.saved.includes('signal|' + sig.id));
  r = (await call('/api/saved', 'POST', { kind: 'model', ref: 'hf:Qwen/Qwen3-8B' }, cookie)).body;
  assert.strictEqual(r.collections[0].n, 2);
  assert.strictEqual((await call('/api/saved', 'POST', { kind: 'model', ref: 'hf:nope/none' }, cookie)).status, 404, 'unknown items cannot be saved');
  const nc = (await call('/api/collections', 'POST', { name: 'To read' }, cookie)).body.collections.find(c => c.name === 'To read').id;
  assert.strictEqual((await call('/api/collections', 'POST', { name: 'To read' }, cookie)).status, 400, 'names are unique');
  await call('/api/saved/move', 'POST', { kind: 'model', ref: 'hf:Qwen/Qwen3-8B', from: first, to: nc }, cookie);
  const inNew = (await call('/api/saved?collection=' + nc, 'GET', null, cookie)).body.items;
  assert.deepStrictEqual(inNew.map(i => [i.kind, i.ref, i.title]), [['model', 'hf:Qwen/Qwen3-8B', 'Qwen3-8B']]);
  assert.strictEqual((await call('/api/collections', 'DELETE', { id: first }, cookie)).status, 400, 'the first collection stays');
  assert.strictEqual((await call('/api/collections', 'DELETE', { id: nc }, cookie)).status, 200);
  const imp = (await api('/api/signals?window=30d')).body.items.filter(s => s.score >= 60);
  assert.ok(imp.length && imp.every(s => s.matters === null || (typeof s.matters === 'string' && s.matters.length > 20)));
  assert.ok((await api('/api/signals?window=30d')).body.items.filter(s => s.score < 60).every(s => s.matters === null), 'no note on minor signals');
});

test('public API v1, RSS feed and embeddable widget', async () => {
  const base = `http://127.0.0.1:${port}`;
  const s = await fetch(base + '/api/v1/signals?window=30d&limit=3');
  assert.strictEqual(s.headers.get('access-control-allow-origin'), '*');
  const sb = await s.json();
  assert.ok(sb.data.length && sb.meta.attribution && sb.meta.total >= sb.data.length);
  assert.ok(sb.data.every(x => x.source && 'verification' in x.source && x.type && x.published_at && !('detail' in x)), 'stable public shape');
  const m = (await (await fetch(base + '/api/v1/models?limit=2')).json());
  assert.ok(m.data.length && m.data[0].access && 'parameters' in m.data[0]);
  assert.strictEqual((await fetch(base + '/api/v1/signals', { method: 'OPTIONS' })).status, 204);
  assert.ok((await (await fetch(base + '/api/v1/labs')).json()).data.some(c => c.id === 'openai'));
  const feed = await fetch(base + '/feed.xml?window=30d');
  assert.match(feed.headers.get('content-type'), /rss\+xml/);
  const xmlText = await feed.text(); assert.match(xmlText, /^<\?xml/); assert.ok((xmlText.match(/<item>/g) || []).length >= 1);
  const w = await fetch(base + '/embed/now?limit=3&theme=light');
  assert.strictEqual(w.headers.get('x-frame-options'), null, 'the widget may be framed');
  assert.match(w.headers.get('content-security-policy'), /frame-ancestors \*/); assert.match(w.headers.get('content-security-policy'), /default-src 'none'/);
  const wh = await w.text(); assert.match(wh, /Powered by/); assert.doesNotMatch(wh, /<script/i);
  const app = await fetch(base + '/'); assert.strictEqual(app.headers.get('x-frame-options'), 'DENY', 'the app itself still cannot be framed');
});

test('email digest: preferences, preview, one-click unsubscribe, and a test send that needs email to be set up', async () => {
  const base = `http://127.0.0.1:${port}`, call = async (path, method, body, cookie) => { const r = await fetch(base + path, { method, headers: { cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  assert.strictEqual((await call('/api/digest', 'GET')).status, 401);
  const cookie = (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'longenough' }) })).headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await call('/api/digest', 'GET', null, cookie)).body.freq, 'off');
  let r = (await call('/api/digest', 'POST', { freq: 'weekly', hour: 99, tz_offset: 330 }, cookie)).body;
  assert.deepStrictEqual([r.freq, r.hour, r.tz_offset, r.emailConfigured], ['weekly', 23, 330, false], 'values are clamped; email reports whether it is set up');
  assert.strictEqual((await call('/api/digest', 'POST', { freq: 'hourly' }, cookie)).body.freq, 'off', 'unknown frequencies turn it off');
  const pv = (await call('/api/digest/preview?freq=daily', 'GET', null, cookie)).body;
  assert.match(pv.subject, /^Today in AI/); assert.match(pv.html, /Stop these emails/); assert.match(pv.html, /unsubscribe\?t=[a-f0-9]{32}/);
  assert.strictEqual((await call('/api/digest/test', 'POST', {}, cookie)).status, 400, 'no email key: says so instead of pretending');
  const tok = pv.html.match(/unsubscribe\?t=([a-f0-9]{32})/)[1];
  await call('/api/digest', 'POST', { freq: 'daily', hour: 8, tz_offset: 0 }, cookie);
  const un = await fetch(base + '/digest/unsubscribe?t=' + tok); assert.strictEqual(un.status, 200); assert.match(await un.text(), /Unsubscribed/);
  assert.strictEqual((await call('/api/digest', 'GET', null, cookie)).body.freq, 'off');
  assert.match(await (await fetch(base + '/digest/unsubscribe?t=bad')).text(), /Link expired/);
});

test('lab radar: every lab reports its activity state, sources and last signal; the lab page leads with recent signals', async () => {
  const list = (await api('/api/companies')).body;
  assert.ok(list.length > 10 && list.every(c => ['active', 'quiet', 'idle'].includes(c.state) && Array.isArray(c.sources) && typeof c.signals7d === 'number'));
  assert.ok(list.every(c => c.state === 'idle' ? c.signals30d === 0 : c.signals30d > 0 && c.last_signal), 'state agrees with the counts and the last-signal date');
  assert.ok(list.every(c => c.signals7d <= c.signals30d));
  const q = list.find(c => c.id === 'qwen'); assert.deepStrictEqual(q.sources, ['Hugging Face', 'Website', 'OpenRouter'], 'sources come from the accounts we watch (Qwen has no GitHub account on our list)');
  const d = (await api('/api/companies/qwen')).body;
  assert.ok(d.activity && d.activity.n30 === q.signals30d && d.activity.state === q.state, 'list and lab page agree');
  assert.ok(Array.isArray(d.recent) && d.recent.length <= 6 && d.recent.every((s, i, a) => !i || a[i - 1].ts >= s.ts), 'newest first');
  assert.strictEqual(d.activity.last, d.recent.length ? d.recent[0].ts : null, 'the last-signal date is the newest recent item');
});

test('models "Best first" puts publisher-confirmed models ahead of catalogue listings; paper lab counts match the lists; score rules come from the server', async () => {
  const RANK = { verified: 0, source_verified: 1, aggregator_listed: 2 };
  const m = (await api('/api/models?sort=best&limit=100')).body.items, ranks = m.map(x => RANK[x.verification] ?? 3);
  assert.ok(m.length > 1 && ranks.every((r, i) => !i || ranks[i - 1] <= r), 'verification tier never goes back up');
  const labs = (await api('/api/papers/labs')).body; 
  assert.strictEqual(labs.total, 3); assert.deepStrictEqual(labs.labs.map(l => [l.id, l.n]), [['qwen', 2], ['openai', 1]]); assert.ok(labs.labs.every((l, i, a) => l.n > 0 && l.name && (!i || a[i - 1].n >= l.n)), 'labs are listed by paper count');
  for (const l of labs.labs.slice(0, 3)) assert.strictEqual((await api('/api/papers?company=' + l.id + '&limit=1')).body.total, l.n, 'the count equals what the filter returns for ' + l.id);
  assert.strictEqual((await api('/api/papers/labs?q=zzzznomatch')).body.labs.length, 0);
  const sc = (await api('/api/status')).body.score;
  assert.ok(Math.abs(Object.values(sc.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9 && sc.significant === 60 && sc.major === 80);
});

test('admin sources: health list, pause / resume, refresh, validation, add and remove', async () => {
  const base = `http://127.0.0.1:${port}`, call = async (path, method, body, cookie) => { const r = await fetch(base + path, { method, headers: { cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  assert.strictEqual((await call('/api/admin/sources', 'GET')).status, 401);
  const cookie = (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'longenough' }) })).headers.get('set-cookie').split(';')[0];
  let r = (await call('/api/admin/sources', 'GET', null, cookie)).body;
  const STATES = ['failing', 'stale', 'warning', 'new', 'healthy', 'paused'];
  assert.ok(r.summary.total > 20 && r.sources.length === r.summary.total && r.sources.every(s => STATES.includes(s.state) && Array.isArray(s.history) && s.watch && typeof s.builtin === 'boolean'));
  const idx = r.sources.map(s => STATES.indexOf(s.state)); assert.ok(idx.every((v, i) => !i || idx[i - 1] <= v), 'worst first');
  assert.ok(r.sources.find(s => s.id === 'hf-org-qwen').builtin && r.sources.find(s => s.id === 'hf-org-qwen').watch_url);
  // pause and resume
  let t = (await call('/api/admin/sources/toggle', 'POST', { id: 'hf-org-qwen', enabled: false }, cookie)).body; assert.strictEqual(t.source.state, 'paused');
  t = (await call('/api/admin/sources/toggle', 'POST', { id: 'hf-org-qwen', enabled: true }, cookie)).body; assert.strictEqual(t.source.enabled, true); assert.notStrictEqual(t.source.state, 'paused');
  assert.strictEqual((await call('/api/admin/sources/toggle', 'POST', { id: 'nope', enabled: false }, cookie)).status, 404);
  // refresh a source that reads a local file, so this needs no network
  const rf = await call('/api/admin/sources/refresh', 'POST', { id: 'curated-models' }, cookie);
  assert.strictEqual(rf.status, 200); assert.ok(['ok', 'unchanged'].includes(rf.body.result.status), rf.body.result.message); assert.ok(rf.body.source.last_run && rf.body.source.history.length >= 1);
  assert.strictEqual((await call('/api/admin/sources/refresh', 'POST', { id: 'nope' }, cookie)).status, 404);
  // validation: nothing unsafe or malformed is accepted
  for (const b of [{ kind: 'feed', url: 'http://example.com/rss' }, { kind: 'feed', url: 'https://localhost/rss' }, { kind: 'feed', url: 'https://169.254.169.254/x' }, { kind: 'github', repo: 'x' }, { kind: 'huggingface', author: '' }, { kind: 'arxiv' }])
    for (const path of ['test', 'add']) assert.strictEqual((await call('/api/admin/sources/' + path, 'POST', b, cookie)).status, 400, path + ' ' + JSON.stringify(b));
  // add (whatever the network says about it, the source is saved and reports its first result), refuse a duplicate, then remove
  const add = await call('/api/admin/sources/add', 'POST', { kind: 'github', repo: 'no-such-org-xyz/no-such-repo-xyz' }, cookie);
  assert.strictEqual(add.status, 200); assert.strictEqual(add.body.source.id, 'gh-no-such-org-xyz-no-such-repo-xyz'); assert.strictEqual(add.body.source.builtin, false);
  assert.strictEqual((await call('/api/admin/sources/add', 'POST', { kind: 'github', repo: 'https://github.com/no-such-org-xyz/no-such-repo-xyz' }, cookie)).status, 409, 'same repo, different spelling');
  assert.strictEqual((await call('/api/admin/sources/add', 'POST', { kind: 'github', repo: 'huggingface/transformers' }, cookie)).status, 409, 'already a built-in source');
  assert.strictEqual((await call('/api/admin/sources/remove', 'POST', { id: 'hf-org-qwen' }, cookie)).status, 400, 'built-in sources can only be paused');
  assert.strictEqual((await call('/api/admin/sources/remove', 'POST', { id: add.body.source.id }, cookie)).status, 200);
  assert.ok(!(await call('/api/admin/sources', 'GET', null, cookie)).body.sources.some(s => s.id === add.body.source.id));
});

test('signal moderation: score, Major, note, hide everywhere, reset, manual add; admin-only; overview numbers', async () => {
  const base = `http://127.0.0.1:${port}`, call = async (path, method, body, cookie) => { const r = await fetch(base + path, { method, headers: { cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const login = async (email, password) => (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email, password }) })).headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await call('/api/admin/signals', 'GET')).status, 401);
  await fetch(base + '/api/signup', { method: 'POST', body: JSON.stringify({ email: 'plain@b.co', password: 'longenough', accept: true }) });
  const plain = await login('plain@b.co', 'longenough'); assert.strictEqual((await call('/api/admin/signals', 'GET', null, plain)).status, 403, 'signed in but not an admin');
  assert.strictEqual((await call('/api/admin/signals/update', 'POST', { id: 1, hidden: true }, plain)).status, 403);
  const admin = await login('a@b.co', 'longenough');
  const target = (await api('/api/signals?window=30d')).body.items[0], id = target.id, upd = b => call('/api/admin/signals/update', 'POST', { id, ...b }, admin);
  const pubHas = async () => (await api('/api/signals?window=30d')).body.items.some(s => s.id === id);
  // score and Major
  let s = (await upd({ score: 12 })).body.signal;
  assert.deepStrictEqual([s.score, s.importance, s.score_edited, s.calculated], [12, 'Normal', true, target.score]);
  assert.strictEqual((await api('/api/signals?window=30d')).body.items.find(x => x.id === id).score, 12, 'the public sees the edited score');
  s = (await upd({ score: 85 })).body.signal; assert.strictEqual(s.importance, 'Major');
  assert.strictEqual((await upd({ score: 101 })).status, 400);
  // note: edited text, no note, back to automatic
  s = (await upd({ matters: 'An editor wrote this.' })).body.signal; assert.deepStrictEqual([s.matters, s.matters_edited], ['An editor wrote this.', true]);
  s = (await upd({ matters: '' })).body.signal; assert.strictEqual(s.matters, null, 'an empty note shows nothing');
  s = (await upd({ matters: null })).body.signal; assert.ok(!s.matters_edited, 'automatic again');
  // hide: gone from every public surface, still in the admin table, and can be restored
  await upd({ hidden: true });
  assert.strictEqual((await api('/api/signals/' + id)).status, 404, 'permalink API'); assert.strictEqual((await api('/s/' + id)).status, 404, 'permalink page');
  assert.ok(!(await api('/sitemap.xml')).body.includes('/s/' + id + '<'), 'sitemap');
  assert.ok(!(await pubHas()), '/api/signals');
  assert.ok(!(await api('/api/v1/signals?window=30d&limit=200')).body.data.some(x => x.id === id), '/api/v1/signals');
  assert.ok(!(await api('/feed.xml?window=30d')).body.includes(String(target.title).replace(/&/g, '&amp;')) || target.title.length < 4, 'RSS feed');
  const now = (await api('/api/now')).body; assert.ok(![now.lead, ...now.groups.flatMap(g => g.items), ...now.top].some(x => x && x.id === id), '/api/now');
  const hid = (await call('/api/admin/signals?window=all&filter=hidden', 'GET', null, admin)).body; assert.ok(hid.items.some(x => x.id === id && x.hidden));
  await upd({ hidden: false }); assert.ok(await pubHas(), 'restored');
  assert.strictEqual((await api('/api/signals/' + id)).status, 200);
  // reset removes every edit
  await upd({ score: 5, matters: 'x y z' }); s = (await upd({ reset: true })).body.signal;
  assert.deepStrictEqual([s.score, s.score_edited, s.matters_edited], [target.score, undefined, undefined]);
  assert.strictEqual((await call('/api/admin/signals/update', 'POST', { id: 99999999, hidden: true }, admin)).status, 404);
  assert.ok(!JSON.stringify((await api('/api/signals?window=30d')).body).includes('a@b.co'), 'editor emails are never public');
  // add by hand
  const body = { title: 'OpenAI announces a thing', url: 'https://openai.com/index/a-thing', cat: 'Announcement', company: 'openai', summary: 'Short summary.', matters: 'Why it matters here.' };
  assert.strictEqual((await call('/api/admin/signals/add', 'POST', { ...body, url: 'javascript:1' }, admin)).status, 400);
  const add = await call('/api/admin/signals/add', 'POST', body, admin); assert.strictEqual(add.status, 200);
  const m = add.body.signal; assert.deepStrictEqual([m.manual, m.source_type, m.verification, m.official_domain, m.matters, m.company_id], [true, 'manual', 'source_verified', true, 'Why it matters here.', 'openai']);
  assert.ok((await api('/api/signals?window=24h')).body.items.some(x => x.id === m.id), 'it appears on the site');
  assert.strictEqual((await call('/api/admin/signals/add', 'POST', body, admin)).status, 409, 'same link twice');
  const off = (await call('/api/admin/signals/add', 'POST', { ...body, url: 'https://news.example.com/openai-thing' }, admin)).body.signal; assert.strictEqual(off.verification, 'aggregator_listed', 'a link off the lab’s site is only "found elsewhere"');
  assert.ok((await call('/api/admin/signals?window=all&filter=manual', 'GET', null, admin)).body.items.length >= 2);
  // overview numbers
  const sm = (await call('/api/admin/summary', 'GET', null, admin)).body;
  assert.ok(sm.live.models >= 2 && sm.live.signals24h >= 2 && sm.live.signals7d >= sm.live.signals24h && sm.sourceHealth.total > 20 && 'healthy' in sm.sourceHealth && 'failing' in sm.sourceHealth);
  // reports inbox (messages are sent from the public Contact form in the next test file section)
  await fetch(base + '/api/report', { method: 'POST', body: JSON.stringify({ kind: 'issue', message: 'The Qwen model page shows the wrong size.', contact: 'me@x.co' }) });
  assert.strictEqual((await call('/api/admin/reports', 'GET')).status, 401);
  const list = (await call('/api/admin/reports', 'GET', null, admin)).body;
  assert.ok(list.items.length >= 1 && list.open >= 1);
  assert.strictEqual((await call('/api/admin/reports/update', 'POST', { id: list.items[0].id, status: 'done' }, admin)).status, 200);
  assert.ok((await call('/api/admin/reports', 'GET', null, admin)).body.open < list.open);
  assert.strictEqual((await call('/api/admin/reports/update', 'POST', { id: 9999, status: 'done' }, admin)).status, 404);
  // newsletter list: admin-only, CSV safe against spreadsheet formulas
  await fetch(base + '/api/subscribe', { method: 'POST', body: JSON.stringify({ email: '=cmd@x.co' }) });
  assert.strictEqual((await call('/api/admin/subscribers', 'GET')).status, 401);
  const subs = (await call('/api/admin/subscribers', 'GET', null, admin)).body; assert.ok(subs.count >= 1 && subs.brevo === false);
  const csv = await (await fetch(base + '/api/admin/subscribers.csv', { headers: { cookie: admin } })).text(); assert.match(csv, /^email,subscribed,source,status\n/); assert.ok(!/^"=/m.test(csv) && /"'=cmd@x.co"/.test(csv), 'formula prefix neutralised');
});

test('trust pages: public sources summary, report form validation, honeypot, rate limit and admin inbox', async () => {
  const base = `http://127.0.0.1:${port}`, call = async (path, method, body, cookie) => { const r = await fetch(base + path, { method, headers: { cookie: cookie || '' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const src = await call('/api/sources/public', 'GET');
  assert.strictEqual(src.status, 200); assert.ok(src.body.total >= 1 && src.body.groups.length >= 1 && src.body.intervalMin > 0 && src.body.groups.every(g => g.label && g.count >= 1));
  assert.ok(!JSON.stringify(src.body).includes('config') && !JSON.stringify(src.body).includes('http'), 'no addresses or settings are public');
  assert.strictEqual((await call('/api/report', 'POST', { kind: 'issue', message: 'short' })).status, 400);
  assert.strictEqual((await call('/api/report', 'POST', { kind: 'issue', message: 'The Qwen model page shows the wrong size.', contact: 'not-an-email' })).status, 400);
  assert.strictEqual((await call('/api/report', 'POST', { kind: 'issue', message: 'The Qwen model page shows the wrong size.', contact: 'me@x.co' })).status, 201);
  assert.strictEqual((await call('/api/report', 'POST', { kind: 'issue', message: 'Bot message that should be dropped', website: 'http://spam' })).status, 200, 'honeypot looks successful but stores nothing');
  for (let i = 0; i < 4; i++) await call('/api/report', 'POST', { kind: 'other', message: 'Another ordinary message number ' + i });
  assert.strictEqual((await call('/api/report', 'POST', { kind: 'other', message: 'One message too many from this address' })).status, 429);
});

test('app shell: service worker and the static loading shell are served', async () => {
  const base = `http://127.0.0.1:${port}`;
  const sw = await fetch(base + '/sw.js'); assert.strictEqual(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/); assert.match(await sw.text(), /ss-shell/);
  const html = await (await fetch(base + '/')).text(); assert.match(html, /Waking up the signal engine/); assert.match(html, /class="boot"/);
});


test('discovery and sharing: search/source/min score/trending filters, permalinks with social tags, sitemap, status strip data, newsletter signup', async () => {
  const base = `http://127.0.0.1:${port}`, get = async p => { const r = await fetch(base + p); const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch (e) { /* html or xml */ } return { status: r.status, body: b, headers: r.headers }; };
  const all = (await get('/api/signals?window=30d&limit=100')).body.items; assert.ok(all.length >= 2);
  const first = all[0], word = String(first.title).split(/\s+/).find(w => w.length > 3) || first.title;
  const byName = (await get('/api/signals?window=30d&q=' + encodeURIComponent(word))).body.items; assert.ok(byName.length >= 1 && byName.every(x => [x.title, x.summary, x.company, x.model_id].join(' ').toLowerCase().includes(word.toLowerCase())));
  assert.strictEqual((await get('/api/signals?window=30d&q=zzzqqxx')).body.total, 0);
  const types = [...new Set(all.map(x => x.source_type).filter(Boolean))]; assert.ok(types.length >= 1);
  const bySrc = (await get('/api/signals?window=30d&source=' + types[0])).body.items; assert.ok(bySrc.length >= 1 && bySrc.every(x => x.source_type === types[0]));
  assert.ok((await get('/api/signals?window=30d&minScore=101')).body.total === 0);
  const hi = (await get('/api/signals?window=30d&sort=score')).body.items.map(x => x.score); assert.deepStrictEqual(hi, [...hi].sort((a, b) => b - a));
  assert.ok((await get('/api/signals?window=30d&sort=trending')).body.items.length >= 1);
  // permalink API and page
  const one = (await get('/api/signals/' + first.id)); assert.strictEqual(one.status, 200); assert.strictEqual(one.body.id, first.id);
  assert.strictEqual((await get('/api/signals/99999999')).status, 404);
  const page = await get('/s/' + first.id); assert.strictEqual(page.status, 200); const h = page.body;
  assert.ok(h.includes(`<link rel="canonical" href="http://127.0.0.1:${port}/s/${first.id}">`), 'canonical');
  for (const t of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card', 'twitter:image']) assert.ok(h.includes(t), t);
  assert.ok(!h.includes('<script'), 'no scripts on the permalink page'); assert.ok(h.includes('Open source'));
  const miss = await get('/s/99999999'); assert.strictEqual(miss.status, 404); assert.ok(miss.body.includes('noindex'));
  const idx = (await get('/')).body; assert.ok(idx.includes(`rel="canonical" href="http://127.0.0.1:${port}/"`) && idx.includes('og:image') && !idx.includes('__BASE__'));
  assert.strictEqual((await fetch(base + '/og.png')).headers.get('content-type'), 'image/png');
  const sm = await get('/sitemap.xml'); assert.ok(sm.body.includes('<urlset') && sm.body.includes('/s/' + first.id)); assert.ok((await get('/robots.txt')).body.includes('Sitemap:'));
  // status strip data
  const st = (await get('/api/status')).body.crawl; assert.ok(st && typeof st.checked === 'number' && typeof st.failing === 'number' && 'lastOk' in st);
  // newsletter signup
  const post = (path, b) => fetch(base + path, { method: 'POST', body: JSON.stringify(b) });
  assert.strictEqual((await post('/api/subscribe', { email: 'nope' })).status, 400);
  assert.strictEqual((await post('/api/subscribe', { email: 'reader@x.co' })).status, 200); assert.strictEqual((await post('/api/subscribe', { email: 'reader@x.co' })).status, 200, 'twice is fine');
  assert.strictEqual((await post('/api/subscribe', { email: 'bot@x.co', website: 'http://spam' })).status, 200, 'honeypot looks successful');
  for (let i = 0; i < 6; i++) await post('/api/subscribe', { email: `r${i}@x.co` });
  assert.strictEqual((await post('/api/subscribe', { email: 'late@x.co' })).status, 429);
});
