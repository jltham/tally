// Issue #9: changing your password must sign out every other browser, and expired
// sessions must not pile up in the database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createApp } from '../server.js';
import { startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

const sessionCount = (userId) => app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;

test('changing your password signs out your other browsers, but not this one', async () => {
  const laptop = app.client();
  const sharedPc = app.client();
  await laptop.signup('Gus', 'gus@x.com');
  await sharedPc.login('gus@x.com');
  assert.equal((await sharedPc.get('/')).status, 200);

  const r = await laptop.post('/account/password', { current: 'password123', password: 'a-new-password' });
  assert.equal(r.status, 302);

  assert.equal((await laptop.get('/')).status, 200, 'the browser that changed it stays signed in');
  const other = await sharedPc.get('/');
  assert.equal(other.status, 302, 'the other browser is signed out');
  assert.match(other.location, /^\/login/);
  assert.equal(sessionCount(app.userId('gus@x.com')), 1);
});

test('a failed password change signs nobody out', async () => {
  const one = app.client();
  const two = app.client();
  await one.signup('Hal', 'hal@x.com');
  await two.login('hal@x.com');
  await one.post('/account/password', { current: 'wrong', password: 'a-new-password' });
  assert.equal((await two.get('/')).status, 200);
});

const insertExpired = (db, userId) =>
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(`old-${Math.random()}`, userId, Date.now() - 1000);

test('logging in clears out expired sessions', async () => {
  await app.client().signup('Ida', 'ida@x.com');
  const id = app.userId('ida@x.com');
  insertExpired(app.db, id);
  insertExpired(app.db, id);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ?').get(Date.now()).n, 2);
  await app.client().login('ida@x.com');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ?').get(Date.now()).n, 0);
});

test('starting the app clears out expired sessions', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Jo', 'jo@x.com', 'x')").run();
  insertExpired(db, 1);
  createApp(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});
