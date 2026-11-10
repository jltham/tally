import { formatCents } from './ledger.js';

// ---------- tiny safe templating ----------
class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}
/** Tagged template: interpolated values are HTML-escaped unless produced by html`` itself. */
export function html(strings, ...vals) {
  return new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? esc(vals[i]) : ''), ''));
}

const money = (c) => formatCents(c);
const plain = (c) => (c / 100).toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);
const niceDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const avatar = (u) => html`<span class="avatar" style="--h:${(u.id * 67) % 360}" aria-hidden="true">${initials(u.name)}</span>`;

function balanceText(cents, { you = false } = {}) {
  if (cents > 0) return html`<span class="pos">${you ? 'you are owed' : 'is owed'} ${money(cents)}</span>`;
  if (cents < 0) return html`<span class="neg">${you ? 'you owe' : 'owes'} ${money(-cents)}</span>`;
  return html`<span class="muted">settled up</span>`;
}

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
  <script src="/app.js" defer></script>
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
      ? html`New here? <a href="/signup">Create an account</a> (${spotsLeft} of 10 spots left).`
      : 'All 10 accounts are taken, so sign-up is closed.'}</p>
  </section>`;
}

export function signupPage({ error, values = {}, spotsLeft }) {
  if (spotsLeft <= 0) {
    return html`<section class="card narrow"><h1>Sign-up is closed</h1>
      <p>Tally is for one small circle, and all 10 accounts are in use. Ask someone to free up a spot by deleting an unused account.</p>
      <p><a href="/login">Back to log in</a></p></section>`;
  }
  return html`<section class="card narrow">
    <h1>Create your account</h1>
    <p class="muted small">${spotsLeft} of 10 spots left.</p>
    ${errorBox(error)}
    <form method="post" action="/signup" class="stack">
      <label>Your name <input name="name" value="${values.name}" required maxlength="40" autofocus autocomplete="name"></label>
      <label>Email <input type="email" name="email" value="${values.email}" required autocomplete="username"></label>
      <label>Password <input type="password" name="password" required minlength="8" autocomplete="new-password">
        <span class="hint">At least 8 characters.</span></label>
      <button class="primary">Sign up</button>
    </form>
    <p class="muted small">Already have an account? <a href="/login">Log in</a></p>
  </section>`;
}

// ---------- dashboard ----------
export function dashboardPage({ net, owedToMe, iOwe, people, groups }) {
  return html`<section class="summary">
      <div><span class="label">Total balance</span><strong class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net === 0 ? 'S$0.00' : money(net)}</strong></div>
      <div><span class="label">You owe</span><strong class="neg">${money(iOwe)}</strong></div>
      <div><span class="label">You are owed</span><strong class="pos">${money(owedToMe)}</strong></div>
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
              ${p.cents > 0 ? html`<span class="pos">owes you ${money(p.cents)}</span>` : html`<span class="neg">you owe ${money(-p.cents)}</span>`}</li>`)}</ul>`
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
          ? expenseRow(item, me, nameOf, group)
          : settlementRow(item, me, nameOf, group))}</ul>`
          : html`<p class="empty">Nothing here yet. Add the first expense.</p>`}
      </section>
      <aside class="stack-gap">
        <section class="card">
          <h2>Balances</h2>
          <ul class="list">${members.map((m) => html`<li class="row">${avatar(m)}<span class="grow">${m.id === me.id ? 'You' : m.name}</span>
            ${balanceText(balances.get(m.id) ?? 0, { you: m.id === me.id })}</li>`)}</ul>
        </section>
        <section class="card">
          <h2>Suggested payments</h2>
          ${suggestions.length ? html`<p class="muted small">The fewest payments that settle everyone.</p>
            <ul class="list">${suggestions.map((s) => html`<li class="row wrap">
              <span class="grow"><b>${s.fromUser === me.id ? 'You' : nameOf(s.fromUser)}</b> ${s.fromUser === me.id ? 'pay' : 'pays'} ${s.toUser === me.id ? 'you' : nameOf(s.toUser)} <b>${money(s.amountCents)}</b></span>
              <a class="button small" href="/groups/${group.id}/settlements/new?from=${s.fromUser}&to=${s.toUser}&amount=${plain(s.amountCents)}">Record</a></li>`)}</ul>`
          : html`<p class="empty">Everyone is settled up.</p>`}
        </section>
      </aside>
    </div>`;
}

function expenseRow(e, me, nameOf, group) {
  const lent = e.effect;
  return html`<li class="item">
    <div class="date">${niceDate(e.spentOn)}</div>
    <div class="grow">
      <div class="title">${e.description}</div>
      <div class="muted small">${e.paidBy === me.id ? 'You' : nameOf(e.paidBy)} paid ${money(e.amountCents)} · split ${e.splitType === 'equal' ? `equally ${e.shares.length} ways` : 'by exact amounts'}</div>
    </div>
    <div class="effect">${lent > 0 ? html`<span class="pos">you lent<br>${money(lent)}</span>`
      : lent < 0 ? html`<span class="neg">you borrowed<br>${money(-lent)}</span>`
      : html`<span class="muted">not involved</span>`}</div>
    <a class="edit" href="/groups/${group.id}/expenses/${e.id}/edit" aria-label="Edit ${e.description}">Edit</a>
  </li>`;
}

function settlementRow(s, me, nameOf, group) {
  return html`<li class="item payment">
    <div class="date">${niceDate(s.paidOn)}</div>
    <div class="grow">
      <div class="title">💸 ${s.fromUser === me.id ? 'You' : nameOf(s.fromUser)} paid ${s.toUser === me.id ? 'you' : nameOf(s.toUser)} ${money(s.amountCents)}</div>
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
        const bal = balances.get(m.id) ?? 0;
        return html`<li class="row">${avatar(m)}<span class="grow">${m.name}${m.id === me.id ? ' (you)' : ''}</span>
          ${bal !== 0 ? html`<span class="muted small" title="Settle up before removing">${balanceText(bal)}</span>`
            : html`<form method="post" action="/groups/${group.id}/members/${m.id}/remove" data-confirm="${m.id === me.id ? 'Leave this group?' : `Remove ${m.name} from the group?`}">
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
    <p class="muted">Deletes the group with all its expenses and payments. This can't be undone.</p>
    <form method="post" action="/groups/${group.id}/delete" data-confirm="Delete “${group.name}” and everything in it? This can't be undone.">
      <button class="danger">Delete group</button>
    </form>
  </section>`;
}

// ---------- expenses ----------
export function expenseFormPage({ group, me, people, expense, error }) {
  const isEdit = Boolean(expense?.id);
  const e = expense ?? { description: '', amount: '', paidBy: me.id, spentOn: today(), splitType: 'equal', shares: [] };
  const shareOf = (id) => e.shares.find((s) => s.userId === id);
  const inSplit = (id) => (e.shares.length ? Boolean(shareOf(id)) : true);
  const action = isEdit ? `/groups/${group.id}/expenses/${e.id}` : `/groups/${group.id}/expenses`;
  return html`<section class="card narrow">
    <a class="crumb" href="/groups/${group.id}">← ${group.name}</a>
    <h1>${isEdit ? 'Edit expense' : 'Add an expense'}</h1>
    ${errorBox(error)}
    <form method="post" action="${action}" class="stack" id="expense-form">
      <label>Description <input name="description" value="${e.description}" required maxlength="100" placeholder="e.g. Groceries" ${isEdit ? '' : 'autofocus'}></label>
      <div class="two">
        <label>Amount (S$) <input name="amount" value="${e.amount}" required inputmode="decimal" placeholder="0.00" id="amount"></label>
        <label>Date <input type="date" name="spent_on" value="${e.spentOn}" required></label>
      </div>
      <label>Paid by <select name="paid_by">${people.map((p) => html`<option value="${p.id}" ${p.id === e.paidBy ? 'selected' : ''}>${p.id === me.id ? 'You' : p.name}</option>`)}</select></label>
      <fieldset class="segmented"><legend>Split</legend>
        <label><input type="radio" name="split_type" value="equal" ${e.splitType === 'equal' ? 'checked' : ''}> Equally</label>
        <label><input type="radio" name="split_type" value="exact" ${e.splitType === 'exact' ? 'checked' : ''}> By exact amounts</label>
      </fieldset>
      <fieldset class="checks" data-split="equal"><legend>Split equally between</legend>
        ${people.map((p) => html`<label class="check"><input type="checkbox" name="participants" value="${p.id}" ${inSplit(p.id) ? 'checked' : ''}>
          ${avatar(p)} <span class="grow">${p.id === me.id ? 'You' : p.name}</span><span class="muted small" data-each></span></label>`)}
      </fieldset>
      <fieldset class="checks" data-split="exact"><legend>Exact amounts</legend>
        ${people.map((p) => html`<label class="check">${avatar(p)} <span class="grow">${p.id === me.id ? 'You' : p.name}</span>
          <input class="share" name="share_${p.id}" inputmode="decimal" placeholder="0.00" value="${e.splitType === 'exact' && shareOf(p.id) ? plain(shareOf(p.id).cents) : ''}"></label>`)}
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
  const s = settlement ?? { fromUser: me.id, toUser: people.find((p) => p.id !== me.id)?.id, amount: '', paidOn: today(), note: '' };
  const action = isEdit ? `/groups/${group.id}/settlements/${s.id}` : `/groups/${group.id}/settlements`;
  const opts = (sel) => people.map((p) => html`<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${p.id === me.id ? 'You' : p.name}</option>`);
  return html`<section class="card narrow">
    <a class="crumb" href="/groups/${group.id}">← ${group.name}</a>
    <h1>${isEdit ? 'Edit payment' : 'Record a payment'}</h1>
    <p class="muted small">Use this when someone pays someone back, in cash or by bank transfer.</p>
    ${errorBox(error)}
    <form method="post" action="${action}" class="stack">
      <div class="two">
        <label>Who paid <select name="from_user">${opts(s.fromUser)}</select></label>
        <label>Paid to <select name="to_user">${opts(s.toUser)}</select></label>
      </div>
      <div class="two">
        <label>Amount (S$) <input name="amount" value="${s.amount}" required inputmode="decimal" placeholder="0.00"></label>
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
        <label>New password <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
        <button>Change password</button>
      </form>
    </section>
  </div>
  <section class="card danger">
    <h2>Delete account</h2>
    ${groupCount > 0
      ? html`<p class="muted">You're in ${groupCount} group${groupCount === 1 ? '' : 's'}. Settle up and leave ${groupCount === 1 ? 'it' : 'them'} first, so nobody loses track of what they're owed.</p>`
      : html`<p class="muted">Frees up one of the 10 spots. This can't be undone.</p>
        <form method="post" action="/account/delete" data-confirm="Delete your account for good?" class="stack">
          <label>Confirm with your password <input type="password" name="password" required autocomplete="current-password"></label>
          <button class="danger">Delete my account</button></form>`}
  </section>`;
}

export function notFoundPage() {
  return html`<section class="card narrow"><h1>Not found</h1><p>That page doesn't exist, or you're not a member of that group.</p><p><a href="/">Back to dashboard</a></p></section>`;
}
