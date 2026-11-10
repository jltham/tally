import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { createApp } from '../server.js';

let server;
let base;
let db;

before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

/** A tiny browser: keeps the session cookie and posts forms. */
function client() {
  let cookie = '';
  const req = async (method, path, form) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      if (c.startsWith('tally_sid=')) cookie = c.split(';')[0];
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  return { get: (p) => req('GET', p), post: (p, f) => req('POST', p, f) };
}

const signup = async (name, email) => {
  const c = client();
  const r = await c.post('/signup', { name, email, password: 'password123' });
  assert.equal(r.status, 302, r.text);
  return c;
};
const idOf = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

test('pages require login', async () => {
  const r = await client().get('/');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login/);
});

test('full flow: group, expenses, balances, settle up, edit, delete', async () => {
  const alice = await signup('Alice', 'a@x.com');
  const bob = await signup('Bob', 'b@x.com');
  const carol = await signup('Carol', 'c@x.com');
  const [a, b, c] = ['a@x.com', 'b@x.com', 'c@x.com'].map(idOf);

  // Create a group with Bob (not Carol)
  let r = await alice.post('/groups', new URLSearchParams([['name', 'Flat'], ['members', String(b)]]));
  assert.equal(r.status, 302);
  const gid = Number(r.location.split('/').pop());

  // Carol is not a member: 404
  assert.equal((await carol.get(`/groups/${gid}`)).status, 404);

  // Alice pays 100 split equally a+b; Bob pays 30 that is all Alice's
  r = await alice.post(`/groups/${gid}/expenses`, new URLSearchParams([
    ['description', 'Groceries'], ['amount', '100'], ['paid_by', String(a)], ['spent_on', '2026-11-01'],
    ['split_type', 'equal'], ['participants', String(a)], ['participants', String(b)],
  ]));
  assert.equal(r.status, 302, r.text);
  r = await bob.post(`/groups/${gid}/expenses`, {
    description: 'Taxi', amount: '30', paid_by: String(b), spent_on: '2026-11-02',
    split_type: 'exact', [`share_${a}`]: '30', [`share_${b}`]: '',
  });
  assert.equal(r.status, 302, r.text);

  // Bad exact split is rejected with a helpful message
  r = await bob.post(`/groups/${gid}/expenses`, {
    description: 'Bad', amount: '30', paid_by: String(b), spent_on: '2026-11-02', split_type: 'exact', [`share_${a}`]: '10',
  });
  assert.equal(r.status, 400);
  assert.match(r.text, /add up to S\$10\.00/);

  // Bob owes Alice 50 - 30 = 20
  r = await alice.get(`/groups/${gid}`);
  assert.match(r.text, /Bob<\/b> pays you <b>S\$20\.00/);
  r = await alice.get('/');
  assert.match(r.text, /owes you S\$20\.00/);

  // Can't remove Bob while he owes money
  r = await alice.post(`/groups/${gid}/members/${b}/remove`, {});
  assert.equal(r.status, 400);

  // Edit the groceries to 60 -> Bob owes 30 - 30 = 0
  const groceries = db.prepare("SELECT id FROM expenses WHERE description = 'Groceries'").get().id;
  r = await bob.post(`/groups/${gid}/expenses/${groceries}`, new URLSearchParams([
    ['description', 'Groceries'], ['amount', '60'], ['paid_by', String(a)], ['spent_on', '2026-11-01'],
    ['split_type', 'equal'], ['participants', String(a)], ['participants', String(b)],
  ]));
  assert.equal(r.status, 302, r.text);
  r = await alice.get(`/groups/${gid}`);
  assert.match(r.text, /Everyone is settled up/);

  // Back to owing: delete the taxi, Bob owes 30; record payment of 30
  const taxi = db.prepare("SELECT id FROM expenses WHERE description = 'Taxi'").get().id;
  assert.equal((await alice.post(`/groups/${gid}/expenses/${taxi}/delete`, {})).status, 302);
  r = await bob.post(`/groups/${gid}/settlements`, { from_user: String(b), to_user: String(a), amount: '30', paid_on: '2026-11-03', note: 'PayNow' });
  assert.equal(r.status, 302, r.text);
  r = await alice.get(`/groups/${gid}`);
  assert.match(r.text, /Everyone is settled up/);
  assert.match(r.text, /PayNow/);

  // Carol cannot touch this group's expense through her own URL space
  assert.equal((await carol.get(`/groups/${gid}/expenses/${groceries}/edit`)).status, 404);

  // Now Bob can be removed; Carol can be added; group renamed; then deleted
  assert.equal((await alice.post(`/groups/${gid}/members/${b}/remove`, {})).status, 302);
  assert.equal((await alice.post(`/groups/${gid}/members`, { members: String(c) })).status, 302);
  assert.equal((await carol.get(`/groups/${gid}`)).status, 200);
  assert.equal((await carol.post(`/groups/${gid}/rename`, { name: 'Flat 2' })).status, 302);
  assert.match((await alice.get('/')).text, /Flat 2/);
  assert.equal((await alice.post(`/groups/${gid}/delete`, {})).status, 302);
  assert.equal((await alice.get(`/groups/${gid}`)).status, 404);
});

test('HTML in user input is escaped', async () => {
  const u = await signup('<script>x</script>', 'xss@x.com');
  const r = await u.get('/');
  assert.ok(!r.text.includes('<script>x</script>'));
  assert.ok(r.text.includes('&lt;script&gt;'));
});

test('login, wrong password, logout', async () => {
  const c = client();
  assert.equal((await c.post('/login', { email: 'a@x.com', password: 'nope' })).status, 401);
  const r = await c.post('/login', { email: 'A@x.com', password: 'password123', next: '//evil.com' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/');
  assert.equal((await c.get('/')).status, 200);
  await c.post('/logout', {});
  assert.equal((await c.get('/')).status, 302);
});

test('account: rename, change password, delete', async () => {
  const c = await signup('Temp', 't@x.com');
  assert.equal((await c.post('/account/name', { name: 'Temp Two' })).status, 302);
  assert.equal((await c.post('/account/password', { current: 'wrong', password: 'newpassword' })).status, 400);
  assert.equal((await c.post('/account/password', { current: 'password123', password: 'newpassword' })).status, 302);
  assert.equal((await c.post('/account/delete', { password: 'newpassword' })).status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 't@x.com'").get().n, 0);
});

test('sign-up closes at 10 users', async () => {
  const have = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  for (let i = have; i < 10; i++) await signup(`User ${i}`, `u${i}@x.com`);
  const r = await client().post('/signup', { name: 'Eleven', email: 'eleven@x.com', password: 'password123' });
  assert.equal(r.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 10);
});
