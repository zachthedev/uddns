/**
 * What the gate expects of the files each repository writes for itself: its
 * TypeScript project configs, the zizmor config, the patterns its
 * `.prettierignore` adds to the shared ones, and `eslint.config.ts`.
 *
 * @remarks
 * scripts/run.ts, scripts/tools.ts and scripts/startup.ts are the same in
 * every repository of the set, and startup.ts reads this module for the rest.
 * A change to one of these files changes the matching value here in the same
 * commit, which a reviewer reads as a gate change. The preflight loads this
 * module before any check, so it imports nothing.
 */

/**
 * Every `tsconfig.json` and `jsconfig.json` the repository keeps beside
 * scripts/tsconfig.json, by path, with what each holds, compared as parsed
 * JSON. Their files, strictness and `noCheck` decide what the typecheck and
 * lint rows check, so any other project config in the tree is refused. None
 * carries `paths` or `baseUrl`, which startup.ts refuses along any `extends`
 * chain.
 */
export const EXPECTED_PROJECT_CONFIGS: Readonly<Record<string, unknown>> = {
  'tsconfig.json': {
    compilerOptions: {
      target: 'es2024',
      lib: ['es2024'],
      module: 'es2022',
      moduleResolution: 'bundler',
      noEmit: true,
      isolatedModules: true,

      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,

      skipLibCheck: true,
    },
    include: ['worker-configuration.d.ts', 'src/**/*.ts'],
    exclude: ['node_modules', 'dist', '.wrangler'],
  },
  'tests/tsconfig.json': {
    extends: '../tsconfig.json',
    compilerOptions: {
      allowJs: true,
      types: ['@cloudflare/vitest-plugin/types', 'node'],
    },
    include: [
      './**/*.ts',
      '../src/**/*.ts',
      '../worker-configuration.d.ts',
      '../eslint.config.ts',
      '../vitest.config.mts',
    ],
    exclude: ['node_modules'],
  },
};

/**
 * What `.github/zizmor.yml` holds, compared as parsed YAML. Each waiver is
 * one entry scoped to the file, line and column of the finding it waives.
 */
export const EXPECTED_ZIZMOR_CONFIG = {
  rules: {
    'unpinned-uses': { config: { policies: { '*': 'hash-pin' } } },
    'secrets-inherit': { ignore: ['cd.yml:32:11', 'deps.yml:30:11'] },
  },
} as const;

/**
 * The patterns `.prettierignore` holds beside the shared ones startup.ts
 * lists, each once: the types file `wrangler types` writes, and the state
 * directory wrangler fills locally, which `bun run format` would walk into.
 */
export const OWN_PRETTIERIGNORE_PATTERNS: readonly string[] = ['/worker-configuration.d.ts', '/.wrangler/'];

/**
 * What `eslint.config.ts` holds, byte for byte. ESLint runs the file as a
 * module, and its ignores and rules decide what the lint row checks.
 */
export const EXPECTED_ESLINT_CONFIG = `import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    'node_modules/**',
    '.wrangler/**',
    'coverage/**',
    'dist/**',
    '.claude/worktrees/**',
    'worker-configuration.d.ts',
  ]),

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['commitlint.config.js', 'eslint.config.ts', 'vitest.config.mts'],
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

  // Relaxed rules for tests (mocking needs escape hatches)
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
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

  // Config files at the repo root sit outside the tsconfig projects; lint
  // them without type information.
  {
    files: ['commitlint.config.js', 'eslint.config.ts', 'vitest.config.mts'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // commitlint.config.js is shared byte for byte across repositories and uses
  // URL as the global Node provides, so the global is declared here rather
  // than imported there.
  {
    files: ['commitlint.config.js'],
    languageOptions: {
      globals: { URL: 'readonly' },
    },
  },

  // Must stay last: disables rules that conflict with prettier formatting
  prettierConfig,
);
`;
