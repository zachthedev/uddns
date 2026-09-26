/**
 * The gate: every check a contributor can run locally, in one command.
 *
 * @remarks
 * `bun run check` runs the rows in order and stops at the first failure.
 * `bun run check:quick` runs the same rows without the test row, the form the
 * push hook runs. `bun run check <row>` runs the named rows alone.
 * `bun run check:rows` prints the rows and runs nothing, which is the list
 * CONTRIBUTING.md points at. CI's gate job runs this file on three platforms,
 * so a green run here is a green run there.
 *
 * No row resolves a tool from the machine's PATH. The programs the gate
 * expects there, git, mise and gh, are the prerequisites CONTRIBUTING.md#setup
 * names. Bun is the process running this file, every JavaScript tool starts
 * through `bun x --bun --no-install` once the checkout's node_modules/.bin
 * holds it, and every other tool resolves through `mise which`. Every tool
 * that searches for a config runs with its one config named. Before any row,
 * the gate refuses to run beside a config a tool would read in place of the
 * one the gate names, a tracked env file Bun loads, a project config outside
 * the named paths, a node_modules below the root, a JSON key Bun and the
 * shared commits job read two ways, a patch a package.json names, anything
 * that would steer how Bun resolves the gate's own imports, a workflow the
 * workflows row would not read, or an inline zizmor waiver under .github. No
 * config's text is held: code-owner review is the control on a change to one.
 * The other files that run code before the gate's first line, such as a
 * bunfig.toml preload, are refused before a merge by the shared commits and
 * workflows jobs. A pull request cannot edit those jobs at the pin ci.yml
 * calls, and code-owner review of .github/workflows/ is the control on a
 * change to that pin or to the job that runs this file. Every row that walks
 * the tree says how many files it checked and fails when that is none. The
 * rows that run the repository's own code come last, and the preflight runs
 * again after each. No row carries a deadline: the CI job's timeout-minutes
 * bounds the gate.
 *
 * CI and the push hook start this file as `bun --no-env-file scripts/check.ts`,
 * not through `bun run`, because the script runner puts the checkout's
 * node_modules/.bin ahead of PATH, where a committed bun would run in place of
 * the gate.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { styleText } from 'node:util';
import type * as Prettier from 'prettier';
// Every module imported here reads Bun and node: built-ins alone, so the
// preflight runs and prints on a checkout with no install. tools.ts imports
// zod and the format row imports prettier, each by its path under the
// checkout's node_modules, so a missing install fails the row that needs it.
// github.ts takes every GitHub token out of the environment when it loads,
// before any row starts a process.
import { githubToken } from './github';
import {
  actionlintFinished,
  comparable,
  compilerFinding,
  files,
  ignoreCommentFindings,
  inheritedCallFindings,
  inheritedCalls,
  taploFound,
  testCount,
  unreadSourceFinding,
  zizmorCompleted,
} from './rows';
import { describe, type Finished, fold, git, jsTool, plain, printable, quote, run } from './run';
import {
  ESLINT_CONFIG,
  isTable,
  PRETTIERIGNORE,
  PRETTIERRC,
  startupFindings,
  TAPLO_CONFIG,
  trackedFindings,
  TSCONFIG,
  ZIZMOR_CONFIG,
} from './startup';

/** The Bun running the gate, so every row runs the one `packageManager` pins. */
const BUN = process.execPath;

/**
 * The flag every Bun the gate starts directly gets first, so no env file on
 * disk sets a variable inside the row: the scripts:test run and the ShellCheck
 * stand-in. Bun 1.4.2 honors it over all eight names it loads, in every mode.
 * `bun x` ignores it, so no JavaScript tool gets it.
 */
const NO_ENV_FILE = '--no-env-file';

/**
 * Prettier's module entry under the checkout's node_modules, by path, so a
 * missing install fails the format row rather than loading a copy from a
 * parent directory or installing one at run time. The specifier is held in a
 * variable, so tsc takes the types from the `import type` above and never
 * resolves the untyped file.
 */
const PRETTIER_ENTRY = '../node_modules/prettier/index.mjs';

/**
 * How many characters of file arguments one command carries. Windows caps a
 * whole command line at 32,767, so a longer list runs in batches.
 */
const ARGUMENT_BUDGET = 24_000;

// ShellCheck reads extra flags from SHELLCHECK_OPTS whatever actionlint's --norc
// says, and one can exclude any finding, so no process the gate starts gets it.
// run() withholds BUN_OPTIONS the same way.
delete process.env['SHELLCHECK_OPTS'];

/** A row of the gate: its name, what it checks, and the check itself. */
export interface Row {
  readonly name: string;
  readonly checks: string;
  /** Runs the check. A string it returns prints after the row's time. */
  readonly check: (quick: boolean) => string | undefined | Promise<string | undefined>;
  /** True for the rows `check:quick` leaves out. */
  readonly slow?: true;
  /**
   * True for a row that runs the repository's own code, which can write any
   * file a later row reads, so the preflight runs again before the next row.
   */
  readonly runsCode?: true;
}

/** The binary paths the `tools` row resolves, read by the rows after it. */
const binaries = new Map<string, string>();

/**
 * The path the `tools` row resolved for `key`.
 *
 * @remarks
 * A single row run with `bun run check <row>` skips the `tools` row, so the
 * map is filled from `mise which` on first use. That asserts mise.toml and
 * mise.lock first, resolves installed binaries and checks their versions; it
 * installs nothing.
 */
async function binary(key: string): Promise<string> {
  if (binaries.size === 0) {
    const { resolve } = await import('./tools');
    for (const [tool, path] of await resolve()) {
      binaries.set(tool, path);
    }
  }
  const path = binaries.get(key);
  if (path === undefined) {
    throw new Error(`TOOLS in scripts/tools.ts names no ${key}, so this row cannot run`);
  }
  return path;
}

/** The process's output, or a throw carrying it when the process did not exit 0. */
async function expectClean(
  label: string,
  cmd: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Finished> {
  const finished = await run(cmd, env);
  if (finished.exitCode !== 0) {
    throw new Error(`${label} ${describe(finished)}`);
  }
  return finished;
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
  const finished = await git(['ls-files', '-z', '--', ...pathspecs]);
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

/**
 * The variables every test runner the gate starts gets. With CI set, bun test
 * fails a file holding `test.only` rather than running that test alone and
 * leaving the rest out of its count, and vitest refuses `.only` the same way.
 */
const TEST_ENV: Readonly<Record<string, string>> = { CI: 'true' };

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
 *
 * Deviates from the handbook's kickstart: the Bun kickstart's rows set no
 * NO_PROXY. The package.json test scripts add the same names, and
 * CONTRIBUTING.md#troubleshooting records why.
 */
export function loopbackUnproxied(): Readonly<Record<string, string>> {
  const own = [process.env['NO_PROXY'], process.env['no_proxy']].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return { NO_PROXY: [...new Set([...own, 'localhost', '127.0.0.1', '::1'])].join(',') };
}

/* ///// scripts:test ///// */

// The gate's own tests, under bun test because they call Bun's APIs. The path
// keeps it off tests/, which vitest runs. Each case starts a stand-in in place
// of every program the gate starts, with a PATH holding the stand-ins alone,
// so none reaches the real gh, git, mise or the network. The row reads bun
// test's own count, and a failure prints the whole report.
async function scriptsTest(): Promise<string> {
  const finished = await run([BUN, NO_ENV_FILE, 'test', './scripts/'], TEST_ENV);
  if (finished.exitCode !== 0) {
    throw new Error(`bun test ./scripts/ ${describe(finished)}`);
  }
  return testCount('bun test ./scripts/', finished);
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

/** The package.json name of the native TypeScript 7 compiler the typecheck row runs. */
const NATIVE = '@typescript/native';

// The native TypeScript 7 compiler, from the `@typescript/native` alias. The
// 6.x `typescript` package that typescript-eslint needs ships a tsc too, and
// bun install links a command two packages claim to the one whose name sorts
// first, so node_modules/.bin/tsc is the alias's. The row first holds
// `tsc --version` to the major package.json pins for the alias, so a renamed
// alias or another tie-break turns it red. Each project is named, so tsc never
// searches past the checkout for a config, and scripts/ carries its own, so
// the root one never reaches the gate's module resolution. --listFiles names
// every file the program read, so the row counts the ones from the
// repository, and fails on a tracked TypeScript file that no project read.
async function typecheck(): Promise<string> {
  const manifest: unknown = JSON.parse(await Bun.file('package.json').text());
  const spec =
    isTable(manifest) && isTable(manifest['devDependencies']) ? manifest['devDependencies'][NATIVE] : undefined;
  if (typeof spec !== 'string') {
    throw new Error(`package.json names no ${NATIVE} in devDependencies, and the typecheck row runs that compiler`);
  }
  const version = await run([...jsTool('tsc'), '--version']);
  if (version.exitCode !== 0) {
    throw new Error(`tsc --version ${describe(version)}`);
  }
  const other = compilerFinding(version.stdout, spec);
  if (other !== undefined) {
    throw new Error(other);
  }
  const root = comparable('.') + sep;
  const counts: string[] = [];
  const checked = new Set<string>();
  for (const project of PROJECTS) {
    const finished = await run([...jsTool('tsc'), '--noEmit', '--listFiles', '--project', project]);
    const lines = plain(finished.stdout).split('\n');
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
    for (const line of read) {
      checked.add(comparable(line));
    }
  }
  const unread = unreadSourceFinding(await trackedFiles(), checked);
  if (unread !== undefined) {
    throw new Error(unread);
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

/** The one wrangler config, named because wrangler reads a wrangler.json ahead of it. */
const WRANGLER_CONFIG = 'wrangler.jsonc';

// The cf-typegen:check script's three steps, with wrangler through `bun x`.
// git diff reads the worktree against the index, so a stale index fails on
// purpose, and a file git does not track passes git diff, so the first read
// refuses one. --error-unmatch refuses an untracked file whether or not an
// ignore rule names it. --no-ext-diff, so a diff.external in the repository's
// own config cannot answer for it. A wrangler that fails leaves the file
// deleted, so the row restores the tracked copy before it goes red, and it
// checks for wrangler before it deletes anything.
// Deviates from the handbook's kickstart: the Bun kickstart's gate has no
// wrangler row. The Worker's bindings are typed from wrangler.jsonc, and
// wrangler types runs the build command that file names, so this is a code row.
export async function cfTypegen(): Promise<undefined> {
  const tracked = await git(['ls-files', '--error-unmatch', '--', TYPES]);
  if (tracked.exitCode !== 0) {
    throw new Error(`${TYPES} is not tracked. Regenerate it with bun run cf-typegen, then: git add ${TYPES}`);
  }
  const wrangler = jsTool('wrangler');
  await rm(TYPES, { force: true });
  const generated = await run(
    [...wrangler, 'types', '--config', WRANGLER_CONFIG, '--env-file', '.dev.vars.template'],
    loopbackUnproxied(),
  );
  if (generated.exitCode !== 0) {
    const restored = await git(['checkout', '--', TYPES]);
    const kept = restored.exitCode === 0 ? '' : `. git could not restore ${TYPES}: it ${describe(restored)}`;
    throw new Error(`wrangler types ${describe(generated)}${kept}`);
  }
  const diffed = await git(['diff', '--no-ext-diff', '--exit-code', '--', TYPES]);
  if (diffed.exitCode !== 0) {
    throw new Error(`git diff over ${TYPES} ${describe(diffed)}`);
  }
}

/* ///// format ///// */

// Prettier names no file it checked, so the row hands it every tracked file
// Prettier would format, decided by Prettier's own getFileInfo against the one
// ignore file, and counts that list. getFileInfo runs in the gate's process
// and resolves the config nearest each file unless told not to, a package.json
// prettier key and the plugins it names included, so resolveConfig is off.
// .prettierrc holds formatting options alone, under review, so it names no
// parser and the inferred parser is the same either way. --ignore-path names
// .prettierignore alone, so .gitignore never narrows it, and --config names
// the one config, so Prettier searches for no other file and a config under a
// subdirectory never loads. --no-editorconfig keeps any .editorconfig from
// setting an option.
async function format(): Promise<string> {
  const { getFileInfo } = (await import(PRETTIER_ENTRY)) as typeof Prettier;
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
  // Prettier leaves the code after its ignore comment unformatted with no
  // reason given, so the row refuses the comment in every file it checks.
  const waived: string[] = [];
  for (const path of checked) {
    waived.push(...ignoreCommentFindings(path, await Bun.file(path).text()));
  }
  if (waived.length > 0) {
    throw new Error(waived.join('\n'));
  }
  for (const batch of batches(checked)) {
    await expectClean('prettier', [
      ...jsTool('prettier'),
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

/* ///// toml ///// */

// taplo exits 0 having checked nothing when a file it was handed is missing
// or excluded, so the row matches the files taplo says it found against the
// files it handed over. The config is named, so TAPLO_CONFIG in the
// environment cannot swap it. RUST_LOG is set, because taplo prints its found
// line at that level and a contributor's own setting would hide it.
async function toml(): Promise<string> {
  const taplo = await binary('taplo');
  const handed = (await trackedFiles()).filter((path) => fold(path).endsWith('.toml'));
  if (handed.length === 0) {
    throw new Error('no TOML file is tracked, so the row checks nothing');
  }
  for (const batch of batches(handed)) {
    const finished = await expectClean('taplo', [taplo, 'fmt', '--check', '--config', TAPLO_CONFIG, '--', ...batch], {
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
        `taplo checked ${files(reported.size)} of the ${files(batch.length)} handed to it. Not checked: ${missed.map((path) => quote(path)).join(', ')}. ${TAPLO_CONFIG} decides which it reads`,
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
  /** The reports a directive in the file suppressed, which ESLint lists whatever the directive says. */
  readonly suppressedMessages?: readonly LintMessage[];
}

/** Whether `value`, parsed from ESLint's json output, is one file's result. */
function isLintResult(value: unknown): value is LintResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const suppressed = (value as { suppressedMessages?: unknown }).suppressedMessages;
  return (
    typeof (value as { filePath?: unknown }).filePath === 'string' &&
    Array.isArray((value as { messages?: unknown }).messages) &&
    (suppressed === undefined || Array.isArray(suppressed))
  );
}

/**
 * The rule no directive may suppress: the gate's own rule, which checks the
 * reason on every waiver.
 *
 * @remarks
 * ESLint applies a directive to the problems at its own position, so a
 * directive that names this rule suppresses the rule's report on that same
 * directive, and a block disable of it silences every waiver up to its enable.
 * The json formatter lists each suppressed report under `suppressedMessages`,
 * which no directive can empty, so the lint row refuses one there.
 *
 * Deviates from the handbook's kickstart: the Bun kickstart's lint row reads
 * `messages` alone.
 */
const UNWAIVABLE_RULE = 'gate/visible-reason';

// The json formatter names every file ESLint linted, so the row counts them
// and prints each problem itself. --config names the one config, so ESLint
// runs no eslint.config.* nearer a file than the root.
async function lint(): Promise<string> {
  const finished = await run([
    ...jsTool('eslint'),
    '--config',
    ESLINT_CONFIG,
    '.',
    '--max-warnings=0',
    '--format',
    'json',
  ]);
  let results: unknown;
  try {
    results = JSON.parse(plain(finished.stdout));
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
        `${quote(result.filePath)}:${String(message.line ?? 0)}:${String(message.column ?? 0)}  ${message.severity === 2 ? 'error' : 'warning'}  ${message.message ?? ''}  ${message.ruleId ?? ''}`,
    ),
  );
  const waived = results.flatMap((result) =>
    (result.suppressedMessages ?? [])
      .filter((message) => message.ruleId === UNWAIVABLE_RULE)
      .map(
        (message) =>
          `${quote(result.filePath)}:${String(message.line ?? 0)}:${String(message.column ?? 0)}  a directive suppresses ${UNWAIVABLE_RULE} here, and no directive may waive it  ${message.message ?? ''}`,
      ),
  );
  if (finished.exitCode !== 0) {
    throw new Error(
      `eslint exited ${String(finished.exitCode)} over ${files(results.length)}:\n${[...problems, ...waived, finished.stderr.trim()].filter((line) => line.length > 0).join('\n')}`,
    );
  }
  if (waived.length > 0) {
    throw new Error(
      `eslint reported ${String(waived.length)} ${UNWAIVABLE_RULE} ${waived.length === 1 ? 'problem' : 'problems'} a directive suppressed, and the rule that checks waivers takes none:\n${waived.join('\n')}`,
    );
  }
  if (results.length === 0) {
    throw new Error('eslint linted no file, so it checked nothing');
  }
  return files(results.length);
}

/* ///// workflows ///// */

/** A one-step workflow running `script`, for the canaries. */
function canaryWorkflow(script: string): string {
  return `name: canary
on: push
jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - run: |
          ${script.split('\n').join('\n          ')}
`;
}

/**
 * The two canaries, each a workflow and what actionlint must report over it.
 * The first carries one ShellCheck finding and nothing else, and SC2086 comes
 * back only when ShellCheck ran behind the stand-in. actionlint exits 0 when
 * the program its flag names cannot start, so a clean run over the tree
 * carries weight only after this finding came back. The second carries a
 * directive turning that finding off, and the stand-in's refusal comes back
 * only when actionlint started the stand-in rather than ShellCheck itself.
 */
const CANARIES: readonly { readonly name: string; readonly workflow: string; readonly expected: string }[] = [
  { name: 'finding.yml', workflow: canaryWorkflow('echo $GITHUB_REF'), expected: 'SC2086' },
  {
    name: 'directive.yml',
    workflow: canaryWorkflow('# shellcheck disable=SC2086\necho $GITHUB_REF'),
    expected: 'A ShellCheck directive is refused',
  },
];

/**
 * `path` as one word of the command line actionlint splits `-shellcheck` into:
 * forward slashes, single-quoted. actionlint drops the backslashes of an
 * unquoted Windows path and then runs no ShellCheck at all.
 *
 * @throws When the path holds a single quote, which the quoting cannot carry
 */
function shellWord(path: string): string {
  if (path.includes("'")) {
    throw new Error(`${quote(path)} holds a single quote, so actionlint cannot be handed it as one word`);
  }
  return `'${path.replaceAll('\\', '/')}'`;
}

async function workflows(quick: boolean): Promise<string> {
  const actionlint = await binary('actionlint');
  const shellcheck = await binary('shellcheck');
  // actionlint runs ShellCheck through scripts/shellcheck.ts, which refuses a
  // directive in the script ShellCheck reads. -pyflakes= because no Windows
  // package manager ships pyflakes, and actionlint skips that pass without a
  // word when it is missing.
  const standIn = [BUN, NO_ENV_FILE, join(import.meta.dir, 'shellcheck.ts'), shellcheck]
    .map((path) => shellWord(path))
    .join(' ');
  const analyzers = [`-shellcheck=${standIn}`, '-pyflakes='];

  const dir = await mkdtemp(join(tmpdir(), 'actionlint-canary-'));
  try {
    for (const canary of CANARIES) {
      const path = join(dir, canary.name);
      await Bun.write(path, canary.workflow);
      const finished = await run([actionlint, ...analyzers, path]);
      if (finished.exitCode !== 1) {
        throw new Error(
          `actionlint over the ${canary.name} canary ${describe(finished)}, and a canary's one finding exits 1`,
        );
      }
      if (!plain(finished.stdout).includes(canary.expected)) {
        throw new Error(
          `actionlint reported no ${quote(canary.expected)} over the ${canary.name} canary, so the wiring through scripts/shellcheck.ts is unproven. It ${describe(finished)}`,
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // The workflows are named, so actionlint needs no .git to find them, and
  // -verbose makes it name each file it finished. A committed actionlint
  // config is refused before any row, so none silences a finding here.
  const workflowFiles = await trackedFiles(':(glob).github/workflows/*.yml', ':(glob).github/workflows/*.yaml');
  if (workflowFiles.length === 0) {
    throw new Error('no workflow is tracked under .github/workflows, so the row checks nothing');
  }
  for (const batch of batches(workflowFiles)) {
    const finished = await run([actionlint, '-verbose', ...analyzers, '--', ...batch]);
    const report = { ...finished, stderr: finished.stderr.replace(/^verbose:.*\r?\n?/gm, '') };
    if (finished.exitCode !== 0) {
      throw new Error(`actionlint ${describe(report)}`);
    }
    const linted = actionlintFinished(finished.stderr);
    const unlinted = batch.filter((path) => !linted.has(path));
    if (unlinted.length > 0) {
      throw new Error(
        `actionlint finished no lint of ${unlinted.map((path) => quote(path)).join(', ')}: ${describe(report)}`,
      );
    }
  }

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
  const token = quick || process.env['ZIZMOR_OFFLINE'] !== undefined ? undefined : await githubToken('gh');
  const online = token !== undefined;
  const mode = online ? [] : ['--offline'];
  const env: Readonly<Record<string, string>> = online ? { GH_TOKEN: token, RUST_LOG: 'info' } : { RUST_LOG: 'info' };
  const audited = await expectClean(
    `zizmor (${online ? 'online' : 'offline'})`,
    [
      await binary('zizmor'),
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
  const completed = zizmorCompleted(audited.stderr);
  const unaudited = workflowFiles.filter((path) => !completed.has(path));
  if (completed.size === 0 || unaudited.length > 0) {
    throw new Error(
      `zizmor completed ${files(completed.size)}, and these tracked workflows were not among them: ${unaudited.map((path) => quote(path)).join(', ') || 'none'}`,
    );
  }
  const held = await inheritedCallsHeld(await binary('zizmor'));
  return `${files(workflowFiles.length)}, zizmor ${online ? 'online' : 'offline'} over ${files(completed.size)}, ${String(held)} secrets-inherit ${held === 1 ? 'call' : 'calls'} held`;
}

/** What a job that passes `secrets: inherit` may call: a reusable workflow of zachthedev/.github. */
const INHERIT_CALLEE = 'zachthedev/.github/.github/workflows/';

/**
 * The files the committed zizmor.yml's `secrets-inherit` rule waives, or none
 * when it names no such rule.
 *
 * @throws When the config does not parse, or the list holds anything but strings
 */
async function inheritWaivers(): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(await Bun.file(ZIZMOR_CONFIG).text());
  } catch (error: unknown) {
    throw new Error(
      `${ZIZMOR_CONFIG} does not parse as the gate reads YAML, so its secrets-inherit waivers are unknown: ${quote(error instanceof Error ? error.message : String(error))}`,
      { cause: error },
    );
  }
  const ignore = (parsed as { rules?: { 'secrets-inherit'?: { ignore?: unknown } } } | null)?.rules?.['secrets-inherit']
    ?.ignore;
  if (ignore === undefined) {
    return [];
  }
  if (!Array.isArray(ignore) || !ignore.every((entry) => typeof entry === 'string')) {
    throw new Error(`${ZIZMOR_CONFIG} rules.secrets-inherit.ignore is not a list of file names`);
  }
  return ignore;
}

/**
 * How many jobs pass `secrets: inherit`, each held to {@link INHERIT_CALLEE},
 * with a call in every file the committed zizmor.yml waives.
 *
 * @remarks
 * zizmor runs with no config and with inline ignore comments off, so it
 * reports every such job, waived or not. ZIZMOR_CONFIG would name a config
 * against --no-config, so it is removed. zizmor exits 10 to 14 when it reports
 * findings.
 *
 * @throws When zizmor fails, a job calls anything else, or a waived file holds no call
 */
async function inheritedCallsHeld(zizmor: string): Promise<number> {
  const finished = await run(
    [
      zizmor,
      '--no-progress',
      '--offline',
      '--no-config',
      '--no-ignores',
      '--strict-collection',
      '--format',
      'json',
      '--collect=all',
      '.github',
    ],
    { ZIZMOR_CONFIG: undefined },
  );
  if (finished.exitCode !== 0 && (finished.exitCode < 10 || finished.exitCode > 14)) {
    throw new Error(`zizmor with no config ${describe(finished)}`);
  }
  let calls: ReturnType<typeof inheritedCalls>;
  try {
    calls = inheritedCalls(finished.stdout);
  } catch (error: unknown) {
    throw new Error(
      `zizmor with no config: ${error instanceof Error ? error.message : String(error)}. It ${describe(finished)}`,
      { cause: error },
    );
  }
  const refused = inheritedCallFindings(calls, [INHERIT_CALLEE], await inheritWaivers());
  if (refused.length > 0) {
    throw new Error(refused.join('\n'));
  }
  return calls.length;
}

/* ///// test ///// */

/** The one vitest config, named so vitest searches for no other. */
const VITEST_CONFIG = 'vitest.config.mts';

/**
 * How many skipped or todo tests the test row lets through. vitest reports a
 * test a name filter left out as skipped, so a skip is the only sign of a
 * filtered run it gives, and the suite holds no skipped or todo test.
 */
const VITEST_SKIPS_ALLOWED = 0;

/**
 * What a finished vitest run counted, for the test row's line.
 *
 * @remarks
 * vitest exits 1 when it finds no test file, and 0 when every test it ran was
 * skipped or left to do. It reports a test a name filter left out as skipped.
 * So the row reads the summary's `Tests` line.
 *
 * @param allowed - How many skipped or todo tests pass, {@link VITEST_SKIPS_ALLOWED} for the row
 * @throws When the run counted no test, skipped or left to do every one, or
 * skipped or left to do more than `allowed`
 */
export function vitestCount(finished: Finished, allowed: number = VITEST_SKIPS_ALLOWED): string {
  const printed = plain(`${finished.stdout}\n${finished.stderr}`);
  const tests = /^\s*Tests\s+(.*)\((\d+)\)\s*$/m.exec(printed);
  const total = Number(tests?.[2] ?? 0);
  if (total === 0) {
    throw new Error(`vitest counted no test, so the row checks nothing: ${describe(finished)}`);
  }
  const counted = (label: string): number => Number(new RegExp(`(\\d+) ${label}`).exec(tests?.[1] ?? '')?.[1] ?? 0);
  const skipped = counted('skipped') + counted('todo');
  if (skipped >= total) {
    throw new Error(`vitest skipped every one of its ${String(total)} tests, so the row checks nothing`);
  }
  if (skipped > allowed) {
    throw new Error(
      `vitest skipped or left to do ${String(skipped)} of its ${String(total)} tests, past the ${String(allowed)} the row allows, and it reports a test a name filter left out as skipped`,
    );
  }
  const testFiles = Number(/^\s*Test Files\s+.*\((\d+)\)\s*$/m.exec(printed)?.[1] ?? 0);
  const skip = skipped > 0 ? `, ${String(skipped)} skipped` : '';
  return `${String(total)} ${total === 1 ? 'test' : 'tests'} across ${files(testFiles)}${skip}`;
}

// vitest with its config named, because vitest reads a vitest.config.ts ahead
// of vitest.config.mts, and a vite.config.* after both. CI=true makes vitest
// refuse `.only`, which would otherwise run alone and report the rest as
// skipped. Deviates from the handbook's kickstart: the Bun kickstart's test row
// runs bun test. The Worker's tests run inside workerd through
// @cloudflare/vitest-plugin, which runs under vitest alone, so vitest starts
// through `bun x`.
async function test(): Promise<string> {
  const finished = await run([...jsTool('vitest'), 'run', '--coverage', '--config', VITEST_CONFIG], {
    ...loopbackUnproxied(),
    ...TEST_ENV,
  });
  // The report and the coverage table print above the row's line, so they
  // land in the log rather than in its one-line message.
  console.log(printable([finished.stdout, finished.stderr].join('\n').trim()));
  if (finished.exitCode !== 0) {
    throw new Error(`vitest run --coverage exited ${String(finished.exitCode)}. The report is above`);
  }
  return vitestCount(finished);
}

/* ///// The rows ///// */

// The rows that run the repository's own code come last: cf-typegen:check
// runs any build command wrangler.jsonc names, lint runs eslint.config.ts,
// and the two test rows run the tests and vitest.config.mts. So every row that
// reads a config runs before any code could write one.
export const rows: readonly Row[] = [
  {
    name: 'tools',
    checks: 'mise.toml and mise.lock against scripts/tools.ts, then the install',
    check: tools,
  },
  {
    name: 'typecheck',
    checks:
      'tsc --version reporting the major package.json pins, then tsc --noEmit over src, tests and scripts, one --project each, counting the files each read, and every tracked TypeScript file read by one',
    check: typecheck,
  },
  {
    name: 'format',
    checks:
      'prettier --check over every tracked file Prettier formats, with .prettierrc and .prettierignore alone and no .editorconfig, and no Prettier ignore comment in any of them',
    check: format,
  },
  {
    name: 'toml',
    checks: 'taplo fmt --check over every tracked TOML file, each one proven checked',
    check: toml,
  },
  {
    name: 'workflows',
    checks:
      'actionlint over every tracked workflow with ShellCheck behind a stand-in that refuses its directives, both proven by a canary, each workflow proven linted, then zizmor over .github with nothing ignored and each workflow proven audited, online in check when gh has a token and offline otherwise, then every job passing secrets: inherit held to a reusable workflow of zachthedev/.github',
    check: workflows,
  },
  {
    name: 'cf-typegen:check',
    checks: 'worker-configuration.d.ts, tracked, regenerated from scratch matches the index',
    check: cfTypegen,
    runsCode: true,
  },
  {
    name: 'lint',
    checks:
      'eslint over the tree with eslint.config.ts alone and no warnings allowed, counting the files it linted, and no gate/visible-reason report a directive suppressed',
    check: lint,
    runsCode: true,
  },
  {
    name: 'scripts:test',
    checks:
      "bun test over the gate's own scripts/*.test.ts, every program they start a stand-in, counting the tests and failing when every one was skipped",
    check: scriptsTest,
    runsCode: true,
  },
  {
    name: 'test',
    checks:
      'vitest run --coverage with vitest.config.mts, counting the tests and failing when every one was skipped, left out by check:quick',
    check: test,
    slow: true,
    runsCode: true,
  },
];

/* ///// The run ///// */

const color = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
const dim = (text: string): string => (color ? styleText('dim', text) : text);
const glyph = (ok: boolean): string => (color ? styleText(ok ? 'green' : 'red', ok ? '✓' : '✗') : ok ? '✓' : '✗');
const width = Math.max(...rows.map((row) => row.name.length));
const seconds = (started: number): string => `${((performance.now() - started) / 1000).toFixed(1)}s`;

/** One row's result line: its glyph, its name, its time, and its note when it has one. */
function resultLine(ok: boolean, row: Row, started: number, note?: string): string {
  return `  ${glyph(ok)} ${row.name.padEnd(width)}  ${dim(seconds(started))}${note === undefined ? '' : `  ${dim(printable(note))}`}`;
}

/** The flags the gate takes. Any other argument that starts with `--` is refused. */
const FLAGS: readonly string[] = ['--quick', '--rows'];

/** What a run's arguments ask for. */
export interface Selection {
  /** The rows to run, in the table's order. */
  readonly rows: readonly Row[];
  /** `--quick`: an unnamed run leaves the slow rows out, and the workflows row runs zizmor offline. */
  readonly quick: boolean;
  /** Whether the arguments named rows, rather than asking for the gate or its quick form. */
  readonly named: boolean;
  /** `--rows`: print the rows and run nothing. */
  readonly list: boolean;
}

/**
 * What a run's arguments ask for, or the refusal it prints when an argument
 * is neither a row's name nor a flag the gate takes.
 *
 * @remarks
 * Every argument is read here and nowhere else. Named rows run in the table's
 * order, slow or not. With no name, `--quick` leaves the slow rows out. One
 * unknown name or flag refuses the whole run, so a mistyped name never selects
 * nothing and reads as a green gate, and a mistyped flag never runs the whole
 * gate in place of what it asked for.
 *
 * @param args - The arguments after the script's path
 */
export function selectRows(args: readonly string[]): Selection | { readonly refusal: string } {
  const flags = args.filter((argument) => argument.startsWith('--'));
  const names = args.filter((argument) => !argument.startsWith('--'));
  const unknownFlags = flags.filter((flag) => !FLAGS.includes(flag));
  const unknownNames = names.filter((name) => !rows.some((row) => row.name === name));
  const refusals = [
    ...(unknownFlags.length > 0
      ? [
          `no such flag: ${printable(unknownFlags.map((flag) => quote(flag)).join(', '))}. The gate takes ${FLAGS.join(' and ')}.`,
        ]
      : []),
    ...(unknownNames.length > 0
      ? [
          `no such row: ${printable(unknownNames.map((name) => quote(name)).join(', '))}. bun run check:rows lists them.`,
        ]
      : []),
  ];
  if (refusals.length > 0) {
    return { refusal: refusals.join(' ') };
  }
  const quick = flags.includes('--quick');
  return {
    rows: rows.filter((row) => (names.length > 0 ? names.includes(row.name) : !quick || row.slow !== true)),
    quick,
    named: names.length > 0,
    list: flags.includes('--rows'),
  };
}

/**
 * Runs the gate over `args` and returns the process's exit code.
 *
 * @remarks
 * A named run says so in its first and last lines, so its output never reads
 * as a whole gate that passed.
 *
 * @param args - The arguments after the script's path
 */
export async function main(args: readonly string[]): Promise<number> {
  const selection = selectRows(args);
  if ('refusal' in selection) {
    console.error(selection.refusal);
    return 1;
  }
  if (selection.list) {
    console.log(dim('rows'));
    console.log();
    for (const row of rows) {
      console.log(`  ${row.name.padEnd(width)}  ${row.checks}`);
    }
    return 0;
  }

  const { quick, named } = selection;
  const selected = selection.rows;
  const form = quick ? 'check:quick' : 'check';
  console.log(dim(named ? `${form}: ${selected.map((row) => row.name).join(', ')}` : form));
  console.log();

  // The preflight refuses a config a row's tool would read in place of the one
  // the row names, so no row runs beside one. It comes before any other
  // process the gate starts but git, and a single row run passes through it
  // too. A row that runs the repository's code can write any file the
  // preflight reads, so the preflight runs again after one, before any later
  // row.
  const preflight = async (after: string): Promise<boolean> => {
    const refused = [...(await trackedFindings()), ...(await startupFindings())];
    if (refused.length > 0) {
      console.log(`  ${glyph(false)} ${'preflight'.padEnd(width)}  ${dim(after)}`);
      console.log(`    ${printable(refused.join('\n')).split('\n').join('\n    ')}`);
    }
    return refused.length === 0;
  };
  if (!(await preflight('no row ran'))) {
    return 1;
  }
  for (const [index, row] of selected.entries()) {
    const started = performance.now();
    try {
      const note = await row.check(quick);
      console.log(resultLine(true, row, started, note));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(resultLine(false, row, started));
      console.log(`    ${printable(message).split('\n').join('\n    ')}`);
      console.log(`  ${dim('─'.repeat(width + 12))}`);
      console.log(`  ${row.name} failed, and the rows after it did not run`);
      return 1;
    }
    if (
      row.runsCode === true &&
      index < selected.length - 1 &&
      !(await preflight(`after ${row.name}, no later row ran`))
    ) {
      return 1;
    }
  }
  console.log(`  ${dim('─'.repeat(width + 12))}`);
  console.log(
    named
      ? `  ${String(selected.length)} of ${String(rows.length)} rows ran and passed`
      : `  ${String(selected.length)} checks passed`,
  );
  return 0;
}

// Run as a file, the gate runs. Imported, as scripts/check.test.ts does, it
// runs nothing and hands over its rows.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
