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
 * No row resolves a tool from the machine's PATH. Bun is the process running
 * this file, every package runs from its absolute path under node_modules, and
 * every other tool resolves through `mise which`. Every tool that searches for
 * a config runs with its one config named. Before any row, the gate refuses to
 * run beside a tracked env file Bun loads, a tracked `.npmrc`, a tracked path
 * under node_modules, a config a tool would read in place of the one the gate
 * names, a bunfig.toml that holds anything but the install cooldown, anything
 * that would steer how Bun resolves an import, a changed config or ignore file
 * a row reads, or a root file named like a program. Every row that walks the
 * tree says how many files it checked and fails when that is none.
 *
 * CI and the push hook start this file as `bun scripts/check.ts`, not through
 * `bun run`, because the script runner puts the checkout's node_modules/.bin
 * ahead of PATH, where a committed bun would run in place of the gate.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, sep } from 'node:path';
import { styleText } from 'node:util';
// Every module imported here reads Bun and node: built-ins alone, so nothing
// under node_modules loads before the preflight in main() refuses a planted
// package. tools.ts imports zod and the format:check row imports prettier, so
// each loads where a row needs it.
import { githubToken } from './github';
import { describe, type Finished, fold, run } from './run';
import {
  ESLINT_CONFIG,
  PRETTIERIGNORE,
  PRETTIERRC,
  startupFindings,
  TAPLO_CONFIG,
  trackedFindings,
  TSCONFIG,
  ZIZMOR_CONFIG,
} from './startup';

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

/**
 * How many characters of file arguments one command carries. Windows caps a
 * whole command line at 32,767, so a longer list runs in batches.
 */
const ARGUMENT_BUDGET = 24_000;

// ShellCheck reads extra flags from SHELLCHECK_OPTS whatever actionlint's --norc
// says, and one can exclude any finding, so no process the gate starts gets it.
delete process.env['SHELLCHECK_OPTS'];

/** A row of the gate: its name, what it checks, and the check itself. */
export interface Row {
  readonly name: string;
  readonly checks: string;
  /** Runs the check. A string it returns prints after the row's time. */
  readonly check: (quick: boolean) => string | undefined | Promise<string | undefined>;
  /** True for the rows `check:quick` leaves out. */
  readonly slow?: true;
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

/** The process's output, or a throw carrying it when the process did not exit 0. */
async function expectClean(
  label: string,
  cmd: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Finished> {
  const finished = await run(cmd, TOOL_TIMEOUT_MS, env);
  if (finished.exitCode !== 0) {
    throw new Error(`${label} ${describe(finished)}`);
  }
  return finished;
}

/**
 * The environment every git call in a row runs under: the gate's own, with
 * every inherited `GIT_*` variable removed.
 *
 * @remarks
 * A git hook can export `GIT_DIR` and `GIT_INDEX_FILE`, and either points git
 * at a repository or an index other than the working directory's. With them
 * gone, git finds the repository from the directory alone.
 */
function gitEnv(): Readonly<Record<string, undefined>> {
  return Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => /^GIT_/i.test(name))
      .map((name) => [name, undefined]),
  );
}

/**
 * The tracked files `pathspecs` match, relative to the root, from one
 * `git ls-files`, less any the working tree no longer holds.
 *
 * @remarks
 * Tracked files alone, so no .gitignore decides what a row reads, and CI's
 * checkout holds exactly these. A new file counts once it is added.
 */
async function trackedFiles(...pathspecs: string[]): Promise<string[]> {
  const finished = await run(['git', 'ls-files', '-z', '--', ...pathspecs], TOOL_TIMEOUT_MS, gitEnv());
  if (finished.exitCode !== 0) {
    throw new Error(`git ls-files ${describe(finished)}`);
  }
  return [...new Set(finished.stdout.split('\0').filter((path) => path.length > 0))].filter((path) => existsSync(path));
}

/**
 * `paths` in batches that fit {@link ARGUMENT_BUDGET}.
 *
 * @remarks
 * Every command puts `--` ahead of a batch, so a file named like a flag never
 * reads as one. A path keeps its plain form, because taplo matches its
 * excludes against the path as given and a `./` prefix slips past them.
 */
function batches(paths: readonly string[]): string[][] {
  const all: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const path of paths) {
    if (current.length > 0 && length + path.length + 1 > ARGUMENT_BUDGET) {
      all.push(current);
      current = [];
      length = 0;
    }
    current.push(path);
    length += path.length + 1;
  }
  if (current.length > 0) {
    all.push(current);
  }
  return all;
}

/** `path` as an absolute path compared without regard to case where the filesystem ignores it. */
function comparable(path: string): string {
  const absolute = resolvePath(path);
  return process.platform === 'win32' || process.platform === 'darwin' ? absolute.toLowerCase() : absolute;
}

/** How a count of files reads in a row's line. */
function files(count: number): string {
  return `${String(count)} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * NO_PROXY for a package that talks to workerd on this machine: the gate's
 * own list in whichever spellings the platform reads, and the loopback names,
 * each value once.
 *
 * @remarks
 * Bun sends a request to localhost through HTTP_PROXY unless NO_PROXY names
 * it, where Node's clients do not. Behind a proxy, wrangler's type generation
 * and vitest's workers pool then cannot reach the workerd they start. Windows
 * reads one name in any case, so both spellings there read one value.
 */
export function loopbackUnproxied(): Readonly<Record<string, string>> {
  const own = [process.env['NO_PROXY'], process.env['no_proxy']].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return { NO_PROXY: [...new Set([...own, 'localhost', '127.0.0.1', '::1'])].join(',') };
}

/* ///// scripts:test ///// */

async function scriptsTest(): Promise<undefined> {
  // bun test, because the gate's own tests call Bun's APIs. The path keeps it
  // off tests/, which vitest runs. The output streams through, so a failure's
  // report lands in the log. bun test exits 1 when it finds no test file.
  const finished = await run([BUN, 'test', './scripts/'], TOOL_TIMEOUT_MS, {}, { show: true });
  if (finished.exitCode !== 0) {
    throw new Error(`bun test ./scripts/ ${describe(finished)}. The report is above`);
  }
}

/* ///// tools ///// */

// install() asserts mise.toml and mise.lock before mise starts, as every
// mise command the gate runs does.
async function tools(): Promise<undefined> {
  const { install, resolve } = await import('./tools');
  await install();
  for (const [key, path] of await resolve()) {
    binaries.set(key, path);
  }
}

/* ///// typecheck ///// */

/** The TypeScript projects the typecheck row checks, one tsc pass each. */
export const PROJECTS: readonly string[] = [TSCONFIG, 'tests/tsconfig.json', 'scripts/tsconfig.json'];

// The native TypeScript 7 compiler, called by its alias's path because the
// 6.x `typescript` package that typescript-eslint needs ships a tsc of its
// own. Each project is named, so tsc never searches past the checkout for a
// config, and scripts/ carries its own, so the root one never reaches the
// gate's module resolution. --listFiles names every file the program read, so
// the row counts the ones from the repository.
async function typecheck(): Promise<string> {
  const root = comparable('.') + sep;
  const counts: string[] = [];
  for (const project of PROJECTS) {
    const finished = await run(
      [BUN, join(PACKAGES, '@typescript/native/bin/tsc'), '--noEmit', '--listFiles', '--project', project],
      TOOL_TIMEOUT_MS,
    );
    const lines = finished.stdout.split(/\r?\n/);
    const listed = lines.filter((line) => isAbsolutePath(line));
    if (finished.exitCode !== 0) {
      const report = lines.filter((line) => !isAbsolutePath(line)).join('\n');
      throw new Error(`tsc over ${project} ${describe({ ...finished, stdout: report })}`);
    }
    const read = listed.filter((line) => {
      const path = comparable(line);
      return path.startsWith(root) && !/[\\/]node_modules[\\/]/i.test(path);
    });
    if (read.length === 0) {
      throw new Error(`tsc over ${project} read no file from the repository, so it checked nothing`);
    }
    counts.push(files(read.length));
  }
  return `${counts.slice(0, -1).join(', ')} and ${counts.at(-1) ?? ''}`;
}

/** Whether a line tsc printed is a path it read rather than a diagnostic. */
function isAbsolutePath(line: string): boolean {
  return /^([A-Za-z]:)?\//.test(line.trim());
}

/* ///// cf-typegen:check ///// */

/** The file `wrangler types` writes, which the repository tracks. */
const TYPES = 'worker-configuration.d.ts';

// The cf-typegen:check script's three steps, with wrangler from its path.
// git diff reads the worktree against the index, so a stale index fails on
// purpose, and a file git does not track passes git diff, so the first read
// refuses one. --error-unmatch refuses an untracked file whether or not an
// ignore rule names it. --no-ext-diff, so a diff.external from the
// environment cannot answer for it. A wrangler that fails leaves the file
// deleted, so the row restores the tracked copy before it goes red.
export async function cfTypegen(): Promise<undefined> {
  const tracked = await run(['git', 'ls-files', '--error-unmatch', '--', TYPES], TOOL_TIMEOUT_MS, gitEnv());
  if (tracked.exitCode !== 0) {
    throw new Error(`${TYPES} is not tracked. Regenerate it with bun run cf-typegen, then: git add ${TYPES}`);
  }
  await rm(TYPES, { force: true });
  const generated = await run(
    [BUN, join(PACKAGES, 'wrangler/bin/wrangler.js'), 'types', '--env-file', '.dev.vars.template'],
    TOOL_TIMEOUT_MS,
    loopbackUnproxied(),
  );
  if (generated.exitCode !== 0) {
    const restored = await run(['git', 'checkout', '--', TYPES], TOOL_TIMEOUT_MS, gitEnv());
    const kept = restored.exitCode === 0 ? '' : `. git could not restore ${TYPES}: it ${describe(restored)}`;
    throw new Error(`wrangler types ${describe(generated)}${kept}`);
  }
  await expectClean(`git diff over ${TYPES}`, ['git', 'diff', '--no-ext-diff', '--exit-code', '--', TYPES], gitEnv());
}

/* ///// format:check ///// */

// Prettier names no file it checked, so the row hands it every tracked file
// Prettier would format, decided by Prettier's own getFileInfo against the one
// ignore file, and counts that list. getFileInfo runs inside the gate, so it
// is told to resolve no config, which could load a plugin here. --ignore-path
// names .prettierignore alone, so .gitignore never narrows it, and --config
// names the one config, so Prettier searches for no other file and a config
// under a subdirectory never loads. --no-editorconfig keeps any .editorconfig
// from setting an option.
async function formatCheck(): Promise<string> {
  const { getFileInfo } = await import('prettier');
  const checked: string[] = [];
  for (const path of await trackedFiles()) {
    const info = await getFileInfo(path, { ignorePath: PRETTIERIGNORE, resolveConfig: false });
    if (!info.ignored && info.inferredParser !== null) {
      checked.push(path);
    }
  }
  if (checked.length === 0) {
    throw new Error('no tracked file is one Prettier formats, so the row checks nothing');
  }
  for (const batch of batches(checked)) {
    await expectClean('prettier', [
      BUN,
      join(PACKAGES, 'prettier/bin/prettier.cjs'),
      '--check',
      '--config',
      PRETTIERRC,
      '--ignore-path',
      PRETTIERIGNORE,
      '--no-editorconfig',
      '--',
      ...batch,
    ]);
  }
  return files(checked.length);
}

/* ///// taplo ///// */

/** Every path in taplo's `found files ... files=[...]` log line, or undefined when it printed none. */
function taploFound(printed: string): string[] | undefined {
  const line = /found files total=\d+ excluded=\d+ files=\[(.*)\]/.exec(printed);
  if (line === null) {
    return undefined;
  }
  return [...(line[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => (match[1] ?? '').replace(/\\(.)/g, '$1'));
}

// taplo exits 0 having checked nothing when a file it was handed is missing
// or excluded, so the row matches the files taplo says it found against the
// files it handed over. The config is named, so TAPLO_CONFIG in the
// environment cannot swap it. RUST_LOG is set, because taplo prints its found
// line at that level and a contributor's own setting would hide it.
async function taplo(): Promise<string> {
  const program = binary('taplo');
  const handed = (await trackedFiles()).filter((path) => fold(path).endsWith('.toml'));
  if (handed.length === 0) {
    throw new Error('no TOML file is tracked, so the row checks nothing');
  }
  for (const batch of batches(handed)) {
    const finished = await expectClean('taplo', [program, 'fmt', '--check', '--config', TAPLO_CONFIG, '--', ...batch], {
      RUST_LOG: 'info',
    });
    const found = taploFound(`${finished.stdout}\n${finished.stderr}`);
    if (found === undefined) {
      throw new Error(`taplo printed no found-files line, so what it checked is unknown: ${describe(finished)}`);
    }
    const reported = new Set(found.map((path) => comparable(path)));
    const missed = batch.filter((path) => !reported.has(comparable(path)));
    if (missed.length > 0 || reported.size !== batch.length) {
      throw new Error(
        `taplo checked ${files(reported.size)} of the ${files(batch.length)} handed to it. Not checked: ${missed.join(', ')}. ${TAPLO_CONFIG} decides which it reads`,
      );
    }
  }
  return files(handed.length);
}

/* ///// lint ///// */

/** One message ESLint's json formatter reports against a file. */
interface LintMessage {
  readonly ruleId?: string | null;
  readonly severity?: number;
  readonly message?: string;
  readonly line?: number;
  readonly column?: number;
}

/** One file ESLint's json formatter reports on. */
interface LintResult {
  readonly filePath: string;
  readonly messages: readonly LintMessage[];
}

/** Whether `value`, parsed from ESLint's json output, is one file's result. */
function isLintResult(value: unknown): value is LintResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { filePath?: unknown }).filePath === 'string' &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

// The json formatter names every file ESLint linted, so the row counts them
// and prints each problem itself. --config names the one config, so ESLint
// runs no eslint.config.* nearer a file than the root.
async function lint(): Promise<string> {
  const finished = await run(
    [
      BUN,
      join(PACKAGES, 'eslint/bin/eslint.js'),
      '--config',
      ESLINT_CONFIG,
      '.',
      '--max-warnings=0',
      '--format',
      'json',
    ],
    TOOL_TIMEOUT_MS,
  );
  let results: unknown;
  try {
    results = JSON.parse(finished.stdout);
  } catch {
    // No json means ESLint stopped before it linted anything, a config error among them.
    throw new Error(`eslint ${describe(finished)}`);
  }
  if (!Array.isArray(results) || !results.every((result) => isLintResult(result))) {
    throw new Error(`eslint printed json that is not a list of file results: ${describe(finished)}`);
  }
  const problems = results.flatMap((result) =>
    result.messages.map(
      (message) =>
        `${result.filePath}:${String(message.line ?? 0)}:${String(message.column ?? 0)}  ${message.severity === 2 ? 'error' : 'warning'}  ${message.message ?? ''}  ${message.ruleId ?? ''}`,
    ),
  );
  if (finished.exitCode !== 0) {
    throw new Error(
      `eslint exited ${String(finished.exitCode)} over ${files(results.length)}:\n${[...problems, finished.stderr.trim()].filter((line) => line.length > 0).join('\n')}`,
    );
  }
  if (results.length === 0) {
    throw new Error('eslint linted no file, so it checked nothing');
  }
  return files(results.length);
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

/** The tracked workflows, which the actionlint and zizmor rows each prove they read. */
async function workflowFiles(): Promise<string[]> {
  const found = await trackedFiles(':(glob).github/workflows/*.yml', ':(glob).github/workflows/*.yaml');
  if (found.length === 0) {
    throw new Error('no workflow is tracked under .github/workflows, so the row checks nothing');
  }
  return found;
}

async function actionlint(): Promise<string> {
  const lint = binary('actionlint');
  const shellcheck = binary('shellcheck');
  // -pyflakes= because no Windows package manager ships pyflakes, and
  // actionlint skips that pass without a word when it is missing.
  const analyzers = [`-shellcheck=${shellcheck}`, '-pyflakes='];

  const dir = await mkdtemp(join(tmpdir(), 'actionlint-canary-'));
  try {
    const canary = join(dir, 'canary.yml');
    await Bun.write(canary, SHELLCHECK_CANARY);
    const finished = await run([lint, ...analyzers, canary], TOOL_TIMEOUT_MS);
    if (!finished.stdout.includes(SHELLCHECK_FINDING)) {
      throw new Error(
        `actionlint found no ${SHELLCHECK_FINDING} in a script that carries one, so ShellCheck never ran. It ${describe(finished)}. Check that ${shellcheck} starts`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // The workflows are named, so actionlint needs no .git to find them, and
  // -verbose makes it name each file it finished. A committed actionlint
  // config is refused before any row, so none silences a finding here.
  const workflows = await workflowFiles();
  for (const batch of batches(workflows)) {
    const finished = await run([lint, '-verbose', ...analyzers, '--', ...batch], TOOL_TIMEOUT_MS);
    const report = { ...finished, stderr: finished.stderr.replace(/^verbose:.*\r?\n?/gm, '') };
    if (finished.exitCode !== 0) {
      throw new Error(`actionlint ${describe(report)}`);
    }
    const linted = new Set(
      [...finished.stderr.matchAll(/^(?:verbose: )*Found total \d+ errors? in \d+ ms for (.+?)\r?$/gm)].map(
        (match) => match[1] ?? '',
      ),
    );
    const unlinted = batch.filter((path) => !linted.has(path));
    if (unlinted.length > 0) {
      throw new Error(`actionlint finished no lint of ${unlinted.join(', ')}: ${describe(report)}`);
    }
  }
  return files(workflows.length);
}

/* ///// zizmor ///// */

async function zizmor(quick: boolean): Promise<string> {
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
  // never reaches node_modules or .claude/worktrees. zizmor prints
  // `completed <file>` for each input at RUST_LOG's info level, so the row
  // proves every tracked workflow was audited.
  const workflows = await workflowFiles();
  const token = quick || process.env['ZIZMOR_OFFLINE'] !== undefined ? undefined : await githubToken('gh');
  const online = token !== undefined;
  const mode = online ? [] : ['--offline'];
  const env: Readonly<Record<string, string>> = online ? { GH_TOKEN: token, RUST_LOG: 'info' } : { RUST_LOG: 'info' };
  const audited = await expectClean(
    `zizmor (${online ? 'online' : 'offline'})`,
    [
      binary('zizmor'),
      '--no-progress',
      '--strict-collection',
      '--config',
      ZIZMOR_CONFIG,
      ...mode,
      '--collect=all',
      '.github',
    ],
    env,
  );
  const completed = new Set(
    [...audited.stderr.matchAll(/completed (.+?)\r?$/gm)].map((match) => (match[1] ?? '').replaceAll('\\', '/')),
  );
  const unaudited = workflows.filter((path) => !completed.has(path));
  if (completed.size === 0 || unaudited.length > 0) {
    throw new Error(
      `zizmor completed ${files(completed.size)}, and these tracked workflows were not among them: ${unaudited.join(', ') || 'none'}`,
    );
  }
  return `${online ? 'online' : 'offline'} over ${files(completed.size)}`;
}

/* ///// test ///// */

async function test(): Promise<undefined> {
  // The output streams through, so the coverage table lands in the log.
  // vitest exits 1 when it finds no test file.
  const finished = await run(
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

export const rows: readonly Row[] = [
  { name: 'scripts:test', checks: "bun test over the gate's own scripts/*.test.ts", check: scriptsTest },
  {
    name: 'tools',
    checks: 'mise.toml and mise.lock against scripts/tools.ts, then the install',
    check: tools,
  },
  {
    name: 'typecheck',
    checks: 'tsc --noEmit over src, tests and scripts, one --project each, counting the files each read',
    check: typecheck,
  },
  {
    name: 'cf-typegen:check',
    checks: 'worker-configuration.d.ts, tracked, regenerated from scratch matches the index',
    check: cfTypegen,
  },
  {
    name: 'format:check',
    checks:
      'prettier --check over every tracked file Prettier formats, with .prettierrc and .prettierignore alone and no .editorconfig',
    check: formatCheck,
  },
  {
    name: 'taplo',
    checks: 'taplo fmt --check over every tracked TOML file, each one proven checked',
    check: taplo,
  },
  {
    name: 'lint',
    checks: 'eslint over the tree with eslint.config.ts alone and no warnings allowed, counting the files it linted',
    check: lint,
  },
  {
    name: 'actionlint',
    checks: 'actionlint over every tracked workflow with ShellCheck proven present, each one proven linted',
    check: actionlint,
  },
  {
    name: 'zizmor',
    checks:
      'zizmor over .github with nothing ignored and each tracked workflow proven audited, online in check when gh has a token and offline otherwise',
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

  // Bun loaded any env file here into this process, ran any preload
  // bunfig.toml names, and resolved this file's imports before this line. A
  // tracked .npmrc steered the install, and a file tracked under node_modules
  // stands in for what bun install would put there. So no row runs beside
  // any of them. This comes before any other process the gate starts.
  const refused = [...(await trackedFindings()), ...(await startupFindings())];
  if (refused.length > 0) {
    console.log(`  ${glyph(false)} ${'preflight'.padEnd(width)}  ${dim('no row ran')}`);
    console.log(`    ${refused.join('\n    ')}`);
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

// Run as a file, the gate runs. Imported, as scripts/check.test.ts does, it
// runs nothing and hands over its rows.
if (import.meta.main) {
  process.exitCode = await main();
}
