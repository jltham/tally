import express from 'express';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { openDb, MAX_USERS } from './lib/db.js';
import { createStore } from './lib/store.js';
import { hashPassword, verifyPassword, startSession, endSession, loadUser, requireLogin } from './lib/auth.js';
import { toCents, splitEqual, simplifyDebts, effectOn } from './lib/ledger.js';
import * as V from './lib/views.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLASH = 'tally_flash';

// ---------- input helpers ----------
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const ids = (v) => list(v).map(Number).filter(Number.isSafeInteger);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');
const plain = (c) => (c / 100).toFixed(2);

export function createApp(db) {
  const store = createStore(db);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(join(HERE, 'public')));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(loadUser(db));

  // Flash messages survive exactly one redirect, via a short-lived cookie.
  app.use((req, res, next) => {
    const m = /(?:^|;\s*)tally_flash=([^;]*)/.exec(req.headers.cookie ?? '');
    if (m) {
      req.flash = decodeURIComponent(m[1]);
      res.append('Set-Cookie', `${FLASH}=; Path=/; Max-Age=0; SameSite=Lax`);
    }
    res.flashRedirect = (url, msg) => {
      res.append('Set-Cookie', `${FLASH}=${encodeURIComponent(msg)}; Path=/; Max-Age=60; SameSite=Lax; HttpOnly`);
      res.redirect(url);
    };
    res.page = (title, body, status = 200) =>
      res.status(status).type('html').send(V.layout({ title, user: req.user, body, flash: req.flash }));
    next();
  });

  // ---------- auth ----------
  const spotsLeft = () => MAX_USERS - store.users.count();

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.page('Log in', V.loginPage({ next: safeNext(req.query.next), spotsLeft: spotsLeft() }));
  });

  app.post('/login', (req, res) => {
    const email = str(req.body.email, 200).toLowerCase();
    const next = safeNext(req.body.next);
    const user = store.users.byEmail(email);
    if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
      return res.page('Log in', V.loginPage({ error: 'That email and password don’t match.', email, next, spotsLeft: spotsLeft() }), 401);
    }
    startSession(db, res, user.id);
    res.redirect(next);
  });

  app.get('/signup', (req, res) => {
    if (req.user) return res.redirect('/');
    res.page('Sign up', V.signupPage({ spotsLeft: spotsLeft() }));
  });

  app.post('/signup', (req, res) => {
    const values = { name: str(req.body.name, 40), email: str(req.body.email, 200).toLowerCase() };
    const password = String(req.body.password ?? '');
    const fail = (error, status = 400) => res.page('Sign up', V.signupPage({ error, values, spotsLeft: spotsLeft() }), status);
    if (spotsLeft() <= 0) return fail('All 10 accounts are taken.', 403);
    if (!values.name) return fail('Please enter your name.');
    if (!isEmail(values.email)) return fail('Please enter a valid email address.');
    if (password.length < 8) return fail('Your password needs at least 8 characters.');
    if (store.users.byEmail(values.email)) return fail('There’s already an account with that email.');
    const id = store.users.create(values.name, values.email, hashPassword(password));
    startSession(db, res, id);
    res.flashRedirect('/', `Welcome to Tally, ${values.name}!`);
  });

  app.post('/logout', (req, res) => {
    endSession(db, req, res);
    res.redirect('/login');
  });

  app.use(requireLogin);

  // ---------- dashboard ----------
  app.get('/', (req, res) => {
    const me = req.user.id;
    const people = new Map(); // userId -> cents (+ they owe me)
    const groups = store.groups.forUser(me).map((g) => {
      const balances = store.groupBalances(g.id);
      for (const p of simplifyDebts(balances)) {
        if (p.toUser === me) people.set(p.fromUser, (people.get(p.fromUser) ?? 0) + p.amountCents);
        if (p.fromUser === me) people.set(p.toUser, (people.get(p.toUser) ?? 0) - p.amountCents);
      }
      return { ...g, cents: balances.get(me) ?? 0 };
    });
    const peopleList = [...people]
      .filter(([, c]) => c !== 0)
      .map(([id, cents]) => ({ ...store.users.get(id), cents }))
      .sort((a, b) => b.cents - a.cents);
    const owedToMe = peopleList.filter((p) => p.cents > 0).reduce((a, p) => a + p.cents, 0);
    const iOwe = -peopleList.filter((p) => p.cents < 0).reduce((a, p) => a + p.cents, 0);
    res.page('Dashboard', V.dashboardPage({ net: owedToMe - iOwe, owedToMe, iOwe, people: peopleList, groups }));
  });

  // ---------- groups ----------
  app.get('/groups/new', (req, res) => {
    res.page('New group', V.groupNewPage({ me: req.user, allUsers: store.users.all() }));
  });

  app.post('/groups', (req, res) => {
    const name = str(req.body.name, 60);
    const validIds = new Set(store.users.all().map((u) => u.id));
    const members = ids(req.body.members).filter((id) => validIds.has(id));
    if (!name) {
      return res.page('New group', V.groupNewPage({ me: req.user, allUsers: store.users.all(), error: 'Give the group a name.', values: { name, members } }), 400);
    }
    const id = store.groups.create(name, req.user.id, members);
    res.flashRedirect(`/groups/${id}`, `Created “${name}”.`);
  });

  // Every /groups/:gid route below requires the user to be a member of that group.
  const notFound = (res) => res.page('Not found', V.notFoundPage(), 404);
  app.use('/groups/:gid', (req, res, next) => {
    const gid = Number(req.params.gid);
    req.group = Number.isSafeInteger(gid) ? store.groups.getForMember(gid, req.user.id) : undefined;
    if (!req.group) return notFound(res);
    req.members = store.groups.members(gid);
    next();
  });

  const nameOfFn = () => {
    const cache = new Map();
    return (id) => {
      if (!cache.has(id)) cache.set(id, store.users.get(id)?.name ?? 'Deleted user');
      return cache.get(id);
    };
  };

  app.get('/groups/:gid', (req, res) => {
    const g = req.group;
    const me = req.user.id;
    const timeline = [
      ...store.expenses.forGroup(g.id).map((e) => ({ ...e, kind: 'expense', date: e.spentOn, effect: effectOn(me, e) })),
      ...store.settlements.forGroup(g.id).map((s) => ({ ...s, kind: 'settlement', date: s.paidOn })),
    ].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const balances = store.groupBalances(g.id);
    res.page(g.name, V.groupPage({
      group: g, me: req.user, members: req.members, timeline, balances,
      suggestions: simplifyDebts(balances), nameOf: nameOfFn(),
    }));
  });

  const settingsPage = (req, res, error, status = 200) => {
    const memberIds = new Set(req.members.map((m) => m.id));
    res.page('Group settings', V.groupSettingsPage({
      group: req.group, me: req.user, members: req.members,
      others: store.users.all().filter((u) => !memberIds.has(u.id)),
      balances: store.groupBalances(req.group.id), error,
    }), status);
  };

  app.get('/groups/:gid/edit', (req, res) => settingsPage(req, res));

  app.post('/groups/:gid/rename', (req, res) => {
    const name = str(req.body.name, 60);
    if (!name) return settingsPage(req, res, 'The group needs a name.', 400);
    store.groups.rename(req.group.id, name);
    res.flashRedirect(`/groups/${req.group.id}/edit`, 'Group renamed.');
  });

  app.post('/groups/:gid/members', (req, res) => {
    const validIds = new Set(store.users.all().map((u) => u.id));
    const add = ids(req.body.members).filter((id) => validIds.has(id));
    store.groups.addMembers(req.group.id, add);
    res.flashRedirect(`/groups/${req.group.id}/edit`, add.length ? `Added ${add.length} member${add.length === 1 ? '' : 's'}.` : 'Nobody selected.');
  });

  app.post('/groups/:gid/members/:uid/remove', (req, res) => {
    const uid = Number(req.params.uid);
    const g = req.group;
    if (!req.members.some((m) => m.id === uid)) return notFound(res);
    if ((store.groupBalances(g.id).get(uid) ?? 0) !== 0) {
      return settingsPage(req, res, 'Only people who are settled up can be removed. Record the payments first.', 400);
    }
    store.groups.removeMember(g.id, uid);
    if (uid === req.user.id) return res.flashRedirect('/', `You left “${g.name}”.`);
    res.flashRedirect(`/groups/${g.id}/edit`, 'Member removed.');
  });

  app.post('/groups/:gid/delete', (req, res) => {
    store.groups.delete(req.group.id);
    res.flashRedirect('/', `Deleted “${req.group.name}”.`);
  });

  // ---------- expenses ----------
  /** People who can appear on an expense: current members plus anyone already on it. */
  const peopleFor = (req, expense) => {
    const map = new Map(req.members.map((m) => [m.id, m]));
    if (expense) {
      for (const id of [expense.paidBy, ...expense.shares.map((s) => s.userId)]) {
        if (!map.has(id)) map.set(id, store.users.get(id));
      }
    }
    return [...map.values()].filter(Boolean);
  };

  function parseExpense(body, people) {
    const allowed = new Set(people.map((p) => p.id));
    const draft = {
      description: str(body.description, 100),
      amount: str(body.amount, 20),
      paidBy: Number(body.paid_by),
      spentOn: str(body.spent_on, 10),
      splitType: body.split_type === 'exact' ? 'exact' : 'equal',
      shares: [],
    };
    const amountCents = toCents(draft.amount);
    const participants = ids(body.participants).filter((id) => allowed.has(id));
    const exact = people
      .map((p) => ({ userId: p.id, raw: str(body[`share_${p.id}`], 20) }))
      .filter((s) => s.raw !== '')
      .map((s) => ({ userId: s.userId, cents: toCents(s.raw) }));
    // Keep what the user chose so the form re-renders the same way after an error.
    draft.shares = draft.splitType === 'equal'
      ? participants.map((userId) => ({ userId, cents: 0 }))
      : exact.filter((s) => s.cents !== null);
    const fail = (error) => ({ error, draft });

    if (!draft.description) return fail('Add a short description.');
    if (!amountCents) return fail('Enter an amount greater than zero, like 12.50.');
    if (!allowed.has(draft.paidBy)) return fail('Choose who paid.');
    if (!isDate(draft.spentOn)) return fail('Choose a valid date.');
    let shares;
    if (draft.splitType === 'equal') {
      if (!participants.length) return fail('Pick at least one person to split with.');
      shares = splitEqual(amountCents, participants);
    } else {
      if (exact.some((s) => s.cents === null)) return fail('One of the amounts isn’t a valid number.');
      shares = exact.filter((s) => s.cents > 0);
      const sum = shares.reduce((a, s) => a + s.cents, 0);
      if (!shares.length) return fail('Enter how much each person owes.');
      if (sum !== amountCents) {
        return fail(`The amounts add up to S$${plain(sum)}, but the total is S$${plain(amountCents)}.`);
      }
    }
    return { value: { ...draft, amountCents, shares } };
  }

  const loadExpense = (req, res, next) => {
    const e = store.expenses.get(Number(req.params.eid));
    if (!e || e.groupId !== req.group.id) return notFound(res);
    req.expense = e;
    next();
  };

  app.get('/groups/:gid/expenses/new', (req, res) => {
    res.page('Add expense', V.expenseFormPage({ group: req.group, me: req.user, people: req.members }));
  });

  app.post('/groups/:gid/expenses', (req, res) => {
    const people = req.members;
    const { value, error, draft } = parseExpense(req.body, people);
    if (error) return res.page('Add expense', V.expenseFormPage({ group: req.group, me: req.user, people, expense: draft, error }), 400);
    store.expenses.save({ ...value, groupId: req.group.id }, req.user.id);
    res.flashRedirect(`/groups/${req.group.id}`, `Added “${value.description}”.`);
  });

  app.get('/groups/:gid/expenses/:eid/edit', loadExpense, (req, res) => {
    const e = req.expense;
    res.page('Edit expense', V.expenseFormPage({
      group: req.group, me: req.user, people: peopleFor(req, e), expense: { ...e, amount: plain(e.amountCents) },
    }));
  });

  app.post('/groups/:gid/expenses/:eid', loadExpense, (req, res) => {
    const people = peopleFor(req, req.expense);
    const { value, error, draft } = parseExpense(req.body, people);
    if (error) {
      return res.page('Edit expense', V.expenseFormPage({ group: req.group, me: req.user, people, expense: { ...draft, id: req.expense.id }, error }), 400);
    }
    store.expenses.save({ ...value, id: req.expense.id }, req.user.id);
    res.flashRedirect(`/groups/${req.group.id}`, 'Expense updated.');
  });

  app.post('/groups/:gid/expenses/:eid/delete', loadExpense, (req, res) => {
    store.expenses.delete(req.expense.id);
    res.flashRedirect(`/groups/${req.group.id}`, `Deleted “${req.expense.description}”.`);
  });

  // ---------- settlements ----------
  function parseSettlement(body, people) {
    const allowed = new Set(people.map((p) => p.id));
    const draft = {
      fromUser: Number(body.from_user),
      toUser: Number(body.to_user),
      amount: str(body.amount, 20),
      paidOn: str(body.paid_on, 10),
      note: str(body.note, 100),
    };
    const amountCents = toCents(draft.amount);
    const fail = (error) => ({ error, draft });
    if (!allowed.has(draft.fromUser) || !allowed.has(draft.toUser)) return fail('Choose who paid and who received it.');
    if (draft.fromUser === draft.toUser) return fail('Someone can’t pay themselves.');
    if (!amountCents) return fail('Enter an amount greater than zero.');
    if (!isDate(draft.paidOn)) return fail('Choose a valid date.');
    return { value: { ...draft, amountCents } };
  }

  const loadSettlement = (req, res, next) => {
    const s = store.settlements.get(Number(req.params.sid));
    if (!s || s.groupId !== req.group.id) return notFound(res);
    req.settlement = s;
    next();
  };

  const settlementPeople = (req, s) => {
    const map = new Map(req.members.map((m) => [m.id, m]));
    if (s) for (const id of [s.fromUser, s.toUser]) if (!map.has(id)) map.set(id, store.users.get(id));
    return [...map.values()].filter(Boolean);
  };

  app.get('/groups/:gid/settlements/new', (req, res) => {
    if (req.members.length < 2) return res.flashRedirect(`/groups/${req.group.id}`, 'Add someone else to the group first.');
    const memberIds = new Set(req.members.map((m) => m.id));
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    const prefill = memberIds.has(from) && memberIds.has(to) && from !== to
      ? { fromUser: from, toUser: to, amount: toCents(req.query.amount) ? str(req.query.amount, 20) : '', paidOn: new Date().toISOString().slice(0, 10), note: '' }
      : undefined;
    res.page('Settle up', V.settlementFormPage({ group: req.group, me: req.user, people: req.members, settlement: prefill }));
  });

  app.post('/groups/:gid/settlements', (req, res) => {
    const { value, error, draft } = parseSettlement(req.body, req.members);
    if (error) return res.page('Settle up', V.settlementFormPage({ group: req.group, me: req.user, people: req.members, settlement: draft, error }), 400);
    store.settlements.save({ ...value, groupId: req.group.id }, req.user.id);
    res.flashRedirect(`/groups/${req.group.id}`, 'Payment recorded.');
  });

  app.get('/groups/:gid/settlements/:sid/edit', loadSettlement, (req, res) => {
    const s = req.settlement;
    res.page('Edit payment', V.settlementFormPage({
      group: req.group, me: req.user, people: settlementPeople(req, s), settlement: { ...s, amount: plain(s.amountCents) },
    }));
  });

  app.post('/groups/:gid/settlements/:sid', loadSettlement, (req, res) => {
    const people = settlementPeople(req, req.settlement);
    const { value, error, draft } = parseSettlement(req.body, people);
    if (error) {
      return res.page('Edit payment', V.settlementFormPage({ group: req.group, me: req.user, people, settlement: { ...draft, id: req.settlement.id }, error }), 400);
    }
    store.settlements.save({ ...value, id: req.settlement.id }, req.user.id);
    res.flashRedirect(`/groups/${req.group.id}`, 'Payment updated.');
  });

  app.post('/groups/:gid/settlements/:sid/delete', loadSettlement, (req, res) => {
    store.settlements.delete(req.settlement.id);
    res.flashRedirect(`/groups/${req.group.id}`, 'Payment deleted.');
  });

  // ---------- account ----------
  const account = (req, res, opts = {}, status = 200) =>
    res.page('Account', V.accountPage({ user: req.user, groupCount: store.users.groupCount(req.user.id), notice: req.flash, ...opts }), status);

  app.get('/account', (req, res) => {
    const flash = req.flash;
    req.flash = undefined; // shown inside the page instead of the banner
    account(req, res, { notice: flash });
  });

  app.post('/account/name', (req, res) => {
    const name = str(req.body.name, 40);
    if (!name) return account(req, res, { error: 'Your name can’t be empty.' }, 400);
    store.users.rename(req.user.id, name);
    res.flashRedirect('/account', 'Name saved.');
  });

  app.post('/account/password', (req, res) => {
    const password = String(req.body.password ?? '');
    if (!verifyPassword(String(req.body.current ?? ''), store.users.passwordHash(req.user.id))) {
      return account(req, res, { error: 'Your current password isn’t right.' }, 400);
    }
    if (password.length < 8) return account(req, res, { error: 'The new password needs at least 8 characters.' }, 400);
    store.users.setPassword(req.user.id, hashPassword(password));
    res.flashRedirect('/account', 'Password changed.');
  });

  app.post('/account/delete', (req, res) => {
    const id = req.user.id;
    if (!verifyPassword(String(req.body.password ?? ''), store.users.passwordHash(id))) {
      return account(req, res, { error: 'That password isn’t right.' }, 400);
    }
    if (store.users.groupCount(id) > 0) return account(req, res, { error: 'Leave all your groups first.' }, 400);
    if (store.users.isReferenced(id)) {
      return account(req, res, { error: 'Your name is still on expenses in a group you left, so the account has to stay to keep those records correct.' }, 400);
    }
    endSession(db, req, res);
    store.users.delete(id);
    res.redirect('/login');
  });

  app.use((req, res) => notFound(res));
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).type('text').send('Something went wrong. Check the server log.');
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb(process.env.TALLY_DB ?? join(HERE, 'data', 'tally.db'));
  const port = Number(process.env.PORT ?? 3000);
  createApp(db).listen(port, () => console.log(`Tally running at http://localhost:${port}`));
}
