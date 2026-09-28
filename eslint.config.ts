import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { gatePlugin } from './scripts/eslint-plugin';

/**
 * The syntax every file refuses. Bun runs any file as code under an import
 * attribute naming a loader, such as `with { type: 'js' }` on a .txt import,
 * which no row reads as code. An import carries `type: 'json'` or no
 * attribute, and a dynamic import takes no options.
 */
const LOADER_ATTRIBUTES = [
  {
    selector: "ImportAttribute:not([key.name='type'][value.value='json']):not([key.value='type'][value.value='json'])",
    message: "Bun runs a file as code under a loader attribute. Import with `type: 'json'` or no attribute.",
  },
  {
    selector: 'ImportExpression[options]',
    message: 'Bun runs a file as code under a loader attribute. Import JSON with a static import.',
  },
];

/**
 * The syntax a test file also refuses. bun test counts a failing or failingIf
 * case as a pass and names it nowhere in its summary, so an inverted test
 * passes every row that counts tests. A test file reads neither name as a
 * member on any chain, such as `test.concurrent.failing`, nor takes either
 * apart in a destructuring. It takes no `test`, `it` or `describe` apart, and
 * reads none of them, or one step down their chain, by a computed key.
 */
const FAILING_CASES = [
  {
    selector: 'MemberExpression[property.name=/^failing(If)?$/]',
    message: 'bun test counts a failing case as a pass. Fix the code or the test instead.',
  },
  {
    selector:
      'ObjectPattern > Property[key.name=/^failing(If)?$/], ObjectPattern > Property[key.value=/^failing(If)?$/]',
    message: 'bun test counts a failing case as a pass. Fix the code or the test instead.',
  },
  {
    selector: 'VariableDeclarator[init.name=/^(test|it|describe)$/] > ObjectPattern',
    message: 'A test file reads test, it and describe by name, so no failing case hides in a destructuring.',
  },
  {
    selector:
      'MemberExpression[computed=true][object.name=/^(test|it|describe)$/], MemberExpression[computed=true][object.object.name=/^(test|it|describe)$/]',
    message: 'A test file reads test, it and describe by name, so no failing case hides behind a computed key.',
  },
];

/** Every name bun test finds a test file by. */
const TEST_FILES = ['**/*{.test,_test,.spec,_spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];

// typescript-eslint reads types through the JavaScript compiler API, which the native TypeScript compiler lacks,
// so the `typescript` package it resolves stays on the last major carrying that API, beside the `@typescript/native`
// alias the typecheck row runs.
export default defineConfig(
  // flat config reads no .gitignore, so every ignored directory a lint could
  // reach is named here, the worktrees Claude Code writes included.
  // Deviates from the handbook's kickstart: wrangler writes its bundles and dev
  // state under .wrangler, and generates worker-configuration.d.ts opening with
  // an unlimited eslint-disable, so both are ignored here too.
  globalIgnores([
    'node_modules/**',
    'coverage/**',
    'dist/**',
    '.claude/worktrees/**',
    '.wrangler/**',
    'worker-configuration.d.ts',
  ]),

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // An inline ESLint directive names each rule it turns off and gives its
  // reason after `--`. The recommended set refuses a disable that names no
  // rule or is never closed, and require-description refuses one with no
  // reason. The gate's visible-reason rule refuses a reason there or on a
  // TypeScript waiver comment that holds no letter or digit once
  // default-ignorable code points are removed. ESLint reports a directive
  // that silences nothing, and the lint row allows no warning. A comment that
  // configures ESLint, such as `/* eslint no-debugger: "off" */`, holds a rule
  // off for its whole file with no enable to close it, so no-use refuses every
  // directive but the disable and enable forms: a rule's setting and a global
  // live in this file alone.
  comments.recommended,
  {
    plugins: { gate: gatePlugin },
    rules: {
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-use': [
        'error',
        { allow: ['eslint-disable', 'eslint-enable', 'eslint-disable-line', 'eslint-disable-next-line'] },
      ],
      'gate/visible-reason': 'error',
    },
  },

  // A later block's no-restricted-syntax replaces an earlier one's whole, so
  // the test-file block names the loader selectors again.
  {
    rules: {
      'no-restricted-syntax': ['error', ...LOADER_ATTRIBUTES],
    },
  },
  {
    files: TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...LOADER_ATTRIBUTES, ...FAILING_CASES],
    },
  },

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['commitlint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Production and tooling code
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowDirectConstAssertionInArrowFunctions: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      // Conflicts with strict-boolean-expressions; explicit null/undefined
      // checks are preferred for clarity.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowNullableObject: true,
          allowNullableBoolean: true,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
    },
  },

  // Tests
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
    },
  },

  // commitlint.config.js sits outside every tsconfig project, and the typecheck
  // row checks eslint.config.ts; lint both without type information.
  // Deviates from the handbook's kickstart: vitest.config.mts, the Worker
  // tests' config, sits outside the root project too, and the typecheck row
  // checks it through tests/tsconfig.json, so it is linted the same way.
  {
    files: ['commitlint.config.js', 'eslint.config.ts', 'vitest.config.mts'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // commitlint.config.js is byte-identical in every repository and reads the
  // URL global Node and Bun both provide, so the global is declared here
  // rather than imported there.
  {
    files: ['commitlint.config.js'],
    languageOptions: {
      globals: { URL: 'readonly' },
    },
  },

  // Must stay last: disables rules that conflict with prettier formatting
  prettierConfig,
);
