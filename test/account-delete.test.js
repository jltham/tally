// Issue #12: an account that appears on past expenses could never be deleted, so the user's
// details stayed forever and the 10-account cap never freed up. Anonymise it instead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, idFromLocation } from './helpers.js';
import { MAX_USERS } from '../lib/limits.js';

let app;
let ann;
let ben;
let benId;
let groupPath;
before(async () => {
  app = await startApp();
  ann = app.client();
  ben = app.client();
  await ann.signup('Ann', 'ann@x.com');
  await ben.signup('Ben Lim', 'ben@x.com');
  benId = app.userId('ben@x.com');
  const annId = app.userId('ann@x.com');
  groupPath = `/groups/${idFromLocation((await ann.post('/groups', { name: 'Flat 12B', members: String(benId) })).location)}`;
  // Ben pays for groceries, Ann pays him back, Ben leaves.
  await ben.post(`${groupPath}/expenses`, new URLSearchParams([
    ['description', 'Groceries'], ['amount', '40'], ['paid_by', String(benId)], ['spent_on', '2026-11-01'],
    ['split_type', 'equal'], ['participants', String(benId)], ['participants', String(annId)],
  ]));
  await ann.post(`${groupPath}/settlements`, { from_user: String(annId), to_user: String(benId), amount: '20', paid_on: '2026-11-02' });
  assert.equal((await ben.post(`${groupPath}/members/${benId}/remove`)).status, 302);
});
after(() => app.close());

const spotsLeft = async () => Number((await app.client().get('/signup')).text.match(/(\d+) of \d+ spots left/)?.[1]);

test('someone on past expenses can now delete their account', async () => {
  const spotsBefore = await spotsLeft();
  const r = await ben.post('/account/delete', { password: 'password123' });
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login/);

  const row = app.db.prepare('SELECT name, email, password_hash FROM users WHERE id = ?').get(benId);
  assert.equal(row.name, 'Deleted user', 'the row stays so the history adds up, but without his name');
  assert.notEqual(row.email, 'ben@x.com', 'his email is gone');
  assert.ok(!row.password_hash.startsWith('scrypt$'), 'no password can match');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(benId).n, 0);

  assert.equal((await ben.get('/')).status, 302, 'he is signed out');
  assert.equal((await app.client().login('ben@x.com')).status, 401, 'and cannot sign back in');
  assert.equal(await spotsLeft(), spotsBefore + 1, 'his spot is free again');
});

test('the group’s history still adds up and shows “Deleted user”', async () => {
  const r = await ann.get(groupPath);
  assert.match(r.text, /Deleted user paid S\$40\.00/);
  assert.match(r.text, /Everyone is settled up/);
  assert.doesNotMatch(r.text, /Ben Lim/);
});

test('the same email can sign up again as a new account', async () => {
  const again = app.client();
  assert.equal((await again.signup('Ben again', 'ben@x.com')).status, 302);
  assert.notEqual(app.userId('ben@x.com'), benId);
});

test('deleted accounts don’t appear when choosing group members', async () => {
  const r = await ann.get('/groups/new');
  assert.doesNotMatch(r.text, /Deleted user/);
});

test('the reserved address used for deleted accounts can’t be signed up with', async () => {
  const r = await app.client().post('/signup', { name: 'Sneaky', email: `deleted-${benId}@deleted.invalid`, password: 'password123' });
  assert.equal(r.status, 400);
});

test('the account page explains what deleting does', async () => {
  const c = app.client();
  await c.signup('Cy', 'cy@x.com');
  const r = await c.get('/account');
  assert.match(r.text, new RegExp(`Frees up one of the ${MAX_USERS} spots`));
  assert.match(r.text, /“Deleted user”/);
});
