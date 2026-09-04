import tsParser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';

// ARCHITECTURE.md §4, encoded as lint rules.
//
// These are not style preferences. Each one names a failure that has no other
// detector: an engine that reads a clock stops being reproducible between the
// Worker and the browser preview; a `components/ui` primitive that fetches
// cannot be rendered in a test or on the print sheet; a <Link> under
// app/shell/** silently degrades every tab change to a full document load.
//
// TWO THINGS ABOUT FLAT CONFIG THAT SILENTLY BREAK RULES LIKE THESE, both of
// which cost a debugging session here:
//
//  1. Later config objects REPLACE a rule's options; they do not merge them.
//     Two blocks that each set `no-restricted-imports` for overlapping globs
//     means the second one's patterns are the only ones in force, and the
//     first block's rule disappears with no warning. So the shared patterns are
//     hoisted into constants below and every scope re-states the full set.
//  2. `no-restricted-imports` group globs use gitignore semantics, where a bare
//     `*` also matches './rng' and there is no way to subtract. That is why
//     lib/bracket/ uses an esquery selector on the literal source string
//     instead — see the block for it.
//
// Every rule below was verified to FIRE against a probe file before being
// committed. A pattern that matches nothing looks exactly like a clean
// codebase, which is worse than having no rule at all.

const WORKER_MESSAGE =
  'app/, components/ and lib/ never import from worker/ (ARCHITECTURE.md §4 rule 4). The only contract between the ' +
  'two halves is lib/types and HTTP. A worker import type-checks — both sides are TypeScript — and then ships ' +
  'workerd-only globals into a browser bundle, where it fails on a phone rather than in CI.';

const UI_MESSAGE =
  'components/ui/ never imports lib/api or components/data (ARCHITECTURE.md §4 rule 3). It takes props. ' +
  'components/data/ owns loading, caching, polling and the five states of IA.md §7.1; a feature component composes ' +
  'the two. A primitive that fetches cannot be rendered in a unit test, from a fixture, or on the print sheet.';

const SHELL_MESSAGE =
  "next/link, next/navigation and next/router are forbidden in shell code (ARCHITECTURE.md §4 rule 7). Under " +
  "output:'export' the App Router client router resolves a navigation by fetching an RSC payload that does not " +
  'exist for a Worker-rewritten URL like /t/<slug>/bracket/, so it falls back to a full document load — and <Link> ' +
  'prefetches on viewport entry, so a 20-card list fires 20 RSC requests that all miss. Use the hand-rolled ' +
  'history.pushState router in lib/router (IA.md §2.2.1), and a plain <a href> for any link into a rewritten URL.';

const BRACKET_MESSAGE =
  'lib/bracket/ imports NOTHING outside itself (ARCHITECTURE.md §4 rule 1): not app/, not worker/, not lib/types, ' +
  'not one npm package. A relative import of an engine sibling is the only permitted form. Every export is a pure ' +
  'function or a type — that is what makes the seeding preview in the browser and the bracket generated in the ' +
  'Worker provably the same computation. Inline what you need, or it does not belong in the engine.';

/** The browser half must not reach into workerd code. Applies to every scope below. */
const WORKER_PATTERN = { group: ['@/worker', '@/worker/**', '**/worker/**'], message: WORKER_MESSAGE };

const UI_PATTERN = {
  group: [
    '@/lib/api',
    '@/lib/api/**',
    '**/lib/api',
    '**/lib/api/**',
    '@/components/data',
    '@/components/data/**',
    '**/components/data',
    '**/components/data/**',
  ],
  message: UI_MESSAGE,
};

const ROUTER_PATHS = [
  { name: 'next/link', message: SHELL_MESSAGE },
  { name: 'next/navigation', message: SHELL_MESSAGE },
  { name: 'next/router', message: SHELL_MESSAGE },
  // The internal path is what an auto-import from an editor sometimes produces.
  { name: 'next/dist/client/link', message: SHELL_MESSAGE },
];

export default [
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', '.wrangler/**', 'coverage/**', 'next-env.d.ts'],
  },

  // ---------------------------------------------------------------------
  // Base: parse TypeScript + JSX everywhere, and the one rule that applies to
  // every file in the tree.
  // ---------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react },
    // Pinned rather than 'detect', which resolves package.json on every run and
    // warns when it cannot.
    settings: { react: { version: '19.0.0' } },
    rules: {
      // ARCHITECTURE.md §4 rule 5. Rich text arrives as a closed-allowlist JSON
      // AST (API.md §9) and is rendered through a switch into real React
      // elements, so no code path in the product turns user input into markup.
      // app/layout.tsx is allowlisted at the bottom of this file for the theme
      // bootstrap — the one inline script React 19 cannot emit any other way.
      'react/no-danger': 'error',
    },
  },

  // ---------------------------------------------------------------------
  // ARCHITECTURE.md §4 rule 4 — the browser half never imports the Worker half.
  // Broadest scope first; the narrower scopes below re-state WORKER_PATTERN.
  // ---------------------------------------------------------------------
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.ts'],
    ignores: ['lib/bracket/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [WORKER_PATTERN] }] },
  },

  // ---------------------------------------------------------------------
  // ARCHITECTURE.md §4 rule 1 — lib/bracket/ imports nothing but lib/bracket/*.
  //
  // no-restricted-imports cannot express this: a `group` broad enough to catch
  // `clsx` also catches './rng', which would break the engine's own 12-file
  // split, and the first thing anyone would do is disable the rule. An esquery
  // selector on the literal source string is exact — block every import that
  // does not begin with '.', plus every one that begins with '..'.
  // ---------------------------------------------------------------------
  {
    files: ['lib/bracket/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'ImportDeclaration[source.value=/^[^.]/]', message: BRACKET_MESSAGE },
        { selector: 'ImportDeclaration[source.value=/^\\.\\./]', message: BRACKET_MESSAGE },
        { selector: 'ExportNamedDeclaration[source.value=/^[^.]/]', message: BRACKET_MESSAGE },
        { selector: 'ExportNamedDeclaration[source.value=/^\\.\\./]', message: BRACKET_MESSAGE },
        { selector: 'ExportAllDeclaration[source.value=/^[^.]/]', message: BRACKET_MESSAGE },
        { selector: 'ExportAllDeclaration[source.value=/^\\.\\./]', message: BRACKET_MESSAGE },
        {
          selector: 'ImportExpression',
          message:
            'lib/bracket/ has no dynamic imports (ARCHITECTURE.md §4 rule 1) — a code-split engine is not a pure function of its arguments.',
        },
        { selector: 'CallExpression[callee.name="require"]', message: BRACKET_MESSAGE },
      ],
      // Determinism. Randomness is the seeded PRNG in lib/bracket/rng.ts and
      // time is an argument, because a bracket that differs between two
      // machines is not a bracket anybody can be shown a screenshot of.
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'lib/bracket/ is deterministic: use the seeded PRNG in rng.ts (ARCHITECTURE.md §4 rule 1).',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'lib/bracket/ takes time as an argument; it never reads a clock (ARCHITECTURE.md §4 rule 1).',
        },
        {
          property: 'localeCompare',
          message:
            'lib/bracket/ must not collate: ICU collation differs between workerd and a phone, so a standings order sorted with it is not reproducible (ARCHITECTURE.md §4 rule 1).',
        },
        {
          property: 'toLocaleString',
          message: 'lib/bracket/ never formats. Formatting is lib/format/ (ARCHITECTURE.md §4 rule 1).',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Intl', message: 'lib/bracket/ must not format or collate (ARCHITECTURE.md §4 rule 1).' },
        { name: 'fetch', message: 'lib/bracket/ performs no I/O (ARCHITECTURE.md §4 rule 1).' },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // ARCHITECTURE.md §4 rule 3 — components/ui/ never fetches.
  // ---------------------------------------------------------------------
  {
    files: ['components/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [WORKER_PATTERN, UI_PATTERN] }],
      // The same violation reached without an import — and the one that
      // actually happens, because it looks like a one-line shortcut.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'components/ui/ never fetches (ARCHITECTURE.md §4 rule 3). Take the data as a prop; components/data/ owns the request.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // ARCHITECTURE.md §4 rule 7 — no Next router anywhere in shell code.
  //
  // components/tournament/** and components/admin/** are included because they
  // are rendered by app/shell/tournament and app/shell/admin and nowhere else
  // (BUILD-PLAN.md W7/W9), so a <Link> in one of them fails identically to a
  // <Link> in the shell page itself. components/account/** is deliberately NOT
  // included: it is shared with the prerendered /me/ pages, where next/link is
  // the correct thing to use.
  // ---------------------------------------------------------------------
  {
    files: [
      'app/shell/**/*.{ts,tsx}',
      'components/tournament/**/*.{ts,tsx}',
      'components/admin/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ROUTER_PATHS,
          patterns: [
            WORKER_PATTERN,
            { group: ['next/link/**', 'next/navigation/**', 'next/router/**'], message: SHELL_MESSAGE },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // The single allowlisted dangerouslySetInnerHTML: the theme bootstrap in
  // app/layout.tsx (ARCHITECTURE.md §4 rule 5, DESIGN.md §2.1). The real bound
  // is mechanical and lives in CI, not here — scripts/csp-hashes.mjs asserts
  // the script's exact sha256 is in every page's hash list, and a CI grep fails
  // on any other occurrence in the tree. This override only stops the linter
  // flagging the one occurrence that is supposed to exist.
  // ---------------------------------------------------------------------
  {
    files: ['app/layout.tsx'],
    rules: { 'react/no-danger': 'off' },
  },

  // Build tooling runs in Node, where `fetch` and a bare `require` are
  // unremarkable, and it legitimately imports npm packages.
  {
    files: ['scripts/**/*.{mjs,js,ts}', '*.config.{ts,js,mjs}', 'eslint.config.mjs'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-syntax': 'off' },
  },
];
