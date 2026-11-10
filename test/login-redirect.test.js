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

for (const next of [
  '//evil.example', '/\\evil.example', '/\\/evil.example', '/\t/evil.example', 'https://evil.example', 'evil.example',
  // Dot segments: resolving these can leave a path that starts with "//".
  '/..//evil.example', '/.//evil.example', '/x/..//evil.example', '/%2e%2e//evil.example',
]) {
  test(`after login, ${JSON.stringify(next)} cannot send the user to another site`, async () => {
    const r = await app.client().login('ana@x.com', 'password123', next);
    assert.equal(r.status, 302);
    assert.equal(destination(r.location, app.base).origin, app.base, `went to ${r.location}`);
  });
}

for (const next of ['/\\evil.example', '/..//evil.example']) {
  test(`the login page passes only a safe next into its form: ${JSON.stringify(next)}`, async () => {
    const r = await app.client().get(`/login?next=${encodeURIComponent(next)}`);
    assert.match(r.text, /name="next" value="\/"/);
  });
}

test('harmless dot segments are still resolved on this site', async () => {
  const r = await app.client().login('ana@x.com', 'password123', '/groups/../groups/new');
  assert.equal(r.location, '/groups/new');
});

// Some inputs aren't valid URLs at all once resolved; they must fall back to the dashboard, not crash.
for (const next of ['//[', '/\\[', '//a b', '//////']) {
  test(`a next that isn't a valid URL falls back to the dashboard: ${JSON.stringify(next)}`, async () => {
    const page = await app.client().get(`/login?next=${encodeURIComponent(next)}`);
    assert.equal(page.status, 200);
    const r = await app.client().login('ana@x.com', 'password123', next);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/');
  });
}
