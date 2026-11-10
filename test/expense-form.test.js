// Issue #13: after a validation error the expense form must come back exactly as the user left
// it, say which amount was wrong, and never silently ignore exact amounts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, idFromLocation } from './helpers.js';

let app;
let alice;
let ids;
let groupPath;
before(async () => {
  app = await startApp();
  alice = app.client();
  await alice.signup('Alice', 'alice@x.com');
  await app.client().signup('Ben', 'ben@x.com');
  await app.client().signup('Cat', 'cat@x.com');
  ids = { alice: app.userId('alice@x.com'), ben: app.userId('ben@x.com'), cat: app.userId('cat@x.com') };
  groupPath = `/groups/${idFromLocation((await alice.post('/groups', new URLSearchParams([
    ['name', 'Flat'], ['members', String(ids.ben)], ['members', String(ids.cat)],
  ]))).location)}`;
});
after(() => app.close());

const form = (entries) => new URLSearchParams([
  ['description', 'Dinner'], ['amount', '30'], ['paid_by', String(ids.alice)], ['spent_on', '2026-11-01'], ...entries,
]);
const expenseCount = () => app.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n;
const shareInput = (html, id) => html.match(new RegExp(`<input class="share" name="share_${id}"[^>]*>`))?.[0] ?? '';
const isTicked = (html, id) => new RegExp(`name="participants" value="${id}" checked`).test(html);

test('an invalid exact amount is kept, and the error says whose it is', async () => {
  const r = await alice.post(`${groupPath}/expenses`, form([
    ['split_type', 'exact'], [`share_${ids.alice}`, '10'], [`share_${ids.ben}`, '12.345'], [`share_${ids.cat}`, '7.5'],
  ]));
  assert.equal(r.status, 400);
  assert.match(r.text, /Ben’s amount isn’t a valid number/);
  assert.match(shareInput(r.text, ids.ben), /value="12.345"/);
  assert.match(shareInput(r.text, ids.ben), /aria-invalid="true"/);
  assert.match(shareInput(r.text, ids.alice), /value="10"/);
  assert.match(shareInput(r.text, ids.cat), /value="7.5"/, 'typed text is kept as typed');
  assert.doesNotMatch(shareInput(r.text, ids.alice), /aria-invalid/);
});

test('amounts that don’t add up come back exactly as typed', async () => {
  const r = await alice.post(`${groupPath}/expenses`, form([
    ['split_type', 'exact'], [`share_${ids.alice}`, '10'], [`share_${ids.ben}`, '5.5'],
  ]));
  assert.equal(r.status, 400);
  assert.match(r.text, /add up to S\$15.50/);
  assert.match(shareInput(r.text, ids.ben), /value="5.5"/);
});

test('unticking everyone comes back with nobody ticked', async () => {
  const r = await alice.post(`${groupPath}/expenses`, form([['split_type', 'equal']]));
  assert.equal(r.status, 400);
  assert.match(r.text, /at least one person/);
  for (const id of Object.values(ids)) assert.ok(!isTicked(r.text, id), `user ${id} should not be ticked`);
});

test('a brand-new form still starts with everyone ticked', async () => {
  const r = await alice.get(`${groupPath}/expenses/new`);
  for (const id of Object.values(ids)) assert.ok(isTicked(r.text, id));
});

test('“Equally” with exact amounts filled in is refused, not silently split equally', async () => {
  const r = await alice.post(`${groupPath}/expenses`, form([
    ['split_type', 'equal'], ['participants', String(ids.alice)], ['participants', String(ids.ben)], ['participants', String(ids.cat)],
    [`share_${ids.alice}`, '30'], [`share_${ids.ben}`, '0'], [`share_${ids.cat}`, ''],
  ]));
  assert.equal(r.status, 400);
  assert.match(r.text, /exact amounts/);
  assert.equal(expenseCount(), 0);
  assert.match(shareInput(r.text, ids.alice), /value="30"/, 'the typed amounts are still there');
});

test('“Equally” with the exact-amount fields left empty saves as before', async () => {
  const r = await alice.post(`${groupPath}/expenses`, form([
    ['split_type', 'equal'], ['participants', String(ids.alice)], ['participants', String(ids.ben)],
    [`share_${ids.alice}`, ''], [`share_${ids.ben}`, ''],
  ]));
  assert.equal(r.status, 302);
  assert.equal(expenseCount(), 1);
});

test('editing a saved equal split ticks only the people on it', async () => {
  const id = app.db.prepare('SELECT id FROM expenses').get().id;
  const r = await alice.get(`${groupPath}/expenses/${id}/edit`);
  assert.ok(isTicked(r.text, ids.alice));
  assert.ok(isTicked(r.text, ids.ben));
  assert.ok(!isTicked(r.text, ids.cat));
});
