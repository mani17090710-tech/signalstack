'use strict';
// Password-reset codes. The code is 4 digits, so a guess limit matters: after MAX_ATTEMPTS wrong tries the code is
// thrown away and a new one has to be requested. Codes also expire, and work once.
const cr = require('crypto');
const MAX_ATTEMPTS = 5, TTL_MS = 10 * 60 * 1000;

// Creates (or replaces) the code for an email and returns it.
function issue(db, email) {
  const code = String(cr.randomInt(0, 10000)).padStart(4, '0');
  db.prepare(`insert into password_resets(email,code,expires,attempts) values(?,?,?,0)
    on conflict(email) do update set code=excluded.code,expires=excluded.expires,attempts=0`).run(email, code, Date.now() + TTL_MS);
  return code;
}

// True when the code is right and still valid (it is then used up). A wrong guess counts against the limit.
function verify(db, email, code) {
  const row = db.prepare('select * from password_resets where email=?').get(email);
  if (!row) return false;
  if (row.expires < Date.now()) { db.prepare('delete from password_resets where email=?').run(email); return false; }
  const a = Buffer.from(String(row.code)), b = Buffer.from(String(code));
  if (a.length === b.length && cr.timingSafeEqual(a, b)) { db.prepare('delete from password_resets where email=?').run(email); return true; }
  const tries = (row.attempts || 0) + 1;
  if (tries >= MAX_ATTEMPTS) db.prepare('delete from password_resets where email=?').run(email);
  else db.prepare('update password_resets set attempts=? where email=?').run(tries, email);
  return false;
}

module.exports = { issue, verify, MAX_ATTEMPTS, TTL_MS };
