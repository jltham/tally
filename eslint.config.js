// ESLint flat config. Each runtime gets only its own globals, so a Node API slipping into
// browser code (or the reverse) is caught by no-undef.
import js from '@eslint/js';
import globals from 'globals';

export default [
  // .worktrees/ holds git worktrees: other branches checked out inside the repo, not this project's code.
  { ignores: ['node_modules/', 'data/', 'docs/', '.worktrees/'] },
  js.configs.recommended,
  {
    rules: {
      // Express error handlers need four parameters even when the last isn't used: `_next`.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Server, scripts and tests run in Node.
  {
    files: ['**/*.js'],
    ignores: ['public/**', 'lib/ledger.js'],
    languageOptions: { globals: globals.node },
  },
  // The progressive-enhancement script runs in the browser.
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  // lib/ledger.js runs in BOTH Node and the browser (served at /ledger.js). It gets no
  // environment globals on purpose, so using Buffer, process, window or document fails lint.
  // (Globals from different blocks merge, which is why the Node block above excludes it.)
];
