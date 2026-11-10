// /ledger.js must load wherever Tally is installed, including under a hidden folder such as
// ~/.local/share/tally or a git worktree in .worktrees/. Sending it by absolute path made the
// file server refuse it there (it treats any dot-folder in the path as a hidden file): 500.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outer = mkdtempSync(join(tmpdir(), 'tally-install-'));
after(() => rmSync(outer, { recursive: true, force: true }));

test('the browser’s copy of the money maths loads from an install under a hidden folder', async () => {
  const appDir = join(outer, '.hidden', 'tally');
  for (const part of ['server.js', 'lib', 'public', 'package.json']) cpSync(join(ROOT, part), join(appDir, part), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(appDir, 'node_modules'));

  const { createApp } = await import(pathToFileURL(join(appDir, 'server.js')).href);
  const { openDb } = await import(pathToFileURL(join(appDir, 'lib', 'db.js')).href);
  const server = createApp(openDb(':memory:')).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://localhost:${server.address().port}`;
    const ledger = await fetch(`${base}/ledger.js`);
    assert.equal(ledger.status, 200);
    assert.match(ledger.headers.get('content-type'), /javascript/);
    assert.match(await ledger.text(), /export function toCents/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
  } finally {
    server.close();
  }
});
