/**
 * The gate: every check a contributor can run locally, in one command.
 *
 * @remarks
 * `bun run check` runs the rows in order, cheapest first, and stops at the
 * first failure. `bun run check:quick` runs the same rows without the tests,
 * which is what the push hook runs. `bun run check:rows` prints the rows and
 * runs nothing, which is the list CONTRIBUTING.md points at. CI's gate job
 * runs `bun run check` on three platforms, so a green run here is a green run
 * there.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { styleText } from 'node:util';
import { describe, run } from './run';
import { install, lockfileFindings, resolve } from './tools';

/** The deadline for one script, linter or formatter pass over the tree. */
const TOOL_TIMEOUT_MS = 300_000;

// The CI token is read once and taken out of the environment every row's
// processes inherit, so the tests, wrangler and the linters never see it. The
// zizmor row is the one that uses it.
const ghToken: string | undefined = process.env['GH_TOKEN'];
delete process.env['GH_TOKEN'];

/** A row of the gate: its name, what it checks, and the check itself. */
interface Row {
  readonly name: string;
  readonly checks: string;
  readonly check: (quick: boolean) => void | Promise<void>;
  /** True for the rows `check:quick` leaves out. */
  readonly slow?: true;
}

/** The binary paths the `mise-install` row resolves, read by the rows after it. */
const binaries = new Map<string, string>();

/** The path the `mise-install` row resolved for `key`. */
function binary(key: string): string {
  const path = binaries.get(key);
  if (path === undefined) {
    throw new Error(`the mise-install row did not resolve ${key}, so this row cannot run`);
  }
  return path;
}

/** Throws with the process's output when it did not exit 0. */
function expectClean(label: string, cmd: readonly string[], env: Readonly<Record<string, string>> = {}): void {
  const finished = run(cmd, TOOL_TIMEOUT_MS, env);
  if (finished.exitCode !== 0) {
    throw new Error(`${label} ${describe(finished)}`);
  }
}

/** A row that runs one package.json script and passes when it exits 0. */
function script(name: string): () => void {
  return () => {
    expectClean(`bun run ${name}`, ['bun', 'run', name]);
  };
}

/* ///// mise ///// */

async function miseLock(): Promise<void> {
  const found = await lockfileFindings();
  if (found.length > 0) {
    throw new Error(found.join('\n'));
  }
}

async function miseInstall(): Promise<void> {
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

async function actionlint(): Promise<void> {
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

/** The GitHub token for zizmor's online audits: the CI token, else gh's, else none. */
function githubToken(): string | undefined {
  if (ghToken !== undefined && ghToken.length > 0) {
    return ghToken;
  }
  const printed = run(['gh', 'auth', 'token'], TOOL_TIMEOUT_MS);
  const token = printed.stdout.trim();
  return printed.exitCode === 0 && token.length > 0 ? token : undefined;
}

function zizmor(quick: boolean): void {
  // --strict-collection fails on a file zizmor cannot parse. Without it the
  // file is dropped with a warning and the run reports no findings for a
  // workflow it never read. The config is named so ZIZMOR_CONFIG in the
  // environment cannot swap it. The full gate runs online when a token is at
  // hand, because the known-vulnerable-actions and stale-ref audits read
  // GitHub, and that is the one result of the gate that can change while the
  // tree stands still. check:quick runs offline, so the push hook needs no
  // network and no token, and ZIZMOR_OFFLINE=true forces offline for the rest.
  // The input is the repository root, so zizmor audits every kind it collects:
  // workflows, action definitions and a Dependabot config. Collection honors
  // .gitignore, which keeps node_modules and .claude/worktrees out.
  const token = quick || process.env['ZIZMOR_OFFLINE'] !== undefined ? undefined : githubToken();
  const online = token !== undefined;
  const mode = online ? [] : ['--offline'];
  const env: Readonly<Record<string, string>> = online ? { GH_TOKEN: token } : {};
  expectClean(
    `zizmor (${online ? 'online' : 'offline'})`,
    [binary('zizmor'), '--no-progress', '--strict-collection', '--config', '.github/zizmor.yml', ...mode, '.'],
    env,
  );
}

/* ///// test ///// */

function test(): void {
  // The output streams through, so the coverage table lands in the log.
  const finished = run(['bun', 'run', 'test:coverage'], TOOL_TIMEOUT_MS, {}, true);
  if (finished.exitCode !== 0) {
    throw new Error(`bun run test:coverage ${describe(finished)}`);
  }
}

/* ///// The rows ///// */

const rows: readonly Row[] = [
  {
    name: 'mise-lock',
    checks:
      'mise.lock records every tool on every platform with a checksum, the expected backend, hosts and provenance',
    check: miseLock,
  },
  {
    name: 'mise-install',
    checks: 'mise install --locked, then every binary resolves through mise which at its pinned version',
    check: miseInstall,
  },
  { name: 'typecheck', checks: 'tsc --noEmit over src, tests and scripts', check: script('typecheck') },
  {
    name: 'cf-typegen:check',
    checks: 'worker-configuration.d.ts regenerated from scratch matches the index',
    check: script('cf-typegen:check'),
  },
  { name: 'format:check', checks: 'prettier --check over the tree', check: script('format:check') },
  {
    name: 'taplo',
    checks: 'taplo fmt --check over bunfig.toml and mise.toml',
    check: () => {
      expectClean('taplo', [binary('taplo'), 'fmt', '--check', 'bunfig.toml', 'mise.toml']);
    },
  },
  { name: 'lint', checks: 'eslint over the tree with no warnings allowed', check: script('lint') },
  {
    name: 'actionlint',
    checks: 'actionlint with ShellCheck proven present over .github/workflows',
    check: actionlint,
  },
  {
    name: 'zizmor',
    checks: 'zizmor --strict-collection over the repository root, online in check and offline in check:quick',
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
  for (const row of selected) {
    const started = performance.now();
    try {
      await row.check(quick);
      console.log(`  ${glyph(true)} ${row.name.padEnd(width)}  ${dim(seconds(started))}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ${glyph(false)} ${row.name.padEnd(width)}  ${dim(seconds(started))}`);
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
