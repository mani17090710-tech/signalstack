'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openDb } = require('../lib/db');
const resets = require('../lib/reset');

const file = path.join(os.tmpdir(), 'ss-reset-' + process.pid + '.db');
const db = openDb(file);
test.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(file + s); } catch (e) { /* ok */ } });
const wrong = code => (code === '0000' ? '1111' : '0000');

test('reset codes are 4 digits and work once', () => {
  for (let i = 0; i < 50; i++) assert.match(resets.issue(db, 'a@x.co'), /^\d{4}$/);
  const code = resets.issue(db, 'a@x.co');
  assert.strictEqual(resets.verify(db, 'a@x.co', code), true);
  assert.strictEqual(resets.verify(db, 'a@x.co', code), false, 'a used code cannot be reused');
  assert.strictEqual(resets.verify(db, 'nobody@x.co', '1234'), false);
});
test('five wrong guesses burn the code, even if the right one follows', () => {
  const code = resets.issue(db, 'b@x.co');
  for (let i = 0; i < resets.MAX_ATTEMPTS; i++) assert.strictEqual(resets.verify(db, 'b@x.co', wrong(code)), false);
  assert.strictEqual(resets.verify(db, 'b@x.co', code), false, 'locked out until a new code is requested');
  const fresh = resets.issue(db, 'b@x.co');
  assert.strictEqual(resets.verify(db, 'b@x.co', fresh), true, 'a new code starts a fresh count');
});
test('a few wrong guesses do not lock out the right code; expired codes fail', () => {
  const code = resets.issue(db, 'c@x.co');
  for (let i = 0; i < resets.MAX_ATTEMPTS - 1; i++) resets.verify(db, 'c@x.co', wrong(code));
  assert.strictEqual(resets.verify(db, 'c@x.co', code), true);
  const old = resets.issue(db, 'd@x.co');
  db.prepare('update password_resets set expires=? where email=?').run(Date.now() - 1, 'd@x.co');
  assert.strictEqual(resets.verify(db, 'd@x.co', old), false);
});
