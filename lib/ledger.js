// Pure money maths. All amounts are integer cents.
// No imports and no Node APIs: the browser loads this same file (see public/app.js).

export const CURRENCY = 'S$';
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
  return `${sign}${CURRENCY}${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Cents as the plain text a form field holds, e.g. 1250 -> "12.50". */
export function toAmountText(cents) {
  return (cents / 100).toFixed(2);
}

/**
 * Split total among userIds. When it doesn't divide evenly, the payer covers the first odd cent
 * (if they're in the split), then the lowest ids. Shares come back sorted by userId.
 */
export function splitEqual(totalCents, userIds, payerId) {
  if (userIds.length === 0) throw new Error('Need at least one person to split with');
  const ids = [...new Set(userIds)].sort((a, b) => a - b);
  const queue = ids.includes(payerId) ? [payerId, ...ids.filter((id) => id !== payerId)] : ids;
  const base = Math.floor(totalCents / ids.length);
  const getsExtra = new Set(queue.slice(0, totalCents - base * ids.length));
  return ids.map((userId) => ({ userId, cents: base + (getsExtra.has(userId) ? 1 : 0) }));
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

/**
 * Turn balances into the fewest payments that bring everyone to zero.
 *
 * The minimum is (people with a nonzero balance) − (the most disjoint groups whose balances
 * sum to zero), because each such group can settle internally with size−1 payments.
 * Finding those groups is exponential, but a group has at most 10 people (1,024 subsets).
 */
export function simplifyDebts(balances) {
  const people = [...balances]
    .filter(([, cents]) => cents !== 0)
    .map(([userId, cents]) => ({ userId, cents }))
    .sort((a, b) => a.userId - b.userId);
  const groups = people.length <= 16 ? zeroSumGroups(people) : [people];
  return groups.flatMap(settleWithinGroup);
}

/** Partition people into as many zero-sum groups as possible (dynamic programming over subsets). */
function zeroSumGroups(people) {
  const n = people.length;
  const full = (1 << n) - 1;
  const sum = new Array(full + 1).fill(0);
  const most = new Array(full + 1).fill(0); // most zero-sum groups that `mask` can be split into
  for (let mask = 1; mask <= full; mask++) {
    const lowBit = mask & -mask;
    sum[mask] = sum[mask ^ lowBit] + people[31 - Math.clz32(lowBit)].cents;
    let bestWithout = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) bestWithout = Math.max(bestWithout, most[mask ^ (1 << i)]);
    most[mask] = bestWithout + (sum[mask] === 0 ? 1 : 0);
  }
  // Walk back from the full set, removing one person at a time along an optimal path.
  // Every zero-sum mask on the path closes a group.
  const groups = [];
  let current = [];
  let mask = full;
  while (mask) {
    const gain = sum[mask] === 0 ? 1 : 0;
    let i = 0;
    while (!(mask & (1 << i)) || most[mask ^ (1 << i)] + gain !== most[mask]) i++;
    current.push(people[i]);
    mask ^= 1 << i;
    if (sum[mask] === 0) {
      groups.push(current);
      current = [];
    }
  }
  return groups;
}

/** Settle one zero-sum group: biggest debtor pays biggest creditor until everyone is at zero. */
function settleWithinGroup(group) {
  const creditors = group.filter((p) => p.cents > 0).map((p) => ({ ...p }));
  const debtors = group.filter((p) => p.cents < 0).map((p) => ({ userId: p.userId, cents: -p.cents }));
  const byAmount = (a, b) => b.cents - a.cents || a.userId - b.userId;
  const payments = [];
  while (creditors.length && debtors.length) {
    creditors.sort(byAmount);
    debtors.sort(byAmount);
    const [creditor] = creditors;
    const [debtor] = debtors;
    const amountCents = Math.min(creditor.cents, debtor.cents);
    payments.push({ fromUser: debtor.userId, toUser: creditor.userId, amountCents });
    creditor.cents -= amountCents;
    debtor.cents -= amountCents;
    if (creditor.cents === 0) creditors.shift();
    if (debtor.cents === 0) debtors.shift();
  }
  return payments;
}

/**
 * Where `userId` stands with each other person, given suggested payments from any number of groups.
 * Returns Map otherUserId -> cents (+ they owe userId, - userId owes them), without zero entries.
 */
export function netWithEachPerson(userId, payments) {
  const net = new Map();
  const add = (id, cents) => net.set(id, (net.get(id) ?? 0) + cents);
  for (const p of payments) {
    if (p.toUser === userId) add(p.fromUser, p.amountCents);
    if (p.fromUser === userId) add(p.toUser, -p.amountCents);
  }
  for (const [id, cents] of net) if (cents === 0) net.delete(id);
  return net;
}

/** How much this expense moves `userId`'s balance: + they lent, - they borrowed, 0 not involved. */
export function effectOn(userId, expense) {
  const share = expense.shares.find((s) => s.userId === userId)?.cents ?? 0;
  const paid = expense.paidBy === userId ? expense.amountCents : 0;
  return paid - share;
}
