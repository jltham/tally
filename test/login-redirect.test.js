import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
  await app.client().signup('Ana', 'ana@x.com');
});
after(() => app.close());

/** Where a browser would actually go after this Location header. */
const destination = (location, base) => new URL(location, base);

test('after login, same-site paths (with query and hash) are kept', async () => {
  const r = await app.client().login('ana@x.com', 'password123', '/groups/new?x=1#top');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/groups/new?x=1#top');
});

test('after login, a missing next goes to the dashboard', async () => {
  const r = await app.client().login('ana@x.com');
  assert.equal(r.location, '/');
});

for (const next of ['//evil.example', '/\\evil.example', '/\\/evil.example', '/\t/evil.example', 'https://evil.example', 'evil.example']) {
  test(`after login, ${JSON.stringify(next)} cannot send the user to another site`, async () => {
    const r = await app.client().login('ana@x.com', 'password123', next);
    assert.equal(r.status, 302);
    assert.equal(destination(r.location, app.base).origin, app.base, `went to ${r.location}`);
  });
}

test('the login page passes only a safe next into its form', async () => {
  const r = await app.client().get(`/login?next=${encodeURIComponent('/\\evil.example')}`);
  assert.match(r.text, /name="next" value="\/"/);
});
