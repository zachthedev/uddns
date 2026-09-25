/**
 * The repository's own list the gate reads: where its TypeScript project
 * configs sit.
 *
 * @remarks
 * scripts/run.ts, scripts/tools.ts, scripts/startup.ts, scripts/rows.ts,
 * scripts/github.ts, scripts/shellcheck.ts, scripts/eslint-plugin.ts and
 * scripts/stand-ins.ts are the same in every repository of the set, and
 * startup.ts reads this module for the rest. No config's text is held here:
 * code-owner review is the control on a change to one. The preflight loads
 * this module before any check, so it imports nothing.
 */

/**
 * Every `tsconfig.json` and `jsconfig.json` the repository keeps beside
 * scripts/tsconfig.json, by path. typescript-eslint reads the nearest one for
 * each file it lints, so any other project config in the tree is refused. The
 * root one reads the Worker's source and its generated types, and the one
 * under tests/ reads the tests, eslint.config.ts and vitest.config.mts, so the
 * typecheck row checks each.
 */
export const EXPECTED_PROJECT_CONFIGS: readonly string[] = ['tsconfig.json', 'tests/tsconfig.json'];
