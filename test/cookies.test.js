import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { parseCookies } from '../lib/auth.js';

// Cookies on localhost are shared by every port, so another local app can leave values here
// that aren't valid percent-encoding.
const STRAY = 'other_app=100%; theme=%E0%A4%A';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

test('parseCookies keeps malformed values as-is instead of throwing', () => {
  assert.deepEqual(parseCookies('a=1; other_app=100%; b=hello%20there'), { a: '1', other_app: '100%', b: 'hello there' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(), {});
});

test('the login page still loads next to a malformed cookie', async () => {
  const r = await app.client({ extraCookies: STRAY }).get('/login');
  assert.equal(r.status, 200);
});

test('a signed-in user stays signed in next to a malformed cookie', async () => {
  const c = app.client({ extraCookies: STRAY });
  assert.equal((await c.signup('Bea', 'bea@x.com')).status, 302);
  const r = await c.get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Total balance/);
});

test('one-time messages still show next to a malformed cookie', async () => {
  const c = app.client({ extraCookies: STRAY });
  await c.signup('Cal', 'cal@x.com');
  const created = await c.post('/groups', { name: 'Trip' });
  assert.equal(created.status, 302);
  // The test client only keeps the session cookie, so pass the flash cookie back by hand.
  const flash = app.client({ extraCookies: `${STRAY}; tally_flash=${encodeURIComponent('Created “Trip”.')}` });
  await flash.login('cal@x.com');
  const page = await flash.get(created.location);
  assert.match(page.text, /class="flash"[^>]*>Created “Trip”\./);
});
