// Issue #10: commas are only thousands separators. A decimal comma ("5,50") used to be
// stripped and saved as S$550.00; it must be rejected instead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { toCents } from '../lib/ledger.js';
import { cleanText } from '../lib/forms.js';
import { startApp, idFromLocation } from './helpers.js';

test('toCents accepts commas only in thousands groups', () => {
  assert.equal(toCents('1,200'), 120000);
  assert.equal(toCents('1,200.50'), 120050);
  assert.equal(toCents('12,345'), 1234500);
  assert.equal(toCents('123,456.78'), 12345678);
  assert.equal(toCents('$1,200'), 120000);
  assert.equal(toCents('1200'), 120000);
});

test('toCents rejects decimal commas and misplaced commas', () => {
  for (const bad of ['5,50', '1,2', '12,34', '1,2345', ',5', '5,', '1,,200', '1,200,5', '0,99', '1,200,00']) {
    assert.equal(toCents(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('toCents rejects repeated form values instead of joining them', () => {
  assert.equal(toCents(['5', '6']), null);
  assert.equal(toCents(['1', '200']), null);
});

test('cleanText treats a repeated field as empty', () => {
  assert.equal(cleanText(['Rent', 'Bills'], 100), '');
  assert.equal(cleanText('  Rent ', 100), 'Rent');
});

let app;
let owner;
let groupPath;
let ownerId;
before(async () => {
  app = await startApp();
  owner = app.client();
  await owner.signup('Fay', 'fay@x.com');
  ownerId = app.userId('fay@x.com');
  groupPath = `/groups/${idFromLocation((await owner.post('/groups', { name: 'Flat' })).location)}`;
});
after(() => app.close());

const expenseCount = () => app.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n;

test('an expense of "5,50" is refused, not saved as S$550.00', async () => {
  const r = await owner.post(`${groupPath}/expenses`, {
    description: 'Coffee', amount: '5,50', paid_by: String(ownerId), spent_on: '2026-11-01',
    split_type: 'equal', participants: String(ownerId),
  });
  assert.equal(r.status, 400);
  assert.match(r.text, /greater than zero, like 12.50/);
  assert.equal(expenseCount(), 0);
});

test('a repeated amount field is refused', async () => {
  const r = await owner.post(`${groupPath}/expenses`, new URLSearchParams([
    ['description', 'Coffee'], ['amount', '5'], ['amount', '6'], ['paid_by', String(ownerId)],
    ['spent_on', '2026-11-01'], ['split_type', 'equal'], ['participants', String(ownerId)],
  ]));
  assert.equal(r.status, 400);
  assert.equal(expenseCount(), 0);
});

test('a repeated exact share is refused, not read as "5,6" = S$56', async () => {
  const r = await owner.post(`${groupPath}/expenses`, new URLSearchParams([
    ['description', 'Coffee'], ['amount', '56'], ['paid_by', String(ownerId)], ['spent_on', '2026-11-01'],
    ['split_type', 'exact'], [`share_${ownerId}`, '5'], [`share_${ownerId}`, '6'],
  ]));
  assert.equal(r.status, 400);
  assert.equal(expenseCount(), 0);
});

test('a thousands separator still works end to end', async () => {
  const r = await owner.post(`${groupPath}/expenses`, {
    description: 'Laptop', amount: '1,200.00', paid_by: String(ownerId), spent_on: '2026-11-01',
    split_type: 'equal', participants: String(ownerId),
  });
  assert.equal(r.status, 302);
  assert.equal(app.db.prepare("SELECT amount_cents FROM expenses WHERE description = 'Laptop'").get().amount_cents, 120000);
});
