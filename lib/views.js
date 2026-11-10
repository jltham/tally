import { formatCents, toAmountText, isSettled, CURRENCY } from './ledger.js';
import { todayIso, formatIsoDate } from './dates.js';
import { MAX_USERS, MIN_PASSWORD_LENGTH } from './limits.js';

// ---------- tiny safe templating ----------
/** Markup that is already safe to output as-is. */
class SafeHtml {
  constructor(markup) { this.markup = markup; }
  toString() { return this.markup; }
}
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.markup;
  if (Array.isArray(value)) return value.map(escapeValue).join('');
  return String(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}
/** Tagged template: interpolated values are HTML-escaped unless produced by html`` itself. */
export function html(strings, ...values) {
  return new SafeHtml(strings.reduce((out, s, i) => out + s + (i < values.length ? escapeValue(values[i]) : ''), ''));
}

/** "You" when the person is the viewer, otherwise their name. `lower` gives "you" for mid-sentence. */
const nameFor = (me, userId, name, { lower = false } = {}) => (userId === me.id ? (lower ? 'you' : 'You') : name);

/** One place for how each split type is offered and described. */
const SPLIT_TYPES = {
  equal: { option: 'Equally', describe: (e) => `equally ${e.shares.length} ways` },
  exact: { option: 'By exact amounts', describe: () => 'by exact amounts' },
};

const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const avatar = (u) => html`<span class="avatar" style="--h:${(u.id * 67) % 360}" aria-hidden="true">${initials(u.name)}</span>`;

export const SETTLE_BEFORE_DELETING =
  'You can delete this group once everyone is settled up, so nobody loses track of money they’re owed.';

/** CSS class for an amount: green when someone is owed it, orange when they owe it. */
const toneOf = (cents) => (cents > 0 ? 'pos' : cents < 0 ? 'neg' : 'muted');

/**
 * A signed amount as words plus the absolute amount, e.g. "you lent S$5.00".
 * `words` gives the wording for { positive, negative, zero }; `lineBreak` puts the amount on its own line.
 */
function signedAmount(cents, words, { lineBreak = false } = {}) {
  if (cents === 0) return html`<span class="muted">${words.zero}</span>`;
  const label = cents > 0 ? words.positive : words.negative;
  return html`<span class="${toneOf(cents)}">${label}${lineBreak ? html`<br>` : ' '}${formatCents(Math.abs(cents))}</span>`;
}

function balanceText(cents, { you = false } = {}) {
  return signedAmount(cents, you
    ? { positive: 'you are owed', negative: 'you owe', zero: 'settled up' }
    : { positive: 'is owed', negative: 'owes', zero: 'settled up' });
}

const personOptions = (people, me, selectedId) =>
  people.map((p) => html`<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${nameFor(me, p.id, p.name)}</option>`);

const errorBox = (error) => error && html`<p class="error" role="alert">${error}</p>`;

// ---------- layout ----------
export function layout({ title, user, body, flash }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title ? `${title} · Tally` : 'Tally'}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/"><span class="brand-mark">T</span> Tally</a>
    ${user && html`<nav>
      <a href="/">Dashboard</a>
      <a href="/account">${user.name}</a>
      <form method="post" action="/logout"><button class="linklike">Log out</button></form>
    </nav>`}
  </header>
  <main>
    ${flash && html`<p class="flash" role="status">${flash}</p>`}
    ${body}
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>`.toString();
}

// ---------- auth ----------
export function loginPage({ error, email = '', next = '/', spotsLeft }) {
  return html`<section class="card narrow">
    <h1>Log in</h1>
    ${errorBox(error)}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value="${next}">
      <label>Email <input type="email" name="email" value="${email}" required autofocus autocomplete="username"></label>
      <label>Password <input type="password" name="password" required autocomplete="current-password"></label>
      <button class="primary">Log in</button>
    </form>
    <p class="muted small">${spotsLeft > 0
      ? html`New here? <a href="/signup">Create an account</a> (${spotsLeft} of ${MAX_USERS} spots left).`
      : `All ${MAX_USERS} accounts are taken, so sign-up is closed.`}</p>
  </section>`;
}

export function signupPage({ error, values = {}, spotsLeft }) {
  if (spotsLeft <= 0) {
    return html`<section class="card narrow"><h1>Sign-up is closed</h1>
      <p>Tally is for one small circle, and all ${MAX_USERS} accounts are in use. Ask someone to free up a spot by deleting an unused account.</p>
      <p><a href="/login">Back to log in</a></p></section>`;
  }
  return html`<section class="card narrow">
    <h1>Create your account</h1>
    <p class="muted small">${spotsLeft} of ${MAX_USERS} spots left.</p>
    ${errorBox(error)}
    <form method="post" action="/signup" class="stack">
      <label>Your name <input name="name" value="${values.name}" required maxlength="40" autofocus autocomplete="name"></label>
      <label>Email <input type="email" name="email" value="${values.email}" required autocomplete="username"></label>
      <label>Password <input type="password" name="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password">
        <span class="hint">At least ${MIN_PASSWORD_LENGTH} characters.</span></label>
      <button class="primary">Sign up</button>
    </form>
    <p class="muted small">Already have an account? <a href="/login">Log in</a></p>
  </section>`;
}

// ---------- dashboard ----------
export function dashboardPage({ net, owedToMe, iOwe, people, groups }) {
  return html`<section class="summary">
      <div><span class="label">Total balance</span><strong class="${net === 0 ? '' : toneOf(net)}">${formatCents(net)}</strong></div>
      <div><span class="label">You owe</span><strong class="neg">${formatCents(iOwe)}</strong></div>
      <div><span class="label">You are owed</span><strong class="pos">${formatCents(owedToMe)}</strong></div>
    </section>
    <div class="columns">
      <section class="card">
        <div class="card-head"><h2>Your groups</h2><a class="button" href="/groups/new">+ New group</a></div>
        ${groups.length
          ? html`<ul class="list">${groups.map((g) => html`<li><a class="row" href="/groups/${g.id}">
              <span class="grow">${g.name}</span>${balanceText(g.cents, { you: true })}</a></li>`)}</ul>`
          : html`<p class="empty">No groups yet. Create one for your flat, a trip, or a dinner crew.</p>`}
      </section>
      <section class="card">
        <h2>People</h2>
        ${people.length
          ? html`<ul class="list">${people.map((p) => html`<li class="row">${avatar(p)}<span class="grow">${p.name}</span>
              ${signedAmount(p.cents, { positive: 'owes you', negative: 'you owe', zero: 'settled up' })}</li>`)}</ul>`
          : html`<p class="empty">You're all settled up. 🎉</p>`}
      </section>
    </div>`;
}

// ---------- groups ----------
function memberPicker(users, checkedIds, { lockId } = {}) {
  return html`<fieldset class="checks"><legend>Members</legend>
    ${users.map((u) => html`<label class="check">
      <input type="checkbox" name="members" value="${u.id}" ${checkedIds.includes(u.id) ? 'checked' : ''} ${u.id === lockId ? 'checked disabled' : ''}>
      ${avatar(u)} ${u.name}${u.id === lockId ? ' (you)' : ''}</label>`)}
  </fieldset>`;
}

export function groupNewPage({ me, allUsers, error, values = {} }) {
  return html`<section class="card narrow">
    <h1>New group</h1>
    ${errorBox(error)}
    <form method="post" action="/groups" class="stack">
      <label>Group name <input name="name" value="${values.name}" required maxlength="60" placeholder="e.g. Flat 12B, Japan trip" autofocus></label>
      ${allUsers.length > 1 ? memberPicker(allUsers, values.members ?? [], { lockId: me.id })
        : html`<p class="muted small">You're the only person with an account so far. Others can join once they sign up.</p>`}
      <div class="actions"><a href="/">Cancel</a><button class="primary">Create group</button></div>
    </form>
  </section>`;
}

export function groupPage({ group, me, members, timeline, balances, suggestions, nameOf }) {
  const myBal = balances.get(me.id) ?? 0;
  return html`<div class="page-head">
      <div><a class="crumb" href="/">← Dashboard</a><h1>${group.name}</h1>
        <p class="muted">${members.length} member${members.length === 1 ? '' : 's'} · ${balanceText(myBal, { you: true })}</p></div>
      <div class="head-actions">
        <a class="button primary" href="/groups/${group.id}/expenses/new">Add expense</a>
        <a class="button" href="/groups/${group.id}/settlements/new">Settle up</a>
        <a class="button ghost" href="/groups/${group.id}/edit">Settings</a>
      </div>
    </div>
    <div class="columns wide-left">
      <section class="card">
        <h2>Activity</h2>
        ${timeline.length ? html`<ul class="timeline">${timeline.map((item) => item.kind === 'expense'
          ? expenseRow(item, { me, nameOf, group })
          : settlementRow(item, { me, nameOf, group }))}</ul>`
          : html`<p class="empty">Nothing here yet. Add the first expense.</p>`}
      </section>
      <aside class="stack-gap">
        <section class="card">
          <h2>Balances</h2>
          <ul class="list">${members.map((m) => html`<li class="row">${avatar(m)}<span class="grow">${nameFor(me, m.id, m.name)}</span>
            ${balanceText(balances.get(m.id) ?? 0, { you: m.id === me.id })}</li>`)}</ul>
        </section>
        <section class="card">
          <h2>Suggested payments</h2>
          ${suggestions.length ? html`<p class="muted small">The fewest payments that settle everyone.</p>
            <ul class="list">${suggestions.map((s) => html`<li class="row wrap">
              <span class="grow"><b>${nameFor(me, s.fromUser, nameOf(s.fromUser))}</b> ${s.fromUser === me.id ? 'pay' : 'pays'} ${nameFor(me, s.toUser, nameOf(s.toUser), { lower: true })} <b>${formatCents(s.amountCents)}</b></span>
              <a class="button small" href="/groups/${group.id}/settlements/new?from=${s.fromUser}&to=${s.toUser}&amount=${toAmountText(s.amountCents)}">Record</a></li>`)}</ul>`
          : html`<p class="empty">Everyone is settled up.</p>`}
        </section>
      </aside>
    </div>`;
}

/** `e.effect` is how the expense moved the viewer's balance: + lent, - borrowed, 0 not involved. */
function expenseRow(e, { me, nameOf, group }) {
  return html`<li class="item">
    <div class="date">${formatIsoDate(e.spentOn)}</div>
    <div class="grow">
      <div class="title">${e.description}</div>
      <div class="muted small">${nameFor(me, e.paidBy, nameOf(e.paidBy))} paid ${formatCents(e.amountCents)} · split ${SPLIT_TYPES[e.splitType].describe(e)}</div>
    </div>
    <div class="effect">${signedAmount(e.effect, { positive: 'you lent', negative: 'you borrowed', zero: 'not involved' }, { lineBreak: true })}</div>
    <a class="edit" href="/groups/${group.id}/expenses/${e.id}/edit" aria-label="Edit ${e.description}">Edit</a>
  </li>`;
}

function settlementRow(s, { me, nameOf, group }) {
  return html`<li class="item payment">
    <div class="date">${formatIsoDate(s.paidOn)}</div>
    <div class="grow">
      <div class="title">💸 ${nameFor(me, s.fromUser, nameOf(s.fromUser))} paid ${nameFor(me, s.toUser, nameOf(s.toUser), { lower: true })} ${formatCents(s.amountCents)}</div>
      ${s.note && html`<div class="muted small">${s.note}</div>`}
    </div>
    <div class="effect"></div>
    <a class="edit" href="/groups/${group.id}/settlements/${s.id}/edit" aria-label="Edit payment">Edit</a>
  </li>`;
}

export function groupSettingsPage({ group, me, members, others, balances, error }) {
  return html`<div class="page-head"><div><a class="crumb" href="/groups/${group.id}">← ${group.name}</a><h1>Group settings</h1></div></div>
  ${errorBox(error)}
  <div class="columns">
    <section class="card">
      <h2>Name</h2>
      <form method="post" action="/groups/${group.id}/rename" class="inline">
        <input name="name" value="${group.name}" required maxlength="60" aria-label="Group name">
        <button>Save</button>
      </form>
    </section>
    <section class="card">
      <h2>Members</h2>
      <ul class="list">${members.map((m) => {
        const balance = balances.get(m.id) ?? 0;
        return html`<li class="row">${avatar(m)}<span class="grow">${m.name}${m.id === me.id ? ' (you)' : ''}</span>
          ${balance !== 0 ? html`<span class="muted small" title="Settle up before removing">${balanceText(balance)}</span>`
            : html`<form method="post" action="/groups/${group.id}/members/${m.id}/remove" data-confirm="${m.id !== me.id ? `Remove ${m.name} from the group?`
              : members.length === 1 ? 'You’re the last member, so leaving deletes this group. Leave?' : 'Leave this group?'}">
              <button class="small ghost">${m.id === me.id ? 'Leave' : 'Remove'}</button></form>`}</li>`;
      })}</ul>
      ${others.length ? html`<form method="post" action="/groups/${group.id}/members" class="stack top-gap">
          <fieldset class="checks"><legend>Add people</legend>
          ${others.map((u) => html`<label class="check"><input type="checkbox" name="members" value="${u.id}"> ${avatar(u)} ${u.name}</label>`)}
          </fieldset><button>Add selected</button></form>`
        : html`<p class="muted small">Everyone with an account is already in this group.</p>`}
    </section>
  </div>
  <section class="card danger">
    <h2>Delete group</h2>
    ${!isSettled(balances)
      ? html`<p class="muted">${SETTLE_BEFORE_DELETING}</p>`
      : html`<p class="muted">Deletes the group with all its expenses and payments. This can't be undone.</p>
        <form method="post" action="/groups/${group.id}/delete" data-confirm="Delete “${group.name}” and everything in it? This can't be undone.">
          <button class="danger">Delete group</button>
        </form>`}
  </section>`;
}

// ---------- expenses ----------
export function expenseFormPage({ group, me, people, expense, error }) {
  const isEdit = Boolean(expense?.id);
  const e = expense ?? { description: '', amount: '', paidBy: me.id, spentOn: todayIso(), splitType: 'equal', shares: [] };
  const shareOf = (id) => e.shares.find((s) => s.userId === id);
  // Everyone is ticked only on a brand-new form; otherwise show exactly what was submitted or saved.
  const inSplit = (id) => (expense === undefined ? true : Boolean(shareOf(id)));
  // Exact amounts as typed (after an error), else as saved.
  const exactText = (id) => e.shareTexts?.[id]
    ?? (e.splitType === 'exact' && shareOf(id) ? toAmountText(shareOf(id).cents) : '');
  const action = isEdit ? `/groups/${group.id}/expenses/${e.id}` : `/groups/${group.id}/expenses`;
  return html`<section class="card narrow">
    <a class="crumb" href="/groups/${group.id}">← ${group.name}</a>
    <h1>${isEdit ? 'Edit expense' : 'Add an expense'}</h1>
    ${errorBox(error)}
    <form method="post" action="${action}" class="stack" id="expense-form">
      <label>Description <input name="description" value="${e.description}" required maxlength="100" placeholder="e.g. Groceries" ${isEdit ? '' : 'autofocus'}></label>
      <div class="two">
        <label>Amount (${CURRENCY}) <input name="amount" value="${e.amount}" required inputmode="decimal" placeholder="0.00" id="amount"></label>
        <label>Date <input type="date" name="spent_on" value="${e.spentOn}" required></label>
      </div>
      <label>Paid by <select name="paid_by">${personOptions(people, me, e.paidBy)}</select></label>
      <fieldset class="segmented"><legend>Split</legend>
        ${Object.entries(SPLIT_TYPES).map(([type, { option }]) =>
          html`<label><input type="radio" name="split_type" value="${type}" ${e.splitType === type ? 'checked' : ''}> ${option}</label>`)}
      </fieldset>
      <fieldset class="checks" data-split="equal"><legend>Split equally between</legend>
        ${people.map((p) => html`<label class="check"><input type="checkbox" name="participants" value="${p.id}" ${inSplit(p.id) ? 'checked' : ''}>
          ${avatar(p)} <span class="grow">${nameFor(me, p.id, p.name)}</span><span class="muted small" data-each></span></label>`)}
      </fieldset>
      <fieldset class="checks" data-split="exact"><legend>Exact amounts</legend>
        ${people.map((p) => html`<label class="check">${avatar(p)} <span class="grow">${nameFor(me, p.id, p.name)}</span>
          <input class="share" name="share_${p.id}" inputmode="decimal" placeholder="0.00" value="${exactText(p.id)}"${e.invalidShareUserId === p.id ? html` aria-invalid="true"` : ''}></label>`)}
        <p class="small" data-remaining></p>
      </fieldset>
      <div class="actions"><a href="/groups/${group.id}">Cancel</a><button class="primary">${isEdit ? 'Save changes' : 'Add expense'}</button></div>
    </form>
    ${isEdit && html`<form method="post" action="/groups/${group.id}/expenses/${e.id}/delete" data-confirm="Delete this expense?" class="top-gap">
      <button class="danger small">Delete expense</button></form>`}
  </section>`;
}

// ---------- settlements ----------
export function settlementFormPage({ group, me, people, settlement, error }) {
  const isEdit = Boolean(settlement?.id);
  const s = settlement ?? { fromUser: me.id, toUser: people.find((p) => p.id !== me.id)?.id, amount: '', paidOn: todayIso(), note: '' };
  const action = isEdit ? `/groups/${group.id}/settlements/${s.id}` : `/groups/${group.id}/settlements`;
  return html`<section class="card narrow">
    <a class="crumb" href="/groups/${group.id}">← ${group.name}</a>
    <h1>${isEdit ? 'Edit payment' : 'Record a payment'}</h1>
    <p class="muted small">Use this when someone pays someone back, in cash or by bank transfer.</p>
    ${errorBox(error)}
    <form method="post" action="${action}" class="stack">
      <div class="two">
        <label>Who paid <select name="from_user">${personOptions(people, me, s.fromUser)}</select></label>
        <label>Paid to <select name="to_user">${personOptions(people, me, s.toUser)}</select></label>
      </div>
      <div class="two">
        <label>Amount (${CURRENCY}) <input name="amount" value="${s.amount}" required inputmode="decimal" placeholder="0.00"></label>
        <label>Date <input type="date" name="paid_on" value="${s.paidOn}" required></label>
      </div>
      <label>Note (optional) <input name="note" value="${s.note}" maxlength="100" placeholder="e.g. PayNow"></label>
      <div class="actions"><a href="/groups/${group.id}">Cancel</a><button class="primary">${isEdit ? 'Save changes' : 'Record payment'}</button></div>
    </form>
    ${isEdit && html`<form method="post" action="/groups/${group.id}/settlements/${s.id}/delete" data-confirm="Delete this payment?" class="top-gap">
      <button class="danger small">Delete payment</button></form>`}
  </section>`;
}

// ---------- account ----------
export function accountPage({ user, groupCount, error, notice }) {
  return html`<h1>Your account</h1>
  ${errorBox(error)}
  ${notice && html`<p class="flash" role="status">${notice}</p>`}
  <div class="columns">
    <section class="card">
      <h2>Profile</h2>
      <form method="post" action="/account/name" class="stack">
        <label>Name <input name="name" value="${user.name}" required maxlength="40"></label>
        <label>Email <input value="${user.email}" disabled></label>
        <button>Save name</button>
      </form>
    </section>
    <section class="card">
      <h2>Change password</h2>
      <form method="post" action="/account/password" class="stack">
        <label>Current password <input type="password" name="current" required autocomplete="current-password"></label>
        <label>New password <input type="password" name="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password"></label>
        <button>Change password</button>
      </form>
    </section>
  </div>
  <section class="card danger">
    <h2>Delete account</h2>
    ${groupCount > 0
      ? html`<p class="muted">You're in ${groupCount} group${groupCount === 1 ? '' : 's'}. Settle up and leave ${groupCount === 1 ? 'it' : 'them'} first, so nobody loses track of what they're owed.</p>`
      : html`<p class="muted">Frees up one of the ${MAX_USERS} spots and removes your name, email and password. Expenses you were part of stay, so everyone's totals still add up, but they show “Deleted user” instead of your name. This can't be undone.</p>
        <form method="post" action="/account/delete" data-confirm="Delete your account for good?" class="stack">
          <label>Confirm with your password <input type="password" name="password" required autocomplete="current-password"></label>
          <button class="danger">Delete my account</button></form>`}
  </section>`;
}

export function notFoundPage() {
  return html`<section class="card narrow"><h1>Not found</h1><p>That page doesn't exist, or you're not a member of that group.</p><p><a href="/">Back to dashboard</a></p></section>`;
}
