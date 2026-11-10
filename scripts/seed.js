// Creates 4 demo users and a sample group. Safe to run once on an empty database.
// Each account gets its own random password, printed once. Set SEED_PASSWORD to use one
// known password for every account instead (handy for demos; don't use it on a shared network).
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.js';
import { createStore } from '../lib/store.js';
import { hashPassword } from '../lib/auth.js';
import { splitEqual } from '../lib/ledger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const db = openDb(process.env.TALLY_DB ?? join(HERE, '..', 'data', 'tally.db'));
const store = createStore(db);

if (store.users.count() > 0) {
  console.log('Database already has users; not seeding. Delete data/tally.db to start over.');
  process.exit(0);
}

const DEMO_USERS = [
  ['Alice Tan', 'alice@example.com'],
  ['Ben Lim', 'ben@example.com'],
  ['Chloe Ng', 'chloe@example.com'],
  ['Dev Rao', 'dev@example.com'],
];
const logins = DEMO_USERS.map(([name, email]) => ({
  name, email, password: process.env.SEED_PASSWORD || randomBytes(12).toString('base64url'),
}));
const [alice, ben, chloe, dev] = logins.map(({ name, email, password }) => store.users.create(name, email, hashPassword(password)));

const flat = store.groups.create('Flat 12B', alice, [ben, chloe]);
const trip = store.groups.create('Penang weekend', ben, [alice, dev]);

const add = (groupId, description, dollars, paidBy, spentOn, people) => {
  const amountCents = Math.round(dollars * 100);
  store.expenses.save(
    { groupId, description, amountCents, paidBy, spentOn, splitType: 'equal', shares: splitEqual(amountCents, people, paidBy) },
    paidBy,
  );
};
add(flat, 'Electricity (Oct)', 142.6, alice, '2026-11-01', [alice, ben, chloe]);
add(flat, 'Groceries', 87.35, ben, '2026-11-04', [alice, ben, chloe]);
add(flat, 'Wi-Fi', 49.9, chloe, '2026-11-06', [alice, ben, chloe]);
store.expenses.save(
  { groupId: flat, description: 'Cleaning supplies', amountCents: 3000, paidBy: alice, spentOn: '2026-11-08', splitType: 'exact',
    shares: [{ userId: alice, cents: 1000 }, { userId: ben, cents: 2000 }] },
  alice,
);
store.settlements.save({ groupId: flat, fromUser: chloe, toUser: alice, amountCents: 2000, paidOn: '2026-11-09', note: 'PayNow' }, chloe);

add(trip, 'Hotel', 360, ben, '2026-10-24', [alice, ben, dev]);
add(trip, 'Char kway teow & drinks', 54, dev, '2026-10-25', [alice, ben, dev]);

console.log('Seeded 4 users and 2 groups. Logins (shown only now):');
for (const { email, password } of logins) console.log(`  ${email.padEnd(20)} ${password}`);
