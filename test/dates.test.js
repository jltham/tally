// The app runs on the user's own laptop, so "today" must be the laptop's local date, not UTC.
process.env.TZ = 'Asia/Singapore'; // UTC+8, no daylight saving

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, idFromLocation } from './helpers.js';
import { todayIso } from '../lib/dates.js';

// 4:30 am on 11 Nov in Singapore is still 10 Nov in UTC.
const EARLY_MORNING_SG = new Date('2026-11-10T20:30:00Z');

let app;
let alice;
let groupId;
before(async () => {
  app = await startApp();
  alice = app.client();
  await alice.signup('Alice', 'alice@x.com');
  await app.client().signup('Ben', 'ben@x.com');
  groupId = idFromLocation((await alice.post('/groups', { name: 'Flat', members: String(app.userId('ben@x.com')) })).location);
});
after(() => app.close());

test('todayIso is the local calendar date', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: EARLY_MORNING_SG });
  assert.equal(todayIso(), '2026-11-11');
});

test('todayIso pads single-digit months and days', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-04T02:00:00Z') });
  assert.equal(todayIso(), '2026-03-04');
});

test('a new expense defaults to the local date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: EARLY_MORNING_SG });
  const r = await alice.get(`/groups/${groupId}/expenses/new`);
  assert.equal(r.status, 200);
  assert.match(r.text, /name="spent_on" value="2026-11-11"/);
});

test('a suggested payment opens with the local date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: EARLY_MORNING_SG });
  const [from, to] = [app.userId('ben@x.com'), app.userId('alice@x.com')];
  const r = await alice.get(`/groups/${groupId}/settlements/new?from=${from}&to=${to}&amount=12.50`);
  assert.equal(r.status, 200);
  assert.match(r.text, /name="paid_on" value="2026-11-11"/);
  assert.match(r.text, /name="amount" value="12.50"/);
});

test('a new payment without a suggestion also defaults to the local date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: EARLY_MORNING_SG });
  const r = await alice.get(`/groups/${groupId}/settlements/new`);
  assert.match(r.text, /name="paid_on" value="2026-11-11"/);
});
