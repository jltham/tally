// Pure money maths. All amounts are integer cents.

const MAX_CENTS = 100_000_000; // S$1,000,000.00

/** Parse a user-typed amount like "12", "12.5", "12.50", "1,200.00" into cents, or null if invalid. */
export function toCents(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim().replace(/,/g, '').replace(/^S?\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-SG');
  return `${sign}S$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Split total among userIds; leftover cents go to the lowest ids first so results are stable. */
export function splitEqual(totalCents, userIds) {
  if (userIds.length === 0) throw new Error('Need at least one person to split with');
  const ids = [...new Set(userIds)].sort((a, b) => a - b);
  const base = Math.floor(totalCents / ids.length);
  let leftover = totalCents - base * ids.length;
  return ids.map((userId) => ({ userId, cents: base + (leftover-- > 0 ? 1 : 0) }));
}

/**
 * Net balance per user. Positive = the group owes them; negative = they owe the group.
 * expenses: [{ paidBy, amountCents, shares: [{ userId, cents }] }]
 * settlements: [{ fromUser, toUser, amountCents }]  (fromUser paid toUser)
 */
export function computeBalances(expenses, settlements) {
  const bal = new Map();
  const add = (id, c) => bal.set(id, (bal.get(id) ?? 0) + c);
  for (const e of expenses) {
    add(e.paidBy, e.amountCents);
    for (const s of e.shares) add(s.userId, -s.cents);
  }
  for (const s of settlements) {
    add(s.fromUser, s.amountCents);
    add(s.toUser, -s.amountCents);
  }
  return bal;
}

/** Turn balances into a short list of payments that brings everyone to zero. */
export function simplifyDebts(balances) {
  const creditors = [];
  const debtors = [];
  for (const [userId, c] of balances) {
    if (c > 0) creditors.push({ userId, c });
    else if (c < 0) debtors.push({ userId, c: -c });
  }
  const byAmount = (a, b) => b.c - a.c || a.userId - b.userId;
  const payments = [];
  while (creditors.length && debtors.length) {
    creditors.sort(byAmount);
    debtors.sort(byAmount);
    const cr = creditors[0];
    const de = debtors[0];
    const amt = Math.min(cr.c, de.c);
    payments.push({ fromUser: de.userId, toUser: cr.userId, amountCents: amt });
    cr.c -= amt;
    de.c -= amt;
    if (cr.c === 0) creditors.shift();
    if (de.c === 0) debtors.shift();
  }
  return payments;
}

/** How much this expense moves `userId`'s balance: + they lent, - they borrowed, 0 not involved. */
export function effectOn(userId, expense) {
  const share = expense.shares.find((s) => s.userId === userId)?.cents ?? 0;
  const paid = expense.paidBy === userId ? expense.amountCents : 0;
  return paid - share;
}
