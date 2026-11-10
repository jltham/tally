// Route-level tests for the paths the end-to-end flow in app.test.js doesn't reach:
// signed-in redirects, validation errors, edit pages, payments, and the account page.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, idFromLocation } from './helpers.js';

let app;
let ann; // owner of the group
let bob; // member
let cy;  // not a member
let ids;
let groupPath;

before(async () => {
  app = await startApp();
  ann = app.client();
  bob = app.client();
  cy = app.client();
  await ann.signup('Ann', 'ann@x.com');
  await bob.signup('Bob', 'bob@x.com');
  await cy.signup('Cy', 'cy@x.com');
  ids = { ann: app.userId('ann@x.com'), bob: app.userId('bob@x.com'), cy: app.userId('cy@x.com') };
  groupPath = `/groups/${idFromLocation((await ann.post('/groups', { name: 'Flat', members: String(ids.bob) })).location)}`;
});
after(() => app.close());

const expenseForm = (overrides = {}) => new URLSearchParams({
  description: 'Rent', amount: '100', paid_by: String(ids.ann), spent_on: '2026-11-01', split_type: 'equal',
  ...overrides,
});
const withParticipants = (form, people) => {
  for (const id of people) form.append('participants', String(id));
  return form;
};

describe('signed-in visitors to login and sign-up', () => {
  test('GET /login and GET /signup send a signed-in user to the dashboard', async () => {
    assert.equal((await ann.get('/login')).location, '/');
    assert.equal((await ann.get('/signup')).location, '/');
  });

  test('GET /signup shows the form to a signed-out visitor', async () => {
    const r = await app.client().get('/signup');
    assert.equal(r.status, 200);
    assert.match(r.text, /Create your account/);
  });
});

describe('POST /signup validation', () => {
  for (const [label, form, message] of [
    ['missing name', { name: ' ', email: 'n@x.com', password: 'password123' }, /enter your name/],
    ['bad email', { name: 'N', email: 'not-an-email', password: 'password123' }, /valid email/],
    ['short password', { name: 'N', email: 'n@x.com', password: 'short' }, /at least 8 characters/],
    ['email already used (any case)', { name: 'N', email: 'ANN@x.com', password: 'password123' }, /already an account/],
  ]) {
    test(label, async () => {
      const r = await app.client().post('/signup', form);
      assert.equal(r.status, 400);
      assert.match(r.text, message);
    });
  }
});

describe('groups', () => {
  test('GET /groups/new lists everyone who can be added', async () => {
    const r = await ann.get('/groups/new');
    assert.equal(r.status, 200);
    assert.match(r.text, /Bob/);
    assert.match(r.text, /Cy/);
  });

  test('POST /groups without a name is refused and keeps the chosen members', async () => {
    const r = await ann.post('/groups', { name: '  ', members: String(ids.bob) });
    assert.equal(r.status, 400);
    assert.match(r.text, /Give the group a name/);
    assert.match(r.text, new RegExp(`value="${ids.bob}" checked`));
  });

  test('POST /groups ignores member ids that are not real users', async () => {
    const r = await ann.post('/groups', new URLSearchParams([['name', 'Solo'], ['members', '9999'], ['members', 'abc']]));
    const gid = idFromLocation(r.location);
    assert.deepEqual(app.db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid).map((m) => m.user_id), [ids.ann]);
  });

  test('a non-numeric or unknown group id is "Not found"', async () => {
    assert.equal((await ann.get('/groups/abc')).status, 404);
    assert.equal((await ann.get('/groups/99999')).status, 404);
  });

  test('renaming to an empty name is refused', async () => {
    const r = await ann.post(`${groupPath}/rename`, { name: '' });
    assert.equal(r.status, 400);
    assert.match(r.text, /needs a name/);
  });

  test('adding nobody says so', async () => {
    const r = await ann.post(`${groupPath}/members`, {});
    assert.equal(r.status, 302);
  });

  test('removing someone who is not a member is "Not found"', async () => {
    assert.equal((await ann.post(`${groupPath}/members/${ids.cy}/remove`)).status, 404);
  });

  test('settings show who can still be added', async () => {
    const r = await ann.get(`${groupPath}/edit`);
    assert.equal(r.status, 200);
    assert.match(r.text, /Add people[\s\S]*Cy/);
  });

  test('a non-member cannot open settings or post to the group', async () => {
    assert.equal((await cy.get(`${groupPath}/edit`)).status, 404);
    assert.equal((await cy.post(`${groupPath}/expenses`, expenseForm())).status, 404);
  });
});

describe('POST /groups/:gid/expenses validation', () => {
  for (const [label, overrides, message] of [
    ['missing description', { description: '' }, /short description/],
    ['zero amount', { amount: '0' }, /greater than zero/],
    ['unparseable amount', { amount: '12.345' }, /greater than zero/],
    ['payer outside the group', { paid_by: '' }, /Choose who paid/],
    ['impossible date', { spent_on: '2026-02-30' }, /valid date/],
  ]) {
    test(label, async () => {
      const r = await ann.post(`${groupPath}/expenses`, withParticipants(expenseForm(overrides), [ids.ann]));
      assert.equal(r.status, 400);
      assert.match(r.text, message);
    });
  }

  test('an equal split with nobody ticked', async () => {
    const r = await ann.post(`${groupPath}/expenses`, expenseForm());
    assert.equal(r.status, 400);
    assert.match(r.text, /at least one person/);
  });

  test('an exact split with an invalid number', async () => {
    const r = await ann.post(`${groupPath}/expenses`, expenseForm({ split_type: 'exact', [`share_${ids.ann}`]: 'ten' }));
    assert.equal(r.status, 400);
    assert.match(r.text, /isn’t a valid number/);
  });

  test('an exact split with every share left at zero', async () => {
    const r = await ann.post(`${groupPath}/expenses`, expenseForm({ split_type: 'exact', [`share_${ids.ann}`]: '0' }));
    assert.equal(r.status, 400);
    assert.match(r.text, /how much each person owes/);
  });

  test('a rejected form keeps what was typed', async () => {
    const r = await ann.post(`${groupPath}/expenses`, expenseForm({ description: 'Cake', amount: 'abc' }));
    assert.match(r.text, /value="Cake"/);
    assert.match(r.text, /value="abc"/);
  });
});

describe('editing expenses', () => {
  let expensePath;
  before(async () => {
    await ann.post(`${groupPath}/expenses`, withParticipants(expenseForm({ description: 'Bills' }), [ids.ann, ids.bob]));
    const id = app.db.prepare("SELECT id FROM expenses WHERE description = 'Bills'").get().id;
    expensePath = `${groupPath}/expenses/${id}`;
  });

  test('GET edit shows the saved values', async () => {
    const r = await bob.get(`${expensePath}/edit`);
    assert.equal(r.status, 200);
    assert.match(r.text, /Edit expense/);
    assert.match(r.text, /value="100.00"/);
  });

  test('a bad edit is refused and nothing changes', async () => {
    const r = await bob.post(expensePath, expenseForm({ amount: '-1' }));
    assert.equal(r.status, 400);
    assert.equal(app.db.prepare('SELECT amount_cents FROM expenses WHERE description = ?').get('Bills').amount_cents, 10000);
  });

  test('an expense id that is not a number, or from another group, is "Not found"', async () => {
    assert.equal((await ann.get(`${groupPath}/expenses/abc/edit`)).status, 404);
    const other = await ann.post('/groups', { name: 'Other' });
    assert.equal((await ann.get(`${other.location}/${expensePath.split('/').slice(3).join('/')}/edit`)).status, 404);
  });
});

describe('payments', () => {
  let paymentPath;
  before(async () => {
    const r = await bob.post(`${groupPath}/settlements`, { from_user: String(ids.bob), to_user: String(ids.ann), amount: '10', paid_on: '2026-11-02', note: 'cash' });
    assert.equal(r.status, 302);
    paymentPath = `${groupPath}/settlements/${app.db.prepare("SELECT id FROM settlements WHERE note = 'cash'").get().id}`;
  });

  test('settling up needs someone else in the group', async () => {
    const solo = await ann.post('/groups', { name: 'Alone' });
    const r = await ann.get(`${solo.location}/settlements/new`);
    assert.equal(r.status, 302);
    assert.equal(r.location, solo.location);
  });

  test('a suggestion with bad people or amount opens a blank form', async () => {
    const r = await ann.get(`${groupPath}/settlements/new?from=${ids.ann}&to=${ids.ann}&amount=zzz`);
    assert.equal(r.status, 200);
    assert.match(r.text, /name="amount" value=""/);
  });

  // Forms are built inside each test: user ids only exist once `before` has run.
  for (const [label, makeForm, message] of [
    ['someone outside the group', () => ({ from_user: String(ids.cy), to_user: String(ids.ann), amount: '5', paid_on: '2026-11-02' }), /Choose who paid/],
    ['paying yourself', () => ({ from_user: String(ids.ann), to_user: String(ids.ann), amount: '5', paid_on: '2026-11-02' }), /can’t pay themselves/],
    ['no amount', () => ({ from_user: String(ids.bob), to_user: String(ids.ann), amount: '', paid_on: '2026-11-02' }), /greater than zero/],
    ['bad date', () => ({ from_user: String(ids.bob), to_user: String(ids.ann), amount: '5', paid_on: 'yesterday' }), /valid date/],
  ]) {
    test(`recording a payment: ${label}`, async () => {
      const r = await ann.post(`${groupPath}/settlements`, makeForm());
      assert.equal(r.status, 400);
      assert.match(r.text, message);
    });
  }

  test('GET edit shows the saved payment', async () => {
    const r = await ann.get(`${paymentPath}/edit`);
    assert.equal(r.status, 200);
    assert.match(r.text, /Edit payment/);
    assert.match(r.text, /value="10.00"/);
  });

  test('editing a payment saves it', async () => {
    const r = await ann.post(paymentPath, { from_user: String(ids.bob), to_user: String(ids.ann), amount: '12', paid_on: '2026-11-03', note: 'cash' });
    assert.equal(r.status, 302);
    assert.equal(app.db.prepare("SELECT amount_cents FROM settlements WHERE note = 'cash'").get().amount_cents, 1200);
  });

  test('a bad payment edit is refused', async () => {
    const r = await ann.post(paymentPath, { from_user: String(ids.bob), to_user: String(ids.bob), amount: '12', paid_on: '2026-11-03' });
    assert.equal(r.status, 400);
  });

  test('a payment id that is not a number is "Not found"', async () => {
    assert.equal((await ann.get(`${groupPath}/settlements/abc/edit`)).status, 404);
  });

  test('deleting a payment removes it', async () => {
    const r = await ann.post(`${paymentPath}/delete`);
    assert.equal(r.status, 302);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE note = 'cash'").get().n, 0);
  });
});

describe('payment edits that would leave a former member owing', () => {
  test('are refused, for both edit and delete', async () => {
    const dee = app.client();
    const eve = app.client();
    await dee.signup('Dee', 'dee@x.com');
    await eve.signup('Eve', 'eve@x.com');
    const [d, e] = [app.userId('dee@x.com'), app.userId('eve@x.com')];
    const gp = (await dee.post('/groups', { name: 'Pair', members: String(e) })).location;
    await dee.post(`${gp}/expenses`, withParticipants(expenseForm({ paid_by: String(d) }), [d, e]));
    await eve.post(`${gp}/settlements`, { from_user: String(e), to_user: String(d), amount: '50', paid_on: '2026-11-02' });
    assert.equal((await dee.post(`${gp}/members/${e}/remove`)).status, 302);

    const payment = `${gp}/settlements/${app.db.prepare('SELECT id FROM settlements WHERE from_user = ?').get(e).id}`;
    const edit = await dee.post(payment, { from_user: String(e), to_user: String(d), amount: '40', paid_on: '2026-11-02' });
    assert.equal(edit.status, 400);
    assert.match(edit.text, /Eve.*no longer in this group/);
    assert.equal((await dee.post(`${payment}/delete`)).status, 400);
  });
});

describe('account page', () => {
  test('GET /account shows the profile', async () => {
    const r = await bob.get('/account');
    assert.equal(r.status, 200);
    assert.match(r.text, /bob@x.com/);
  });

  test('an empty name is refused', async () => {
    assert.equal((await bob.post('/account/name', { name: ' ' })).status, 400);
  });

  test('a new password that is too short is refused', async () => {
    const r = await bob.post('/account/password', { current: 'password123', password: 'short' });
    assert.equal(r.status, 400);
    assert.match(r.text, /at least 8 characters/);
  });

  test('deleting an account needs the right password, and no groups', async () => {
    assert.equal((await bob.post('/account/delete', { password: 'wrong' })).status, 400);
    const r = await bob.post('/account/delete', { password: 'password123' });
    assert.equal(r.status, 400);
    assert.match(r.text, /Leave all your groups first/);
  });
});

test('unknown pages are "Not found" for signed-in users', async () => {
  assert.equal((await ann.get('/nope')).status, 404);
});
