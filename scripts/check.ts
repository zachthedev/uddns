/**
 * The gate: every check a contributor can run locally, in one command.
 *
 * @remarks
 * `bun run check` runs the rows in order and stops at the first failure.
 * `bun run check:quick` runs the same rows without the test row, the form the
 * push hook runs. `bun run check:rows` prints the rows and runs nothing, which
 * is the list CONTRIBUTING.md points at. CI's gate job runs this file on three
 * platforms, so a green run here is a green run there.
 *
 * Before any row, the gate refuses to run beside a tracked env file Bun loads
 * or a tracked path under node_modules. CI and the push hook start this file
 * as `bun scripts/check.ts`, not through `bun run`, because the script runner
 * puts the checkout's node_modules/.bin ahead of PATH, where a committed bun
 * would run in place of the gate. scripts/tools.ts imports zod from
 * node_modules, so it loads only after that refusal.
 *
 * Every package runs from its path under node_modules, in the Bun running
 * this file. `bun run` hands a package whose bin starts `#!/usr/bin/env node`
 * to the first node on PATH, so no row goes through it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { styleText } from 'node:util';
import { githubToken } from './github';
import { describe, run, trackedFindings } from './run';
import type * as Tools from './tools';

/** The deadline for one script, linter or formatter pass over the tree. */
const TOOL_TIMEOUT_MS = 300_000;

/** The Bun running the gate, so every row runs the one `packageManager` pins. */
const BUN = process.execPath;

/**
 * The checkout's node_modules as an absolute path. The gate runs from the
 * root. Bun runs a package.json script named like a relative entry that is
 * missing, and fails with "Module not found" on a missing absolute one.
 */
const PACKAGES = join(process.cwd(), 'node_modules');

/** A row of the gate: its name, what it checks, and the check itself. */
interface Row {
  readonly name: string;
  readonly checks: string;
  /** Runs the check. A string it returns prints after the row's time. */
  readonly check: (quick: boolean) => string | undefined | Promise<string | undefined>;
  /** True for the rows `check:quick` leaves out. */
  readonly slow?: true;
}

/** scripts/tools.ts, loaded on first use, after the gate refused a tracked node_modules path. */
async function tools(): Promise<typeof Tools> {
  return import('./tools');
}

/** The binary paths the `tools` row resolves, read by the rows after it. */
const binaries = new Map<string, string>();

/** The path the `tools` row resolved for `key`. */
function binary(key: string): string {
  const path = binaries.get(key);
  if (path === undefined) {
    throw new Error(`the tools row did not resolve ${key}, so this row cannot run`);
  }
  return path;
}

/** Throws with the process's output when it did not exit 0. */
function expectClean(
  label: string,
  cmd: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): void {
  const finished = run(cmd, TOOL_TIMEOUT_MS, env);
  if (finished.exitCode !== 0) {
    throw new Error(`${label} ${describe(finished)}`);
  }
}

/**
 * NO_PROXY for a package that talks to workerd on this machine: the gate's
 * own list, in either spelling, and the loopback names.
 *
 * @remarks
 * Bun sends a request to localhost through HTTP_PROXY unless NO_PROXY names
 * it, where Node's clients do not. Behind a proxy, wrangler's type generation
 * and vitest's workers pool then cannot reach the workerd they start.
 */
function loopbackUnproxied(): Readonly<Record<string, string>> {
  const own = [process.env['NO_PROXY'], process.env['no_proxy']].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return { NO_PROXY: [...own, 'localhost', '127.0.0.1', '::1'].join(',') };
}

/** A row that runs one package's command from its path under node_modules. */
function packaged(label: string, entry: string, ...args: string[]): () => undefined {
  return () => {
    expectClean(label, [BUN, join(PACKAGES, entry), ...args]);
  };
}

/* ///// scripts:test ///// */

function scriptsTest(): undefined {
  // bun test, because the gate's own tests call Bun's APIs. The path keeps it
  // off tests/, which vitest runs. The output streams through, so a failure's
  // report lands in the log.
  const finished = run([BUN, 'test', './scripts/'], TOOL_TIMEOUT_MS, {}, { show: true });
  if (finished.exitCode !== 0) {
    throw new Error(`bun test ./scripts/ ${describe(finished)}. The report is above`);
  }
}

/* ///// tools ///// */

async function toolsRow(): Promise<undefined> {
  const { install, lockfileFindings, resolve } = await tools();
  const found = await lockfileFindings();
  if (found.length > 0) {
    throw new Error(found.join('\n'));
  }
  install();
  for (const [key, path] of await resolve()) {
    binaries.set(key, path);
  }
}

/* ///// actionlint ///// */

// A workflow whose only finding belongs to ShellCheck. actionlint reads it
// clean on its own and reports SC2086 over the unquoted expansion once
// ShellCheck runs. actionlint exits 0 with ShellCheck absent, and no flag
// changes that, so a clean run over the tree carries weight only after this
// finding came back.
const SHELLCHECK_CANARY = `name: canary
on: push
jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - run: echo $GITHUB_REF
`;
const SHELLCHECK_FINDING = 'SC2086';

async function actionlint(): Promise<undefined> {
  const lint = binary('actionlint');
  const shellcheck = binary('shellcheck');
  // -pyflakes= because no Windows package manager ships pyflakes, and
  // actionlint skips that pass without a word when it is missing.
  const analyzers = [`-shellcheck=${shellcheck}`, '-pyflakes='];

  const dir = await mkdtemp(join(tmpdir(), 'actionlint-canary-'));
  try {
    const canary = join(dir, 'canary.yml');
    await Bun.write(canary, SHELLCHECK_CANARY);
    const finished = run([lint, ...analyzers, canary], TOOL_TIMEOUT_MS);
    if (!finished.stdout.includes(SHELLCHECK_FINDING)) {
      throw new Error(
        `actionlint found no ${SHELLCHECK_FINDING} in a script that carries one, so ShellCheck never ran. It ${describe(finished)}. Check that ${shellcheck} starts`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expectClean('actionlint', [lint, ...analyzers]);
}

/* ///// zizmor ///// */

function zizmor(quick: boolean): string {
  // --strict-collection fails on a file zizmor cannot parse. Without it the
  // file is dropped with a warning and the run reports no findings for a
  // workflow it never read. The config is named so ZIZMOR_CONFIG in the
  // environment cannot swap it. The full gate runs online when gh has a
  // token, because some audits read the pinned actions' repositories.
  // check:quick runs offline, so the push hook needs no network and no token,
  // and ZIZMOR_OFFLINE forces offline for the full gate. With no token the
  // run passes --offline, because zizmor left to find none drops to offline
  // mode with a warning the gate never prints. The input is .github, which
  // holds the workflows and any composite action under .github/actions.
  // --collect=all turns zizmor's ignore handling off, so no .gitignore,
  // exclude file or global excludes file can hide one of them, and the input
  // never reaches node_modules or .claude/worktrees.
  const token = quick || process.env['ZIZMOR_OFFLINE'] !== undefined ? undefined : githubToken('gh');
  const online = token !== undefined;
  const mode = online ? [] : ['--offline'];
  const env: Readonly<Record<string, string>> = online ? { GH_TOKEN: token } : {};
  expectClean(
    `zizmor (${online ? 'online' : 'offline'})`,
    [
      binary('zizmor'),
      '--no-progress',
      '--strict-collection',
      '--config',
      '.github/zizmor.yml',
      ...mode,
      '--collect=all',
      '.github',
    ],
    env,
  );
  return online ? 'online' : 'offline';
}

/* ///// cf-typegen:check ///// */

/** The file `wrangler types` writes, which the repository tracks. */
const TYPES = 'worker-configuration.d.ts';

// The cf-typegen:check script's three steps, with wrangler from its path.
// git diff reads the worktree against the index, so a stale index fails on
// purpose. --no-ext-diff, so a diff.external from the environment cannot
// answer for it.
async function cfTypegen(): Promise<undefined> {
  await rm(TYPES, { force: true });
  expectClean(
    'wrangler types',
    [BUN, join(PACKAGES, 'wrangler/bin/wrangler.js'), 'types', '--env-file', '.dev.vars.template'],
    loopbackUnproxied(),
  );
  expectClean(`git diff over ${TYPES}`, ['git', 'diff', '--no-ext-diff', '--exit-code', '--', TYPES]);
}

/* ///// test ///// */

function test(): undefined {
  // The output streams through, so the coverage table lands in the log.
  const finished = run(
    [BUN, join(PACKAGES, 'vitest/vitest.mjs'), 'run', '--coverage'],
    TOOL_TIMEOUT_MS,
    loopbackUnproxied(),
    { show: true },
  );
  if (finished.exitCode !== 0) {
    throw new Error(`vitest run --coverage ${describe(finished)}`);
  }
}

/* ///// The rows ///// */

const rows: readonly Row[] = [
  { name: 'scripts:test', checks: "bun test over the gate's own scripts/*.test.ts", check: scriptsTest },
  {
    name: 'tools',
    checks: 'mise.toml and mise.lock against scripts/tools.ts, then the install',
    check: toolsRow,
  },
  {
    name: 'typecheck',
    checks: 'tsc --noEmit over src, tests and scripts',
    // The native TypeScript 7 compiler, called by its alias's path because the
    // 6.x `typescript` package that typescript-eslint needs ships a tsc of its
    // own. One pass per project, the three the typecheck script names.
    check: () => {
      for (const project of ['tsconfig.json', 'tests/tsconfig.json', 'scripts/tsconfig.json']) {
        packaged(`tsc -p ${project}`, '@typescript/native/bin/tsc', '--noEmit', '-p', project)();
      }
      return undefined;
    },
  },
  {
    name: 'cf-typegen:check',
    checks: 'worker-configuration.d.ts regenerated from scratch matches the index',
    check: cfTypegen,
  },
  {
    name: 'format:check',
    checks: 'prettier --check over the tree',
    check: packaged('prettier', 'prettier/bin/prettier.cjs', '--check', '.'),
  },
  {
    name: 'taplo',
    checks: 'taplo fmt --check over every TOML file .taplo.toml names',
    // The config is named, so TAPLO_CONFIG in the environment cannot swap it for
    // one that matches no file, which checks nothing and exits 0.
    check: () => {
      expectClean('taplo', [binary('taplo'), 'fmt', '--check', '--config', '.taplo.toml']);
      return undefined;
    },
  },
  {
    name: 'lint',
    checks: 'eslint over the tree with no warnings allowed',
    check: packaged('eslint', 'eslint/bin/eslint.js', '.', '--max-warnings=0'),
  },
  {
    name: 'actionlint',
    checks: 'actionlint with ShellCheck proven present over .github/workflows',
    check: actionlint,
  },
  {
    name: 'zizmor',
    checks: 'zizmor over .github with nothing ignored, online in check when gh has a token and offline otherwise',
    check: zizmor,
  },
  { name: 'test', checks: 'vitest run --coverage, left out by check:quick', check: test, slow: true },
];

/* ///// The run ///// */

const color = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
const dim = (text: string): string => (color ? styleText('dim', text) : text);
const glyph = (ok: boolean): string => (color ? styleText(ok ? 'green' : 'red', ok ? '✓' : '✗') : ok ? '✓' : '✗');
const width = Math.max(...rows.map((row) => row.name.length));
const seconds = (started: number): string => `${((performance.now() - started) / 1000).toFixed(1)}s`;

/** One row's result line: its glyph, its name, its time, and its note when it has one. */
function resultLine(ok: boolean, row: Row, started: number, note?: string): string {
  return `  ${glyph(ok)} ${row.name.padEnd(width)}  ${dim(seconds(started))}${note === undefined ? '' : `  ${dim(note)}`}`;
}

async function main(): Promise<number> {
  if (process.argv.includes('--rows')) {
    console.log(dim('rows'));
    console.log();
    for (const row of rows) {
      console.log(`  ${row.name.padEnd(width)}  ${row.checks}`);
    }
    return 0;
  }

  const quick = process.argv.includes('--quick');
  const selected = rows.filter((row) => !quick || row.slow !== true);
  console.log(dim(quick ? 'check:quick' : 'check'));
  console.log();

  // Bun loaded any env file here into this process before it ran, and a file
  // tracked under node_modules stands in for what bun install would put
  // there, so no row runs beside either. This comes before any other process
  // the gate starts.
  const tracked = trackedFindings();
  if (tracked.length > 0) {
    console.log(`  ${glyph(false)} ${'tracked'.padEnd(width)}  ${dim('no row ran')}`);
    console.log(`    ${tracked.join('\n    ')}`);
    return 1;
  }
  for (const row of selected) {
    const started = performance.now();
    try {
      const note = await row.check(quick);
      console.log(resultLine(true, row, started, note));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(resultLine(false, row, started));
      console.log(`    ${message.split('\n').join('\n    ')}`);
      console.log(`  ${dim('─'.repeat(width + 12))}`);
      console.log(`  ${row.name} failed, and the rows after it did not run`);
      return 1;
    }
  }
  console.log(`  ${dim('─'.repeat(width + 12))}`);
  console.log(`  ${String(selected.length)} checks passed`);
  return 0;
}

process.exitCode = await main();
