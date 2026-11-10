import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, formatCents, toAmountText, splitEqual, computeBalances, simplifyDebts, effectOn, netWithEachPerson, isSettled } from '../lib/ledger.js';
import { isIsoDate } from '../lib/dates.js';

test('toCents parses typical inputs', () => {
  assert.equal(toCents('12'), 1200);
  assert.equal(toCents('12.5'), 1250);
  assert.equal(toCents(' 12.05 '), 1205);
  assert.equal(toCents('1,200.00'), 120000);
  assert.equal(toCents('$3'), 300);
  assert.equal(toCents('0'), 0);
});

test('toCents rejects junk, negatives, too many decimals, huge amounts', () => {
  for (const bad of ['', 'abc', '-5', '1.234', '1e3', '.5', '99999999', undefined]) {
    assert.equal(toCents(bad), null, `expected null for ${bad}`);
  }
});

test('formatCents', () => {
  assert.equal(formatCents(123456), 'S$1,234.56');
  assert.equal(formatCents(5), 'S$0.05');
  assert.equal(formatCents(-250), '-S$2.50');
});

test('splitEqual gives leftover cents to lowest ids and always sums to total', () => {
  assert.deepEqual(splitEqual(1000, [3, 1, 2]), [
    { userId: 1, cents: 334 },
    { userId: 2, cents: 333 },
    { userId: 3, cents: 333 },
  ]);
  for (let total = 1; total < 500; total += 7) {
    for (let n = 1; n <= 10; n++) {
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const sum = splitEqual(total, ids).reduce((a, s) => a + s.cents, 0);
      assert.equal(sum, total);
    }
  }
  assert.throws(() => splitEqual(100, []));
});

test('computeBalances nets expenses and settlements, sums to zero', () => {
  const expenses = [
    { paidBy: 1, amountCents: 9000, shares: splitEqual(9000, [1, 2, 3]) },
    { paidBy: 2, amountCents: 3000, shares: [{ userId: 1, cents: 1000 }, { userId: 3, cents: 2000 }] },
  ];
  const settlements = [{ fromUser: 3, toUser: 1, amountCents: 1000 }];
  const bal = computeBalances(expenses, settlements);
  assert.equal(bal.get(1), 9000 - 3000 - 1000 - 1000); // 4000
  assert.equal(bal.get(2), 3000 - 3000); // 0
  assert.equal(bal.get(3), -3000 - 2000 + 1000); // -4000
  assert.equal([...bal.values()].reduce((a, b) => a + b, 0), 0);
});

test('simplifyDebts settles everyone with at most n-1 payments', () => {
  const bal = new Map([[1, 5000], [2, -2000], [3, -2000], [4, -1000], [5, 0]]);
  const pays = simplifyDebts(bal);
  assert.ok(pays.length <= 3);
  const after = new Map(bal);
  for (const p of pays) {
    after.set(p.fromUser, after.get(p.fromUser) + p.amountCents);
    after.set(p.toUser, after.get(p.toUser) - p.amountCents);
  }
  for (const v of after.values()) assert.equal(v, 0);
  assert.deepEqual(simplifyDebts(new Map([[1, 0]])), []);
});

const settles = (bal, pays) => {
  const after = new Map(bal);
  for (const p of pays) {
    after.set(p.fromUser, after.get(p.fromUser) + p.amountCents);
    after.set(p.toUser, after.get(p.toUser) - p.amountCents);
  }
  return [...after.values()].every((v) => v === 0);
};

test('simplifyDebts finds the true minimum where largest-first matching does not', () => {
  // +4 is cleared by -2 and -2; +11 by -3 and -8: 4 payments, not 5.
  const bal = new Map([[1, -2], [2, -3], [3, 4], [4, -2], [5, -8], [6, 11]]);
  const pays = simplifyDebts(bal);
  assert.ok(settles(bal, pays));
  assert.equal(pays.length, 4);
});

test('simplifyDebts uses n - (number of zero-sum groups) payments on random balances', () => {
  // Brute-force the minimum: n - max number of disjoint zero-sum subsets.
  const minPayments = (vals) => {
    const n = vals.length;
    const best = new Array(1 << n).fill(0);
    for (let m = 1; m < 1 << n; m++) {
      let sum = 0;
      for (let i = 0; i < n; i++) if (m & (1 << i)) { sum += vals[i]; best[m] = Math.max(best[m], best[m ^ (1 << i)]); }
      if (sum === 0) best[m] += 1;
    }
    return n - best[(1 << n) - 1];
  };
  let seed = 7;
  const rand = (k) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % k;
  for (let t = 0; t < 300; t++) {
    const n = 2 + rand(9);
    const vals = Array.from({ length: n - 1 }, () => (rand(13) - 6) || 1);
    vals.push(-vals.reduce((a, b) => a + b, 0));
    const nonzero = vals.filter((v) => v !== 0);
    const bal = new Map(vals.map((v, i) => [i + 1, v]));
    const pays = simplifyDebts(bal);
    assert.ok(settles(bal, pays));
    assert.equal(pays.length, minPayments(nonzero), `balances ${vals}`);
  }
});

test('splitEqual gives the odd cent to the payer first when they are in the split', () => {
  assert.deepEqual(splitEqual(1000, [1, 2, 3], 3), [
    { userId: 1, cents: 333 },
    { userId: 2, cents: 333 },
    { userId: 3, cents: 334 },
  ]);
  // Two odd cents: payer, then lowest id among the rest.
  assert.deepEqual(splitEqual(1001, [1, 2, 3], 2).map((s) => s.cents), [334, 334, 333]);
  // Payer not in the split: falls back to lowest ids.
  assert.deepEqual(splitEqual(1000, [1, 2, 3], 9).map((s) => s.cents), [334, 333, 333]);
});

test('effectOn', () => {
  const e = { paidBy: 1, amountCents: 900, shares: splitEqual(900, [1, 2, 3]) };
  assert.equal(effectOn(1, e), 600);
  assert.equal(effectOn(2, e), -300);
  assert.equal(effectOn(9, e), 0);
});

test('netWithEachPerson combines payments across groups and drops people who net to zero', () => {
  const payments = [
    { fromUser: 2, toUser: 1, amountCents: 500 }, // group A: 2 pays me
    { fromUser: 1, toUser: 2, amountCents: 200 }, // group B: I pay 2
    { fromUser: 1, toUser: 3, amountCents: 300 },
    { fromUser: 3, toUser: 1, amountCents: 300 },
    { fromUser: 4, toUser: 5, amountCents: 999 }, // doesn't involve me
  ];
  assert.deepEqual([...netWithEachPerson(1, payments)], [[2, 300]]);
});

test('toAmountText and isIsoDate', () => {
  assert.equal(toAmountText(1250), '12.50');
  assert.equal(toAmountText(5), '0.05');
  assert.ok(isIsoDate('2026-02-28'));
  for (const bad of ['2026-02-30', '2026-2-1', '', 'tomorrow']) assert.ok(!isIsoDate(bad), bad);
});

test('isSettled', () => {
  assert.ok(isSettled(new Map()));
  assert.ok(isSettled(new Map([[1, 0], [2, 0]])));
  assert.ok(!isSettled(new Map([[1, 5], [2, -5]])));
});
