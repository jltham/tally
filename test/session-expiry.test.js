import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, idFromLocation } from './helpers.js';

let app;
let groupPath;
before(async () => {
  app = await startApp();
  const owner = app.client();
  await owner.signup('Dee', 'dee@x.com');
  groupPath = `/groups/${idFromLocation((await owner.post('/groups', { name: 'Flat' })).location)}`;
});
after(() => app.close());

const nextOf = (location) => new URL(location, app.base).searchParams.get('next');

test('a signed-out visit to a page comes back to that page after login', async () => {
  const r = await app.client().get(`${groupPath}/expenses/new`);
  assert.equal(r.status, 302);
  assert.equal(nextOf(r.location), `${groupPath}/expenses/new`);
});

test('a form sent after the session expired comes back to the form page after login', async () => {
  const visitor = app.client({ headers: { referer: `${app.base}${groupPath}/expenses/new` } });
  const r = await visitor.post(`${groupPath}/expenses`, { description: 'Dinner', amount: '30' });
  assert.equal(r.status, 302);
  const next = nextOf(r.location);
  assert.equal(next, `${groupPath}/expenses/new`);

  // And that page really exists once signed in (it used to be a POST-only URL: "Not found").
  const signedIn = app.client();
  const login = await signedIn.login('dee@x.com', 'password123', next);
  assert.equal(login.location, next);
  assert.equal((await signedIn.get(login.location)).status, 200);
});

test('a form sent with no referrer comes back to the dashboard', async () => {
  const r = await app.client().post(`${groupPath}/expenses`, { description: 'Dinner' });
  assert.equal(nextOf(r.location), '/');
});

test('a referrer from another site is ignored', async () => {
  const r = await app.client({ headers: { referer: 'http://evil.example/groups/1/expenses/new' } })
    .post(`${groupPath}/expenses`, { description: 'Dinner' });
  assert.equal(nextOf(r.location), '/');
});
