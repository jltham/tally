// Issue #7: Tally is meant for one laptop. Listen on loopback by default, slow down password
// guessing, and don't ship a shared demo password.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenAddress } from '../server.js';
import { openDb } from '../lib/db.js';
import { verifyPassword } from '../lib/auth.js';
import { LOGIN_LIMITS } from '../lib/limits.js';
import { startApp } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the server listens on this machine only, unless HOST says otherwise', () => {
  assert.deepEqual(listenAddress({}), { host: '127.0.0.1', port: 3000 });
  assert.deepEqual(listenAddress({ PORT: '4000' }), { host: '127.0.0.1', port: 4000 });
  assert.deepEqual(listenAddress({ HOST: '0.0.0.0', PORT: '3000' }), { host: '0.0.0.0', port: 3000 });
});

let app;
before(async () => {
  app = await startApp();
  await app.client().signup('Kim', 'kim@x.com');
  await app.client().signup('Lee', 'lee@x.com');
});
after(() => app.close());

const failLogins = async (email, times) => {
  for (let i = 0; i < times; i++) {
    const r = await app.client().login(email, 'wrong-password');
    assert.equal(r.status, 401, `attempt ${i + 1} should be a normal failure`);
  }
};

test(`after ${LOGIN_LIMITS.perEmail} wrong passwords, that email is locked for a while (even with the right one)`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T10:00:00Z') });
  await failLogins('kim@x.com', LOGIN_LIMITS.perEmail);
  const blocked = await app.client().login('kim@x.com');
  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Too many failed attempts/);

  // Another account from the same machine is unaffected.
  assert.equal((await app.client().login('lee@x.com')).status, 302);

  // Once the window has passed, the right password works again.
  t.mock.timers.tick(LOGIN_LIMITS.windowMs + 1);
  assert.equal((await app.client().login('kim@x.com')).status, 302);
});

test('a successful login resets that email’s count', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-11T10:00:00Z') });
  await failLogins('lee@x.com', LOGIN_LIMITS.perEmail - 1);
  assert.equal((await app.client().login('lee@x.com')).status, 302);
  await failLogins('lee@x.com', LOGIN_LIMITS.perEmail - 1);
  assert.equal((await app.client().login('lee@x.com')).status, 302);
});

test(`after ${LOGIN_LIMITS.perAddress} failures from one address, any further attempt from it waits`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-12T10:00:00Z') });
  for (let i = 0; i < LOGIN_LIMITS.perAddress; i++) {
    await app.client().login(`nobody${i}@x.com`, 'guess');
  }
  assert.equal((await app.client().login('lee@x.com')).status, 429);
  t.mock.timers.tick(LOGIN_LIMITS.windowMs + 1);
  assert.equal((await app.client().login('lee@x.com')).status, 302);
});

test('the seed script gives each demo account its own random password, and prints it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-seed-'));
  try {
    const dbFile = join(dir, 'seed.db');
    const out = execFileSync('node', ['scripts/seed.js'], { cwd: ROOT, env: { ...process.env, TALLY_DB: dbFile, SEED_PASSWORD: '' } }).toString();
    assert.ok(!out.includes('password123'));
    const logins = [...out.matchAll(/(\S+@example\.com)\s+(\S+)/g)].map(([, email, password]) => ({ email, password }));
    assert.equal(logins.length, 4);
    assert.equal(new Set(logins.map((l) => l.password)).size, 4, 'passwords are all different');
    const db = openDb(dbFile);
    for (const { email, password } of logins) {
      assert.ok(password.length >= 12);
      assert.ok(verifyPassword(password, db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email).password_hash), email);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SEED_PASSWORD sets one known password, for demos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-seed-'));
  try {
    const dbFile = join(dir, 'seed.db');
    execFileSync('node', ['scripts/seed.js'], { cwd: ROOT, env: { ...process.env, TALLY_DB: dbFile, SEED_PASSWORD: 'demo-pass-123' } });
    const db = openDb(dbFile);
    assert.ok(verifyPassword('demo-pass-123', db.prepare("SELECT password_hash FROM users WHERE email = 'alice@example.com'").get().password_hash));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
