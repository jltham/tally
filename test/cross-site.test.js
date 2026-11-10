// Issue #8: SameSite=Lax ignores the port, so a page on any other localhost port can submit forms
// to Tally with the user's cookie. Refuse cross-site writes, and stop Tally being framed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
  await app.client().signup('Mo', 'mo@x.com');
});
after(() => app.close());

const groupCount = () => app.db.prepare('SELECT COUNT(*) AS n FROM groups').get().n;

/** A valid session cookie for `email`, as the victim's browser would hold it. */
async function sessionCookieFor(email) {
  const res = await fetch(`${app.base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password: 'password123' }).toString(),
  });
  return res.headers.getSetCookie().find((c) => c.startsWith('tally_sid=')).split(';')[0];
}

/** POST a form with the victim's cookie and an attacker page's headers. */
const forgedPost = async (path, form, headers) =>
  fetch(app.base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...headers, cookie: await sessionCookieFor('mo@x.com'), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

// Browsers send Origin on cross-site POSTs, and Sec-Fetch-Site in current versions.
for (const [label, headers] of [
  ['another localhost port', { origin: 'http://localhost:5173' }],
  ['another host', { origin: 'http://evil.example' }],
  ['an opaque origin (sandboxed frame, file://)', { origin: 'null' }],
  ['a same-site page (Sec-Fetch-Site only)', { 'sec-fetch-site': 'same-site' }],
  ['a cross-site page (Sec-Fetch-Site only)', { 'sec-fetch-site': 'cross-site' }],
]) {
  test(`forms posted from ${label} are refused`, async () => {
    const before = groupCount();
    const create = await forgedPost('/groups', { name: 'Fake' }, headers);
    assert.equal(create.status, 403);
    assert.match(await create.text(), /another site/);
    assert.equal(groupCount(), before, 'nothing was created');
    assert.equal((await app.client({ headers }).login('mo@x.com')).status, 403, 'login is a write too');
  });
}

test('forms posted from Tally itself still work', async () => {
  const c = app.client({ headers: { origin: app.base, 'sec-fetch-site': 'same-origin' } });
  assert.equal((await c.login('mo@x.com')).status, 302);
  const before = groupCount();
  assert.equal((await c.post('/groups', { name: 'Ours' })).status, 302);
  assert.equal(groupCount(), before + 1);
});

test('requests that send neither header (curl, scripts) still work', async () => {
  assert.equal((await app.client().login('mo@x.com')).status, 302);
});

test('responses forbid framing and sniffing, and allow only our own scripts and styles', async () => {
  for (const path of ['/login', '/app.js', '/ledger.js', '/nope']) {
    const res = await fetch(app.base + path, { redirect: 'manual' });
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /form-action 'self'/, path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', path);
  }
});
