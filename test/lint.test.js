// Issue #14: two rules the code relies on were only written in comments. Lint enforces them, and
// these tests make sure the lint config keeps enforcing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: ROOT });
const problemsIn = async (code, file) =>
  (await eslint.lintText(code, { filePath: join(ROOT, file) }))[0].messages.map((m) => `${m.ruleId}: ${m.message}`);

test('lib/ledger.js stays browser-safe: Node APIs fail lint there', async () => {
  for (const name of ['Buffer', 'process', 'require']) {
    const problems = await problemsIn(`export const x = ${name};\n`, 'lib/ledger.js');
    assert.ok(problems.some((p) => p.startsWith('no-undef') && p.includes(name)), `${name}: ${problems}`);
  }
});

test('lib/ledger.js stays Node-safe: browser APIs fail lint there too', async () => {
  const problems = await problemsIn('export const x = document.title;\n', 'lib/ledger.js');
  assert.ok(problems.some((p) => p.startsWith('no-undef')), String(problems));
});

test('each runtime still gets its own globals', async () => {
  assert.deepEqual(await problemsIn('export const x = process.env.PORT;\n', 'lib/forms.js'), []);
  assert.deepEqual(await problemsIn('export const x = document.title;\n', 'public/app.js'), []);
});

test('an Express error handler can keep its unused fourth parameter', async () => {
  const code = 'export const handler = (err, req, res, _next) => res.status(500).send(String(err) + req.path);\n';
  assert.deepEqual(await problemsIn(code, 'server.js'), []);
});

test('the whole project lints clean', async () => {
  const results = await eslint.lintFiles(['.']);
  const errors = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId} ${m.message}`));
  assert.deepEqual(errors, []);
});
