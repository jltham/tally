// Issue #15: one source for field lengths (server trimming and HTML maxlength agree), and one
// id check shared by every route that takes an expense or payment id.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LENGTH } from '../lib/limits.js';
import { startApp, idFromLocation } from './helpers.js';

let app;
let owner;
let groupPath;
let ownerId;
before(async () => {
  app = await startApp();
  owner = app.client();
  await owner.signup('Nia', 'nia@x.com');
  await app.client().signup('Oz', 'oz@x.com');
  ownerId = app.userId('nia@x.com');
  groupPath = `/groups/${idFromLocation((await owner.post('/groups', { name: 'Flat', members: String(app.userId('oz@x.com')) })).location)}`;
});
after(() => app.close());

const maxlengthOf = (html, selector) => html.match(new RegExp(`<input[^>]*${selector}[^>]*>`))?.[0].match(/maxlength="(\d+)"/)?.[1];

test('every text field’s maxlength matches what the server keeps', async () => {
  const signup = (await app.client().get('/signup')).text;
  assert.equal(maxlengthOf(signup, 'name="name"'), String(MAX_LENGTH.userName));
  assert.equal(maxlengthOf(signup, 'name="email"'), String(MAX_LENGTH.email));
  assert.equal(maxlengthOf((await app.client().get('/login')).text, 'name="email"'), String(MAX_LENGTH.email));
  assert.equal(maxlengthOf((await owner.get('/groups/new')).text, 'name="name"'), String(MAX_LENGTH.groupName));
  assert.equal(maxlengthOf((await owner.get(`${groupPath}/edit`)).text, 'name="name"'), String(MAX_LENGTH.groupName));
  assert.equal(maxlengthOf((await owner.get('/account')).text, 'name="name"'), String(MAX_LENGTH.userName));
  const expense = (await owner.get(`${groupPath}/expenses/new`)).text;
  assert.equal(maxlengthOf(expense, 'name="description"'), String(MAX_LENGTH.description));
  assert.equal(maxlengthOf(expense, 'name="amount"'), String(MAX_LENGTH.amount));
  assert.equal(maxlengthOf(expense, `name="share_${ownerId}"`), String(MAX_LENGTH.amount));
  const payment = (await owner.get(`${groupPath}/settlements/new`)).text;
  assert.equal(maxlengthOf(payment, 'name="note"'), String(MAX_LENGTH.note));
  assert.equal(maxlengthOf(payment, 'name="amount"'), String(MAX_LENGTH.amount));
});

test('the server trims to the same limits', async () => {
  const long = 'x'.repeat(MAX_LENGTH.description + 25);
  const r = await owner.post(`${groupPath}/expenses`, {
    description: long, amount: '10', paid_by: String(ownerId), spent_on: '2026-11-01', split_type: 'equal', participants: String(ownerId),
  });
  assert.equal(r.status, 302);
  assert.equal(app.db.prepare('SELECT description FROM expenses').get().description.length, MAX_LENGTH.description);
});

for (const kind of ['expenses', 'settlements']) {
  for (const id of ['abc', '1.5', '-1', '99999', '1e400']) {
    test(`${kind}: id ${JSON.stringify(id)} is "Not found" for edit, update and delete`, async () => {
      assert.equal((await owner.get(`${groupPath}/${kind}/${encodeURIComponent(id)}/edit`)).status, 404);
      assert.equal((await owner.post(`${groupPath}/${kind}/${encodeURIComponent(id)}`, {})).status, 404);
      assert.equal((await owner.post(`${groupPath}/${kind}/${encodeURIComponent(id)}/delete`)).status, 404);
    });
  }
}
