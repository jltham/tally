import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, formatCents, splitEqual, computeBalances, simplifyDebts, effectOn } from '../lib/ledger.js';

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

test('effectOn', () => {
  const e = { paidBy: 1, amountCents: 900, shares: splitEqual(900, [1, 2, 3]) };
  assert.equal(effectOn(1, e), 600);
  assert.equal(effectOn(2, e), -300);
  assert.equal(effectOn(9, e), 0);
});
