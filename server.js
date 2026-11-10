import express from 'express';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { openDb, tx } from './lib/db.js';
import { createStore, DELETED_EMAIL_DOMAIN } from './lib/store.js';
import {
  hashPassword, verifyPassword, startSession, endSession, endOtherSessions, purgeExpiredSessions, loadUser, requireLogin,
} from './lib/auth.js';
import { flash } from './lib/flash.js';
import { toCents, toAmountText, simplifyDebts, effectOn, netWithEachPerson, isSettled } from './lib/ledger.js';
import { cleanText, toIds, isEmail, safeNextPath, parseExpense, parseSettlement } from './lib/forms.js';
import { todayIso } from './lib/dates.js';
import { MAX_USERS, MIN_PASSWORD_LENGTH, LOGIN_LIMITS } from './lib/limits.js';
import { createThrottle } from './lib/throttle.js';
import { securityHeaders, refuseCrossSiteWrites } from './lib/security.js';
import * as views from './lib/views.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const store = createStore(db);
  purgeExpiredSessions(db);
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(refuseCrossSiteWrites);
  app.use(express.static(join(HERE, 'public')));
  // The browser imports the same money maths the server uses.
  app.get('/ledger.js', (req, res) => res.sendFile(join(HERE, 'lib', 'ledger.js')));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(loadUser(db));
  app.use(flash);
  app.use((req, res, next) => {
    res.page = (title, body, status = 200) =>
      res.status(status).type('html').send(views.layout({ title, user: req.user, body, flash: req.flash }));
    next();
  });

  const notFound = (res) => res.page('Not found', views.notFoundPage(), 404);
  const failedLoginsByEmail = createThrottle({ limit: LOGIN_LIMITS.perEmail, windowMs: LOGIN_LIMITS.windowMs });
  const failedLoginsByAddress = createThrottle({ limit: LOGIN_LIMITS.perAddress, windowMs: LOGIN_LIMITS.windowMs });
  const spotsLeft = () => MAX_USERS - store.users.count();
  const passwordOf = (body, field) => String(body[field] ?? '');
  /** Ids from a members checkbox list, keeping only real users. */
  const existingUserIds = (field) => {
    const known = new Set(store.users.all().map((u) => u.id));
    return toIds(field).filter((id) => known.has(id));
  };

  // ---------- auth ----------
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.page('Log in', views.loginPage({ next: safeNextPath(req.query.next), spotsLeft: spotsLeft() }));
  });

  app.post('/login', (req, res) => {
    const email = cleanText(req.body.email, 200).toLowerCase();
    const next = safeNextPath(req.body.next);
    const loginPage = (error, status) => res.page('Log in', views.loginPage({ error, email, next, spotsLeft: spotsLeft() }), status);
    // Checked before the password, so a locked email can't be guessed even with the right one.
    if (failedLoginsByEmail.isBlocked(email) || failedLoginsByAddress.isBlocked(req.ip)) {
      const minutes = Math.round(LOGIN_LIMITS.windowMs / 60000);
      return loginPage(`Too many failed attempts. Wait ${minutes} minutes and try again.`, 429);
    }
    const user = store.users.byEmail(email);
    if (!user || !verifyPassword(passwordOf(req.body, 'password'), user.password_hash)) {
      failedLoginsByEmail.recordFailure(email);
      failedLoginsByAddress.recordFailure(req.ip);
      return loginPage('That email and password don’t match.', 401);
    }
    failedLoginsByEmail.clear(email);
    purgeExpiredSessions(db);
    startSession(db, res, user.id);
    res.redirect(next);
  });

  app.get('/signup', (req, res) => {
    if (req.user) return res.redirect('/');
    res.page('Sign up', views.signupPage({ spotsLeft: spotsLeft() }));
  });

  app.post('/signup', (req, res) => {
    const values = { name: cleanText(req.body.name, 40), email: cleanText(req.body.email, 200).toLowerCase() };
    const password = passwordOf(req.body, 'password');
    const fail = (error, status = 400) => res.page('Sign up', views.signupPage({ error, values, spotsLeft: spotsLeft() }), status);
    if (spotsLeft() <= 0) return fail(`All ${MAX_USERS} accounts are taken.`, 403);
    if (!values.name) return fail('Please enter your name.');
    if (!isEmail(values.email) || values.email.endsWith(DELETED_EMAIL_DOMAIN)) return fail('Please enter a valid email address.');
    if (password.length < MIN_PASSWORD_LENGTH) return fail(`Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
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
    const myId = req.user.id;
    const payments = [];
    const groups = store.groups.forUser(myId).map((group) => {
      const balances = store.groupBalances(group.id);
      payments.push(...simplifyDebts(balances));
      return { ...group, cents: balances.get(myId) ?? 0 };
    });
    const people = [...netWithEachPerson(myId, payments)]
      .map(([id, cents]) => ({ ...store.users.get(id), cents }))
      .sort((a, b) => b.cents - a.cents);
    const owedToMe = people.filter((p) => p.cents > 0).reduce((total, p) => total + p.cents, 0);
    const iOwe = -people.filter((p) => p.cents < 0).reduce((total, p) => total + p.cents, 0);
    res.page('Dashboard', views.dashboardPage({ net: owedToMe - iOwe, owedToMe, iOwe, people, groups }));
  });

  // ---------- groups ----------
  app.get('/groups/new', (req, res) => {
    res.page('New group', views.groupNewPage({ me: req.user, allUsers: store.users.all() }));
  });

  app.post('/groups', (req, res) => {
    const name = cleanText(req.body.name, 60);
    const members = existingUserIds(req.body.members);
    if (!name) {
      return res.page('New group', views.groupNewPage({ me: req.user, allUsers: store.users.all(), error: 'Give the group a name.', values: { name, members } }), 400);
    }
    const id = store.groups.create(name, req.user.id, members);
    res.flashRedirect(`/groups/${id}`, `Created “${name}”.`);
  });

  // Every /groups/:gid route below requires the user to be a member of that group.
  app.use('/groups/:gid', (req, res, next) => {
    const groupId = Number(req.params.gid);
    req.group = Number.isSafeInteger(groupId) ? store.groups.getForMember(groupId, req.user.id) : undefined;
    if (!req.group) return notFound(res);
    req.members = store.groups.members(groupId);
    req.memberIds = new Set(req.members.map((m) => m.id));
    next();
  });

  /** Looks up user names by id, once each, for a single page render. */
  const makeNameLookup = () => {
    const names = new Map();
    return (id) => {
      if (!names.has(id)) names.set(id, store.users.nameOf(id));
      return names.get(id);
    };
  };

  app.get('/groups/:gid', (req, res) => {
    const group = req.group;
    const myId = req.user.id;
    const timeline = [
      ...store.expenses.forGroup(group.id).map((e) => ({ ...e, kind: 'expense', date: e.spentOn, effect: effectOn(myId, e) })),
      ...store.settlements.forGroup(group.id).map((s) => ({ ...s, kind: 'settlement', date: s.paidOn })),
    ].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const balances = store.groupBalances(group.id);
    res.page(group.name, views.groupPage({
      group, me: req.user, members: req.members, timeline, balances,
      suggestions: simplifyDebts(balances), nameOf: makeNameLookup(),
    }));
  });

  const renderSettings = (req, res, error, status = 200) => {
    res.page('Group settings', views.groupSettingsPage({
      group: req.group, me: req.user, members: req.members,
      others: store.users.all().filter((u) => !req.memberIds.has(u.id)),
      balances: store.groupBalances(req.group.id), error,
    }), status);
  };

  app.get('/groups/:gid/edit', (req, res) => renderSettings(req, res));

  app.post('/groups/:gid/rename', (req, res) => {
    const name = cleanText(req.body.name, 60);
    if (!name) return renderSettings(req, res, 'The group needs a name.', 400);
    store.groups.rename(req.group.id, name);
    res.flashRedirect(`/groups/${req.group.id}/edit`, 'Group renamed.');
  });

  app.post('/groups/:gid/members', (req, res) => {
    const added = existingUserIds(req.body.members);
    store.groups.addMembers(req.group.id, added);
    res.flashRedirect(`/groups/${req.group.id}/edit`, added.length ? `Added ${added.length} member${added.length === 1 ? '' : 's'}.` : 'Nobody selected.');
  });

  app.post('/groups/:gid/members/:uid/remove', (req, res) => {
    const userId = Number(req.params.uid);
    const group = req.group;
    if (!req.memberIds.has(userId)) return notFound(res);
    if ((store.groupBalances(group.id).get(userId) ?? 0) !== 0) {
      return renderSettings(req, res, 'Only people who are settled up can be removed. Record the payments first.', 400);
    }
    // A group with nobody in it could never be seen or deleted again, so the last one out deletes it.
    if (req.members.length === 1) {
      store.groups.delete(group.id);
      return res.flashRedirect('/', `You left “${group.name}”. You were the last member, so the group was deleted.`);
    }
    store.groups.removeMember(group.id, userId);
    if (userId === req.user.id) return res.flashRedirect('/', `You left “${group.name}”.`);
    res.flashRedirect(`/groups/${group.id}/edit`, 'Member removed.');
  });

  app.post('/groups/:gid/delete', (req, res) => {
    if (!isSettled(store.groupBalances(req.group.id))) return renderSettings(req, res, views.SETTLE_BEFORE_DELETING, 400);
    store.groups.delete(req.group.id);
    res.flashRedirect('/', `Deleted “${req.group.name}”.`);
  });

  /**
   * Apply a change to a group's expenses or payments, but undo it if it would leave someone who
   * has left the group with a balance (they can no longer settle it). Returns an error message or null.
   */
  function changeLedger(req, change) {
    let owing = [];
    try {
      tx(db, () => {
        change();
        owing = [...store.groupBalances(req.group.id)].filter(([id, cents]) => cents !== 0 && !req.memberIds.has(id));
        if (owing.length) throw new Error('former member would owe money');
      });
      return null;
    } catch (err) {
      if (!owing.length) throw err;
      const names = owing.map(([id]) => store.users.nameOf(id)).join(' and ');
      return `This would leave ${names} with an unsettled balance, but ${owing.length === 1 ? 'they are' : 'they are all'} no longer in this group. Add them back in Settings first if the change is right.`;
    }
  }

  /** Current members, plus anyone else these user ids name (people who have since left the group). */
  const peopleIncluding = (req, userIds) => {
    const people = new Map(req.members.map((m) => [m.id, m]));
    for (const id of userIds) if (!people.has(id)) people.set(id, store.users.get(id));
    return [...people.values()].filter(Boolean);
  };

  // ---------- expenses ----------
  const expensePeople = (req, e) => peopleIncluding(req, [e.paidBy, ...e.shares.map((s) => s.userId)]);
  const savedExpenseForm = (e) => ({ ...e, amount: toAmountText(e.amountCents) });
  const renderExpenseForm = (req, res, { people, expense, error }) => {
    const title = expense?.id ? 'Edit expense' : 'Add expense';
    res.page(title, views.expenseFormPage({ group: req.group, me: req.user, people, expense, error }), error ? 400 : 200);
  };

  const loadExpense = (req, res, next) => {
    const expense = store.expenses.get(Number(req.params.eid));
    if (!expense || expense.groupId !== req.group.id) return notFound(res);
    req.expense = expense;
    next();
  };

  app.get('/groups/:gid/expenses/new', (req, res) => renderExpenseForm(req, res, { people: req.members }));

  app.post('/groups/:gid/expenses', (req, res) => {
    const people = req.members;
    const { value, error, draft } = parseExpense(req.body, people);
    if (error) return renderExpenseForm(req, res, { people, expense: draft, error });
    store.expenses.save({ ...value, groupId: req.group.id }, req.user.id);
    res.flashRedirect(`/groups/${req.group.id}`, `Added “${value.description}”.`);
  });

  app.get('/groups/:gid/expenses/:eid/edit', loadExpense, (req, res) => {
    renderExpenseForm(req, res, { people: expensePeople(req, req.expense), expense: savedExpenseForm(req.expense) });
  });

  app.post('/groups/:gid/expenses/:eid', loadExpense, (req, res) => {
    const id = req.expense.id;
    const people = expensePeople(req, req.expense);
    const { value, error, draft } = parseExpense(req.body, people);
    if (error) return renderExpenseForm(req, res, { people, expense: { ...draft, id }, error });
    const blocked = changeLedger(req, () => store.expenses.save({ ...value, id }, req.user.id));
    if (blocked) return renderExpenseForm(req, res, { people, expense: { ...value, id }, error: blocked });
    res.flashRedirect(`/groups/${req.group.id}`, 'Expense updated.');
  });

  app.post('/groups/:gid/expenses/:eid/delete', loadExpense, (req, res) => {
    const expense = req.expense;
    const blocked = changeLedger(req, () => store.expenses.delete(expense.id));
    if (blocked) return renderExpenseForm(req, res, { people: expensePeople(req, expense), expense: savedExpenseForm(expense), error: blocked });
    res.flashRedirect(`/groups/${req.group.id}`, `Deleted “${expense.description}”.`);
  });

  // ---------- settlements ----------
  const settlementPeople = (req, s) => peopleIncluding(req, [s.fromUser, s.toUser]);
  const savedSettlementForm = (s) => ({ ...s, amount: toAmountText(s.amountCents) });
  const renderSettlementForm = (req, res, { people, settlement, error }) => {
    const title = settlement?.id ? 'Edit payment' : 'Settle up';
    res.page(title, views.settlementFormPage({ group: req.group, me: req.user, people, settlement, error }), error ? 400 : 200);
  };

  const loadSettlement = (req, res, next) => {
    const settlement = store.settlements.get(Number(req.params.sid));
    if (!settlement || settlement.groupId !== req.group.id) return notFound(res);
    req.settlement = settlement;
    next();
  };

  app.get('/groups/:gid/settlements/new', (req, res) => {
    if (req.members.length < 2) return res.flashRedirect(`/groups/${req.group.id}`, 'Add someone else to the group first.');
    // "Record" on a suggested payment pre-fills the form.
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    const prefill = req.memberIds.has(from) && req.memberIds.has(to) && from !== to
      ? { fromUser: from, toUser: to, amount: toCents(req.query.amount) ? cleanText(req.query.amount, 20) : '', paidOn: todayIso(), note: '' }
      : undefined;
    renderSettlementForm(req, res, { people: req.members, settlement: prefill });
  });

  app.post('/groups/:gid/settlements', (req, res) => {
    const people = req.members;
    const { value, error, draft } = parseSettlement(req.body, people);
    if (error) return renderSettlementForm(req, res, { people, settlement: draft, error });
    store.settlements.save({ ...value, groupId: req.group.id }, req.user.id);
    res.flashRedirect(`/groups/${req.group.id}`, 'Payment recorded.');
  });

  app.get('/groups/:gid/settlements/:sid/edit', loadSettlement, (req, res) => {
    renderSettlementForm(req, res, { people: settlementPeople(req, req.settlement), settlement: savedSettlementForm(req.settlement) });
  });

  app.post('/groups/:gid/settlements/:sid', loadSettlement, (req, res) => {
    const id = req.settlement.id;
    const people = settlementPeople(req, req.settlement);
    const { value, error, draft } = parseSettlement(req.body, people);
    if (error) return renderSettlementForm(req, res, { people, settlement: { ...draft, id }, error });
    const blocked = changeLedger(req, () => store.settlements.save({ ...value, id }, req.user.id));
    if (blocked) return renderSettlementForm(req, res, { people, settlement: { ...value, id }, error: blocked });
    res.flashRedirect(`/groups/${req.group.id}`, 'Payment updated.');
  });

  app.post('/groups/:gid/settlements/:sid/delete', loadSettlement, (req, res) => {
    const settlement = req.settlement;
    const blocked = changeLedger(req, () => store.settlements.delete(settlement.id));
    if (blocked) {
      return renderSettlementForm(req, res, { people: settlementPeople(req, settlement), settlement: savedSettlementForm(settlement), error: blocked });
    }
    res.flashRedirect(`/groups/${req.group.id}`, 'Payment deleted.');
  });

  // ---------- account ----------
  const renderAccount = (req, res, { error, notice } = {}) =>
    res.page('Account', views.accountPage({ user: req.user, groupCount: store.users.groupCount(req.user.id), error, notice }), error ? 400 : 200);

  app.get('/account', (req, res) => {
    const notice = req.flash;
    req.flash = undefined; // shown inside the page instead of the banner
    renderAccount(req, res, { notice });
  });

  app.post('/account/name', (req, res) => {
    const name = cleanText(req.body.name, 40);
    if (!name) return renderAccount(req, res, { error: 'Your name can’t be empty.' });
    store.users.rename(req.user.id, name);
    res.flashRedirect('/account', 'Name saved.');
  });

  app.post('/account/password', (req, res) => {
    const password = passwordOf(req.body, 'password');
    if (!verifyPassword(passwordOf(req.body, 'current'), store.users.passwordHash(req.user.id))) {
      return renderAccount(req, res, { error: 'Your current password isn’t right.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return renderAccount(req, res, { error: `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    store.users.setPassword(req.user.id, hashPassword(password));
    // Anyone else signed in as this user (a shared computer, a copied cookie) is signed out.
    endOtherSessions(db, req.user.id, req.sessionToken);
    res.flashRedirect('/account', 'Password changed.');
  });

  app.post('/account/delete', (req, res) => {
    const id = req.user.id;
    if (!verifyPassword(passwordOf(req.body, 'password'), store.users.passwordHash(id))) {
      return renderAccount(req, res, { error: 'That password isn’t right.' });
    }
    if (store.users.groupCount(id) > 0) return renderAccount(req, res, { error: 'Leave all your groups first.' });
    endSession(db, req, res);
    // On past expenses: keep the row so the history adds up, but remove everything personal.
    if (store.users.isReferenced(id)) store.users.anonymise(id);
    else store.users.delete(id);
    res.redirect('/login');
  });

  app.use((req, res) => notFound(res));
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).type('text').send('Something went wrong. Check the server log.');
  });

  return app;
}

/**
 * Where to listen. Loopback by default: Tally is for one laptop, so other machines on the same
 * Wi-Fi shouldn't reach it. Set HOST=0.0.0.0 to share it on a network you trust.
 */
export function listenAddress(env) {
  return { host: env.HOST || '127.0.0.1', port: Number(env.PORT ?? 3000) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb(process.env.TALLY_DB ?? join(HERE, 'data', 'tally.db'));
  const { host, port } = listenAddress(process.env);
  const shown = host === '127.0.0.1' ? 'localhost' : host;
  createApp(db).listen(port, host, () => console.log(`Tally running at http://${shown}:${port}`));
}
