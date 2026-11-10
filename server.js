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
import { MAX_USERS, MIN_PASSWORD_LENGTH, LOGIN_LIMITS, MAX_LENGTH } from './lib/limits.js';
import { createThrottle } from './lib/throttle.js';
import { securityHeaders, refuseCrossSiteWrites } from './lib/security.js';
import * as views from './lib/views.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A URL id as a number, or undefined if it isn't a safe integer ("abc", "1.5", "1e99"). */
const toSafeId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
};

export function createApp(db) {
  const store = createStore(db);
  purgeExpiredSessions(store.sessions);
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(refuseCrossSiteWrites);
  app.use(express.static(join(HERE, 'public')));
  // The browser imports the same money maths the server uses. Sent relative to `root` so only
  // "ledger.js" itself is checked for a leading dot, not every folder Tally is installed under.
  app.get('/ledger.js', (req, res) => res.sendFile('ledger.js', { root: join(HERE, 'lib') }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(loadUser(store.sessions));
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
    const email = cleanText(req.body.email, MAX_LENGTH.email).toLowerCase();
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
    purgeExpiredSessions(store.sessions);
    startSession(store.sessions, res, user.id);
    res.redirect(next);
  });

  app.get('/signup', (req, res) => {
    if (req.user) return res.redirect('/');
    res.page('Sign up', views.signupPage({ spotsLeft: spotsLeft() }));
  });

  app.post('/signup', (req, res) => {
    const values = { name: cleanText(req.body.name, MAX_LENGTH.userName), email: cleanText(req.body.email, MAX_LENGTH.email).toLowerCase() };
    const password = passwordOf(req.body, 'password');
    const fail = (error, status = 400) => res.page('Sign up', views.signupPage({ error, values, spotsLeft: spotsLeft() }), status);
    if (spotsLeft() <= 0) return fail(`All ${MAX_USERS} accounts are taken.`, 403);
    if (!values.name) return fail('Please enter your name.');
    if (!isEmail(values.email) || values.email.endsWith(DELETED_EMAIL_DOMAIN)) return fail('Please enter a valid email address.');
    if (password.length < MIN_PASSWORD_LENGTH) return fail(`Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (store.users.byEmail(values.email)) return fail('There’s already an account with that email.');
    const id = store.users.create(values.name, values.email, hashPassword(password));
    startSession(store.sessions, res, id);
    res.flashRedirect('/', `Welcome to Tally, ${values.name}!`);
  });

  app.post('/logout', (req, res) => {
    endSession(store.sessions, req, res);
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
    const name = cleanText(req.body.name, MAX_LENGTH.groupName);
    const members = existingUserIds(req.body.members);
    if (!name) {
      return res.page('New group', views.groupNewPage({ me: req.user, allUsers: store.users.all(), error: 'Give the group a name.', values: { name, members } }), 400);
    }
    const id = store.groups.create(name, req.user.id, members);
    res.flashRedirect(`/groups/${id}`, `Created “${name}”.`);
  });

  // Every /groups/:gid route below requires the user to be a member of that group.
  app.use('/groups/:gid', (req, res, next) => {
    const groupId = toSafeId(req.params.gid);
    req.group = groupId === undefined ? undefined : store.groups.getForMember(groupId, req.user.id);
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
    const name = cleanText(req.body.name, MAX_LENGTH.groupName);
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

  // ---------- expenses and payments ----------
  /**
   * Expenses and payments ("entries") share one set of routes:
   *   GET  /groups/:gid/<path>/new          form for a new entry
   *   POST /groups/:gid/<path>              create
   *   GET  /groups/:gid/<path>/:<param>/edit
   *   POST /groups/:gid/<path>/:<param>     update   (guarded by changeLedger)
   *   POST /groups/:gid/<path>/:<param>/delete       (guarded by changeLedger)
   */
  function entryRoutes(kind) {
    const { path, param, repo, parse, formPage, formKey, titles, messages } = kind;
    const peopleFor = (req, entry) => peopleIncluding(req, kind.peopleOn(entry));
    const savedForm = (entry) => ({ ...entry, amount: toAmountText(entry.amountCents) });
    const render = (req, res, { people, entry, error }) => {
      const title = entry?.id ? titles.edit : titles.new;
      res.page(title, formPage({ group: req.group, me: req.user, people, [formKey]: entry, error }), error ? 400 : 200);
    };

    // Loads the entry for :<param>, which must be an id in this group.
    app.param(param, (req, res, next, value) => {
      const id = toSafeId(value);
      const entry = id === undefined ? undefined : repo.get(id);
      if (!entry || entry.groupId !== req.group?.id) return notFound(res);
      req.entry = entry;
      next();
    });

    const base = `/groups/:gid/${path}`;
    app.get(`${base}/new`, (req, res) => {
      const start = kind.newEntry ? kind.newEntry(req, res) : {};
      if (start) render(req, res, { people: req.members, entry: start.entry });
    });

    app.post(base, (req, res) => {
      const people = req.members;
      const { value, error, draft } = parse(req.body, people);
      if (error) return render(req, res, { people, entry: draft, error });
      repo.save({ ...value, groupId: req.group.id }, req.user.id);
      res.flashRedirect(`/groups/${req.group.id}`, messages.created(value));
    });

    app.get(`${base}/:${param}/edit`, (req, res) => {
      render(req, res, { people: peopleFor(req, req.entry), entry: savedForm(req.entry) });
    });

    app.post(`${base}/:${param}`, (req, res) => {
      const id = req.entry.id;
      const people = peopleFor(req, req.entry);
      const { value, error, draft } = parse(req.body, people);
      if (error) return render(req, res, { people, entry: { ...draft, id }, error });
      const blocked = changeLedger(req, () => repo.save({ ...value, id }, req.user.id));
      if (blocked) return render(req, res, { people, entry: { ...value, id }, error: blocked });
      res.flashRedirect(`/groups/${req.group.id}`, messages.updated);
    });

    app.post(`${base}/:${param}/delete`, (req, res) => {
      const entry = req.entry;
      const blocked = changeLedger(req, () => repo.delete(entry.id));
      if (blocked) return render(req, res, { people: peopleFor(req, entry), entry: savedForm(entry), error: blocked });
      res.flashRedirect(`/groups/${req.group.id}`, messages.deleted(entry));
    });
  }

  entryRoutes({
    path: 'expenses',
    param: 'eid',
    repo: store.expenses,
    parse: parseExpense,
    formPage: views.expenseFormPage,
    formKey: 'expense',
    titles: { new: 'Add expense', edit: 'Edit expense' },
    peopleOn: (e) => [e.paidBy, ...e.shares.map((s) => s.userId)],
    messages: {
      created: (e) => `Added “${e.description}”.`,
      updated: 'Expense updated.',
      deleted: (e) => `Deleted “${e.description}”.`,
    },
  });

  entryRoutes({
    path: 'settlements',
    param: 'sid',
    repo: store.settlements,
    parse: parseSettlement,
    formPage: views.settlementFormPage,
    formKey: 'settlement',
    titles: { new: 'Settle up', edit: 'Edit payment' },
    peopleOn: (s) => [s.fromUser, s.toUser],
    messages: {
      created: () => 'Payment recorded.',
      updated: 'Payment updated.',
      deleted: () => 'Payment deleted.',
    },
    // Settling up needs someone to pay; "Record" on a suggested payment pre-fills the form.
    newEntry(req, res) {
      if (req.members.length < 2) {
        res.flashRedirect(`/groups/${req.group.id}`, 'Add someone else to the group first.');
        return null;
      }
      const from = Number(req.query.from);
      const to = Number(req.query.to);
      const suggested = req.memberIds.has(from) && req.memberIds.has(to) && from !== to;
      const amount = toCents(req.query.amount) ? cleanText(req.query.amount, MAX_LENGTH.amount) : '';
      return { entry: suggested ? { fromUser: from, toUser: to, amount, paidOn: todayIso(), note: '' } : undefined };
    },
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
    const name = cleanText(req.body.name, MAX_LENGTH.userName);
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
    endOtherSessions(store.sessions, req.user.id, req.sessionToken);
    res.flashRedirect('/account', 'Password changed.');
  });

  app.post('/account/delete', (req, res) => {
    const id = req.user.id;
    if (!verifyPassword(passwordOf(req.body, 'password'), store.users.passwordHash(id))) {
      return renderAccount(req, res, { error: 'That password isn’t right.' });
    }
    if (store.users.groupCount(id) > 0) return renderAccount(req, res, { error: 'Leave all your groups first.' });
    endSession(store.sessions, req, res);
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
