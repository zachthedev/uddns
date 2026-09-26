// This repository's own cases for scripts/check.ts: the command line each row
// starts, the NO_PROXY the workerd rows get, and the cf-typegen:check row's
// order and restore. run() and git() are swapped for recorders before
// check.ts loads, so no case starts a program: nothing reaches gh, git, mise,
// wrangler, workerd or the network.

import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Row } from './check';
import type { Finished, RunOptions } from './run';
import * as runModule from './run';
import { isolate, spellings, StandIns } from './stand-ins';
import * as toolsModule from './tools';

/* ///// The recorder, in place before check.ts loads ///// */

/** One call check.ts made to run(). */
interface Call {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly options: RunOptions;
  /** Whether the types file existed when the call was made. */
  readonly typesPresent: boolean;
}

/** How a call ends: the fields that differ from exit 0 with no output. */
type Answer = Partial<Finished>;

/** The file the cf-typegen:check row regenerates. */
const TYPES = 'worker-configuration.d.ts';

let calls: Call[] = [];
let answer: (cmd: readonly string[]) => Answer = () => ({});

function recorder(
  cmd: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  options: RunOptions = {},
): Promise<Finished> {
  calls.push({ cmd: [...cmd], env: { ...env }, options: { ...options }, typesPresent: existsSync(TYPES) });
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', heldOpen: false, ...answer(cmd) });
}

/** git() as the recorder sees it: `git` and its arguments, inheriting nothing. */
function gitRecorder(args: readonly string[]): Promise<Finished> {
  return recorder(['git', ...args], {}, { inherit: false });
}

// Copied before the mocks replace them in place, so afterAll can put them
// back for the test files that run after this one in the same process.
const REAL_RUN = { ...runModule };
const REAL_TOOLS = { ...toolsModule };

let standIns: StandIns;
let installs = 0;
let resolves = 0;

/** True while a case wants the tools row to resolve ShellCheck under a directory named with a single quote. */
let quotedShellcheck = false;

/** The path the mocked tools row resolves for `key`, which no case starts. */
function binaryPath(key: string): string {
  return key === 'shellcheck' && quotedShellcheck ? join(standIns.dir, "it's", key) : join(standIns.dir, key);
}

await mock.module('./run', () => ({ ...REAL_RUN, run: recorder, git: gitRecorder }));
await mock.module('./tools', () => ({
  ...REAL_TOOLS,
  install: (): Promise<void> => {
    installs += 1;
    return Promise.resolve();
  },
  resolve: (): Promise<ReadonlyMap<string, string>> => {
    resolves += 1;
    return Promise.resolve(new Map(REAL_TOOLS.TOOLS.map((tool) => [tool.key, binaryPath(tool.key)])));
  },
}));

// The root check.ts loads from, whose scripts/ holds the ShellCheck stand-in.
const ROOT = process.cwd();
const check = await import('./check');

/* ///// The fixture ///// */

let restore: () => void;
let home: string;
let cwd: string;

beforeAll(async () => {
  standIns = new StandIns(['gh', 'git', 'mise']);
  home = process.cwd();
  // The rows after tools read the paths it resolves.
  await row('tools').check(false);
});

afterAll(async () => {
  await mock.module('./run', () => REAL_RUN);
  await mock.module('./tools', () => REAL_TOOLS);
  standIns.remove();
});

beforeEach(() => {
  restore = isolate(standIns);
  calls = [];
  answer = passing;
  cwd = mkdtempSync(join(tmpdir(), 'gate-check-'));
  process.chdir(cwd);
  plantInstall();
});

afterEach(() => {
  process.chdir(home);
  rmSync(cwd, { recursive: true, force: true });
  restore();
});

/** The row named `name`. */
function row(name: string): Row {
  const found = check.rows.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`fixture: check.ts has no row ${name}`);
  }
  return found;
}

/** What running `work` ended with: `passed`, or the message it threw. */
async function outcome(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'passed';
}

/** The tracked files the fixture tree holds, each written to the working directory by {@link plantTree}. */
const TRACKED: readonly string[] = ['README.md', 'src/a.ts', 'config.toml', '.github/workflows/ci.yml'];

/** The tracked workflows, which the workflows row reads. */
const WORKFLOWS: readonly string[] = ['.github/workflows/ci.yml'];

/**
 * Writes every {@link TRACKED} file into the working directory, and the zizmor
 * config whose secrets-inherit waiver names each file {@link INHERITED} reports.
 */
function plantTree(): void {
  for (const path of TRACKED) {
    // Bun's mkdirSync refuses '.' even with recursive set.
    if (dirname(path) !== '.') {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, path.endsWith('.md') ? '# Title\n' : 'x\n');
  }
  writeFileSync('.github/zizmor.yml', 'rules:\n  secrets-inherit:\n    ignore:\n      - cd.yml\n      - deps.yml\n');
}

/** The JavaScript tools the rows start through bunx. */
const JS_TOOLS: readonly string[] = ['tsc', 'prettier', 'eslint', 'wrangler', 'vitest'];

/**
 * Writes what a checkout's install leaves for the rows into the working
 * directory: a regular file for each of {@link JS_TOOLS} under
 * node_modules/.bin, in the Windows and the other spelling, and a package.json
 * naming the native compiler at major 7.
 */
function plantInstall(): void {
  mkdirSync(join('node_modules', '.bin'), { recursive: true });
  for (const name of JS_TOOLS) {
    writeFileSync(join('node_modules', '.bin', name), '');
    writeFileSync(join('node_modules', '.bin', `${name}.exe`), '');
  }
  writeFileSync('package.json', JSON.stringify({ devDependencies: { '@typescript/native': 'npm:typescript@7.9.4' } }));
}

/** How every JavaScript tool a row runs starts: the gate Bun running bunx. */
const BUNX: readonly string[] = [process.execPath, 'x', '--bun', '--no-install'];

/** The JavaScript tool `cmd` starts through {@link BUNX}, or undefined. */
function tool(cmd: readonly string[]): string | undefined {
  return BUNX.every((word, index) => cmd[index] === word) ? cmd[BUNX.length] : undefined;
}

/** zizmor's report of one job passing secrets: inherit in each file the held zizmor.yml waives. */
const INHERITED = ['cd.yml', 'deps.yml'].map((name) => ({
  ident: 'secrets-inherit',
  locations: [
    {
      symbolic: { kind: 'Primary', key: { Local: { verbatim_path: `.github/workflows/${name}` } } },
      concrete: {
        feature: `zachthedev/.github/.github/workflows/${name}@c53d09e393028ceddee0d761f2a7963394289a72`,
        location: { start_point: { row: 9 } },
      },
    },
  ],
}));

/** The files a command hands its tool after `--`. */
function handed(cmd: readonly string[]): readonly string[] {
  return cmd.slice(cmd.indexOf('--') + 1);
}

/** The answer that lets every row pass over the {@link TRACKED} tree. */
function passing(cmd: readonly string[]): Answer {
  const [program = '', ...args] = cmd;
  if (program === 'git' && args[0] === 'ls-files') {
    const listed = args.some((arg) => arg.startsWith(':(glob).github/workflows/')) ? WORKFLOWS : TRACKED;
    return { stdout: args.includes('--error-unmatch') ? `${TYPES}\n` : listed.map((path) => `${path}\0`).join('') };
  }
  if (program === 'gh') {
    return { exitCode: 1 };
  }
  if (program === process.execPath && args[1] === 'test') {
    return { stderr: ' 3 pass\n 0 fail\nRan 3 tests across 1 file.\n' };
  }
  switch (tool(cmd)) {
    case 'tsc':
      return cmd.includes('--version')
        ? { stdout: 'Version 7.9.4\n' }
        : { stdout: `${resolve('src/a.ts').replaceAll('\\', '/')}\n` };
    case 'eslint':
      return { stdout: JSON.stringify([{ filePath: resolve('src/a.ts'), messages: [] }]) };
    case 'vitest':
      return { stdout: ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n' };
    default:
      break;
  }
  if (program === binaryPath('taplo')) {
    return {
      stderr: `found files total=1 excluded=0 files=[${handed(cmd)
        .map((path) => JSON.stringify(path))
        .join(', ')}]`,
    };
  }
  if (program === binaryPath('actionlint')) {
    if (args.includes('-verbose')) {
      return {
        stderr: handed(cmd)
          .map((path) => `verbose: Found total 0 errors in 1 ms for ${path}\n`)
          .join(''),
      };
    }
    // Each canary comes back with the one finding the row requires of it.
    return (args.at(-1) ?? '').endsWith('directive.yml')
      ? {
          exitCode: 1,
          stdout:
            'directive.yml:8:9: shellcheck reported issue in this script: SC0:error:1:1: A ShellCheck directive is refused',
        }
      : { exitCode: 1, stdout: 'finding.yml:8:9: shellcheck reported issue in this script: SC2086:info:2:6' };
  }
  if (program === binaryPath('zizmor')) {
    return args.includes('--no-config')
      ? { exitCode: 13, stdout: JSON.stringify(INHERITED) }
      : { stderr: WORKFLOWS.map((path) => `completed ${path}\n`).join('') };
  }
  return {};
}

/** The recorded calls to the program `program`, by name or path. */
function callsTo(program: string): Call[] {
  return calls.filter((call) => call.cmd[0] === program);
}

/** The recorded calls that start the JavaScript tool `name` through bunx. */
function callsToTool(name: string): Call[] {
  return calls.filter((call) => tool(call.cmd) === name);
}

/** The value after `flag` in `cmd`, or undefined. */
function after(cmd: readonly string[], flag: string): string | undefined {
  const at = cmd.indexOf(flag);
  return at < 0 ? undefined : cmd[at + 1];
}

/* ///// loopbackUnproxied() ///// */

interface ProxyCase {
  readonly label: string;
  readonly set: Readonly<Record<string, string>>;
  readonly expected: string;
}

const LOOPBACK = 'localhost,127.0.0.1,::1';

const PROXY_CASES: readonly ProxyCase[] = [
  { label: 'neither spelling set', set: {}, expected: LOOPBACK },
  { label: 'NO_PROXY alone', set: { NO_PROXY: 'a.example' }, expected: `a.example,${LOOPBACK}` },
  { label: 'no_proxy alone', set: { no_proxy: 'b.example' }, expected: `b.example,${LOOPBACK}` },
  {
    label: 'both spellings, one value',
    set: { NO_PROXY: 'c.example', no_proxy: 'c.example' },
    expected: `c.example,${LOOPBACK}`,
  },
  { label: 'an empty value', set: { NO_PROXY: '' }, expected: LOOPBACK },
  { label: 'a star', set: { NO_PROXY: '*' }, expected: `*,${LOOPBACK}` },
  { label: 'a list that is one loopback name', set: { NO_PROXY: 'localhost' }, expected: LOOPBACK },
  {
    label: 'a list that embeds a loopback name, compared as a whole value',
    set: { NO_PROXY: 'localhost,d.example' },
    expected: `localhost,d.example,${LOOPBACK}`,
  },
];

test.each([...PROXY_CASES])('loopbackUnproxied: $label', ({ set, expected }: ProxyCase) => {
  for (const [name, value] of Object.entries(set)) {
    process.env[name] = value;
  }

  expect(check.loopbackUnproxied()).toEqual({ NO_PROXY: expected });
});

test('loopbackUnproxied: two spellings with different values keep what the environment reads under each', () => {
  process.env['NO_PROXY'] = 'u.example';
  process.env['no_proxy'] = 'l.example';
  // Where names ignore case, the second write replaced the first.
  const expected =
    process.env['NO_PROXY'] === 'l.example' ? `l.example,${LOOPBACK}` : `u.example,l.example,${LOOPBACK}`;

  expect(check.loopbackUnproxied()).toEqual({ NO_PROXY: expected });
});

/* ///// Every row's command line ///// */

/** Every row but tools, which the mock replaces, run once over the tree in the full form. */
async function runEveryRow(): Promise<void> {
  plantTree();
  writeFileSync(TYPES, 'x\n');
  for (const each of check.rows.filter((candidate) => candidate.name !== 'tools')) {
    expect(`${each.name}: ${await outcome(() => each.check(false))}`).toBe(`${each.name}: passed`);
  }
}

const PACKAGE_ROWS: readonly (readonly [string, string])[] = [
  ['typecheck', 'tsc'],
  ['cf-typegen:check', 'wrangler'],
  ['format', 'prettier'],
  ['lint', 'eslint'],
  ['test', 'vitest'],
];

test.each([...PACKAGE_ROWS])(
  '%s starts %s through bun x --bun --no-install under the gate Bun',
  async (name: string, expected: string) => {
    plantTree();
    writeFileSync(TYPES, 'x\n');

    await row(name).check(false);

    const started = calls.filter((call) => call.cmd[0] === process.execPath);
    expect(started.length).toBeGreaterThan(0);
    for (const call of started) {
      expect(call.cmd.slice(0, BUNX.length + 1)).toEqual([...BUNX, expected]);
    }
  },
);

/** Removes both spellings of `name` from the working directory's node_modules/.bin. */
function uninstall(name: string): void {
  rmSync(join('node_modules', '.bin', name));
  rmSync(join('node_modules', '.bin', `${name}.exe`));
}

/** The refusal a row gives when node_modules/.bin lacks `name`, naming the install to run. */
function notInstalled(name: string): string {
  return `${name} is not installed in this checkout: run bun install --frozen-lockfile, or bun install --frozen-lockfile --ignore-scripts in a worktree (CONTRIBUTING.md#setup).`;
}

// bunx runs a copy from a parent directory, PATH or its own cache when the
// checkout's node_modules/.bin lacks the tool, so each row refuses before it
// starts one.
test.each([...PACKAGE_ROWS])(
  '%s refuses before it starts anything when node_modules/.bin lacks %s',
  async (name: string, missing: string) => {
    plantTree();
    writeFileSync(TYPES, 'x\n');
    uninstall(missing);

    expect(await outcome(() => row(name).check(false))).toBe(notInstalled(missing));
    expect(callsToTool(missing)).toEqual([]);
  },
);

test('no row starts a program through bun run or node, or by a name other than git and gh', async () => {
  await runEveryRow();

  for (const call of calls) {
    const [program = ''] = call.cmd;
    expect(isAbsolute(program) || program === 'git' || program === 'gh').toBe(true);
    if (program === process.execPath) {
      // A direct start carries no env file, and every other Bun start is bunx with its two flags.
      expect(call.cmd[1] === '--no-env-file' || tool(call.cmd) !== undefined).toBe(true);
      expect(call.cmd.slice(1, 3)).not.toContain('run');
    }
  }
});

test('scripts:test runs bun test over scripts/ with the gate Bun and no env file', async () => {
  await row('scripts:test').check(false);

  expect(calls.map((call) => call.cmd)).toEqual([[process.execPath, '--no-env-file', 'test', './scripts/']]);
});

test('typecheck names each project with --project, one tsc pass each, in order', async () => {
  plantTree();

  await row('typecheck').check(false);

  const passes = callsToTool('tsc').filter((call) => call.cmd.includes('--listFiles'));
  expect(passes.map((call) => after(call.cmd, '--project'))).toEqual([...check.PROJECTS]);
  for (const call of passes) {
    expect(call.cmd).toContain('--noEmit');
    expect(call.cmd).toContain('--listFiles');
  }
});

test('lint names eslint.config.ts and allows no warning', async () => {
  plantTree();

  await row('lint').check(false);

  const [call] = callsToTool('eslint');
  expect(after(call?.cmd ?? [], '--config')).toBe('eslint.config.ts');
  expect(call?.cmd).toContain('--max-warnings=0');
  expect(after(call?.cmd ?? [], '--format')).toBe('json');
});

/* ///// lint and the rule no directive may waive ///// */

/** One report as ESLint's json formatter lists it: `ruleId` at `line`, column 1. */
interface Report {
  readonly ruleId: string;
  readonly severity: number;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** The report `ruleId` gives at `line`. */
function report(ruleId: string, line: number): Report {
  return { ruleId, severity: 2, message: `${ruleId} reported here`, line, column: 1 };
}

/** The answer for every call but ESLint's, which reports `suppressed` against src/a.ts and nothing else. */
function suppressing(suppressed: readonly Report[]): (cmd: readonly string[]) => Answer {
  return (cmd: readonly string[]): Answer =>
    tool(cmd) === 'eslint'
      ? { stdout: JSON.stringify([{ filePath: resolve('src/a.ts'), messages: [], suppressedMessages: suppressed }]) }
      : passing(cmd);
}

interface SuppressedCase {
  readonly label: string;
  readonly suppressed: readonly Report[];
  /** The lines of src/a.ts where a directive suppressed gate/visible-reason. */
  readonly lines: readonly number[];
}

// ESLint applies a directive to the problems at its own position, so a
// directive naming gate/visible-reason suppresses that rule's report on the
// directive itself: the -line form on its own line, and a block disable on
// every line up to its enable. ESLint still lists each suppressed report, so
// the row refuses one there, naming the file and the line.
const SUPPRESSED_CASES: readonly SuppressedCase[] = [
  {
    label: 'a -line directive naming the rule beside the one it waives',
    suppressed: [report('no-debugger', 1), report('gate/visible-reason', 1)],
    lines: [1],
  },
  {
    label: 'a block disable of the rule, closed by its enable',
    suppressed: [report('gate/visible-reason', 1), report('gate/visible-reason', 2), report('no-debugger', 3)],
    lines: [1, 2],
  },
];

test.each([...SUPPRESSED_CASES])('lint refuses $label', async ({ suppressed, lines }: SuppressedCase) => {
  plantTree();
  answer = suppressing(suppressed);

  const message = await outcome(() => row('lint').check(false));

  expect(message).toStartWith(
    `eslint reported ${String(lines.length)} gate/visible-reason ${lines.length === 1 ? 'problem' : 'problems'} a directive suppressed`,
  );
  for (const line of lines) {
    expect(message).toContain(
      `${JSON.stringify(resolve('src/a.ts'))}:${String(line)}:1  a directive suppresses gate/visible-reason here`,
    );
  }
  expect(message).not.toContain('no-debugger reported here');
});

test('lint passes a report of another rule a directive suppressed', async () => {
  plantTree();
  answer = suppressing([report('no-debugger', 3)]);

  expect(await outcome(() => row('lint').check(false))).toBe('passed');
});

test('format names .prettierrc and .prettierignore, reads no .editorconfig, and hands over the files Prettier formats', async () => {
  plantTree();

  await row('format').check(false);

  const [call] = callsToTool('prettier');
  const cmd = call?.cmd ?? [];
  expect(after(cmd, '--config')).toBe('.prettierrc');
  expect(after(cmd, '--ignore-path')).toBe('.prettierignore');
  expect(cmd).toContain('--no-editorconfig');
  expect([...handed(cmd)].sort()).toEqual(['.github/workflows/ci.yml', 'README.md', 'src/a.ts']);
});

test('toml names .taplo.toml, hands over the tracked TOML files, and asks for its found line', async () => {
  plantTree();

  await row('toml').check(false);

  const [call] = callsTo(binaryPath('taplo'));
  expect(call?.cmd).toEqual([binaryPath('taplo'), 'fmt', '--check', '--config', '.taplo.toml', '--', 'config.toml']);
  expect(call?.env['RUST_LOG']).toBe('info');
});

test('workflows in the quick form runs zizmor offline over .github with its config named, and asks gh nothing', async () => {
  plantTree();

  await row('workflows').check(true);

  const [call] = callsTo(binaryPath('zizmor'));
  const cmd = call?.cmd ?? [];
  expect(after(cmd, '--config')).toBe('.github/zizmor.yml');
  expect(cmd).toContain('--strict-collection');
  expect(cmd).toContain('--collect=all');
  expect(cmd).toContain('--offline');
  expect(cmd.at(-1)).toBe('.github');
  expect(callsTo('gh')).toEqual([]);
});

test('workflows in the full form runs zizmor offline when gh answers with no token', async () => {
  plantTree();

  await row('workflows').check(false);

  expect(callsTo('gh').map((call) => call.cmd)).toEqual([['gh', 'auth', 'token']]);
  expect(callsTo(binaryPath('zizmor'))[0]?.cmd).toContain('--offline');
});

test('workflows in the full form runs zizmor online with the token gh answers, handed to zizmor alone', async () => {
  plantTree();
  const base = passing;
  answer = (cmd: readonly string[]): Answer => (cmd[0] === 'gh' ? { stdout: 'canary-token\n' } : base(cmd));

  await row('workflows').check(false);

  const [call] = callsTo(binaryPath('zizmor'));
  expect(call?.cmd).not.toContain('--offline');
  expect(call?.env['GH_TOKEN']).toBe('canary-token');
  for (const other of calls.filter((each) => each !== call)) {
    expect(Object.values(other.env)).not.toContain('canary-token');
  }
  // Every row's processes inherit the gate's own environment, so it must not carry the token either.
  expect(Object.values(process.env)).not.toContain('canary-token');
});

test.each([
  ['cf-typegen:check', 'wrangler'],
  ['test', 'vitest'],
])('%s hands %s one NO_PROXY spelling, carrying the gate list and loopback', async (name: string, started: string) => {
  plantTree();
  writeFileSync(TYPES, 'x\n');
  process.env['NO_PROXY'] = 'a.example';

  await row(name).check(false);

  const [call] = callsToTool(started);
  expect(spellings(call?.env ?? {}, 'NO_PROXY')).toEqual(['NO_PROXY']);
  expect(call?.env['NO_PROXY']).toBe(`a.example,${LOOPBACK}`);
});

test('the test row runs vitest run --coverage', async () => {
  await row('test').check(false);

  const [call] = callsToTool('vitest');
  expect(call?.cmd.slice(BUNX.length + 1, BUNX.length + 3)).toEqual(['run', '--coverage']);
});

test.each([
  ['format', 'no tracked file is one Prettier formats, so the row checks nothing'],
  ['toml', 'no TOML file is tracked, so the row checks nothing'],
  ['workflows', 'no workflow is tracked under .github/workflows, so the row checks nothing'],
])('%s fails when git lists no file for it', async (name: string, message: string) => {
  answer = (cmd: readonly string[]): Answer => (cmd[0] === 'git' ? { stdout: '' } : passing(cmd));

  expect(await outcome(() => row(name).check(true))).toBe(message);
});

/* ///// cf-typegen:check ///// */

/** The answer for the row's git and wrangler calls, each exit 0 unless `overrides` names it. */
function typegen(overrides: { readonly listed?: Answer; readonly wrangler?: Answer; readonly restore?: Answer }) {
  return (cmd: readonly string[]): Answer => {
    if (cmd.includes('--error-unmatch')) {
      return overrides.listed ?? {};
    }
    if (tool(cmd) === 'wrangler') {
      return overrides.wrangler ?? {};
    }
    if (cmd[0] === 'git' && cmd[1] === 'checkout') {
      return overrides.restore ?? {};
    }
    return {};
  };
}

/** What each recorded call was: the git subcommand, or the JavaScript tool. */
function steps(): string[] {
  return calls.map((call) =>
    call.cmd[0] === 'git' ? `git ${call.cmd[1] ?? ''}` : (tool(call.cmd) ?? call.cmd[0] ?? ''),
  );
}

test('cf-typegen:check asks git, removes the file, regenerates it, then diffs it, each git inheriting nothing', async () => {
  writeFileSync(TYPES, 'x\n');
  answer = typegen({});

  await check.cfTypegen();

  expect(calls.map((call) => call.cmd)).toEqual([
    ['git', 'ls-files', '--error-unmatch', '--', TYPES],
    [...BUNX, 'wrangler', 'types', '--config', 'wrangler.jsonc', '--env-file', '.dev.vars.template'],
    ['git', 'diff', '--no-ext-diff', '--exit-code', '--', TYPES],
  ]);
  expect(calls[1]?.typesPresent).toBe(false);
  // git() inherits nothing, so no GIT_DIR or GIT_INDEX_FILE a hook exports reaches git.
  for (const call of calls.filter((each) => each.cmd[0] === 'git')) {
    expect(call.options.inherit).toBe(false);
  }
});

test('cf-typegen:check refuses an untracked types file before it removes anything', async () => {
  writeFileSync(TYPES, 'x\n');
  answer = typegen({ listed: { exitCode: 1, stderr: `error: pathspec '${TYPES}' did not match` } });

  expect(await outcome(() => check.cfTypegen())).toStartWith(`${TYPES} is not tracked`);
  expect(existsSync(TYPES)).toBe(true);
  expect(steps()).toEqual(['git ls-files']);
});

test('cf-typegen:check restores the tracked file when wrangler fails, and diffs nothing', async () => {
  writeFileSync(TYPES, 'x\n');
  answer = typegen({ wrangler: { exitCode: 1, stderr: 'wrangler broke' } });

  expect(await outcome(() => check.cfTypegen())).toStartWith('wrangler types exited 1 saying: wrangler broke');
  expect(steps()).toEqual(['git ls-files', 'wrangler', 'git checkout']);
  expect(calls.at(-1)?.cmd).toEqual(['git', 'checkout', '--', TYPES]);
});

test('cf-typegen:check names both failures when the restore fails too', async () => {
  writeFileSync(TYPES, 'x\n');
  answer = typegen({ wrangler: { exitCode: 1 }, restore: { exitCode: 1, stderr: 'checkout broke' } });

  const message = await outcome(() => check.cfTypegen());

  expect(message).toStartWith('wrangler types exited 1');
  expect(message).toContain(`git could not restore ${TYPES}: it exited 1 saying: checkout broke`);
});

// A throw after the delete would leave the types file gone with nothing to put
// it back, so the row asks for wrangler first.
test('cf-typegen:check checks for wrangler before it deletes the types file', async () => {
  writeFileSync(TYPES, 'x\n');
  uninstall('wrangler');
  answer = typegen({});

  expect(await outcome(() => check.cfTypegen())).toBe(notInstalled('wrangler'));
  expect(existsSync(TYPES)).toBe(true);
  expect(steps()).toEqual(['git ls-files']);
});

test('the tools row installs through the tools module, once per run', () => {
  // beforeAll ran the row once.
  expect(installs).toBe(1);
});

/* ///// Which rows a run selects ///// */

/** Every row's name, in the table's order. */
const ALL_ROWS: readonly string[] = check.rows.map((each) => each.name);

/** What a run's arguments select, with each row by its name. */
interface Selected {
  readonly rows: readonly string[];
  readonly quick: boolean;
  readonly named: boolean;
  readonly list: boolean;
}

interface SelectCase {
  readonly label: string;
  /** The arguments after the script's path. */
  readonly args: readonly string[];
  /** The selection, or the whole refusal. */
  readonly expected: Selected | { readonly refusal: string };
}

// Named rows run in the table's order, slow or not, and one unknown name or
// flag refuses the whole run, so a mistyped name never selects nothing and
// reads as a green gate, and a mistyped flag never runs the whole gate in its
// place.
const SELECT_CASES: readonly SelectCase[] = [
  {
    label: 'no argument selects every row, in the table order',
    args: [],
    expected: { rows: ALL_ROWS, quick: false, named: false, list: false },
  },
  {
    label: '--quick leaves the test row out',
    args: ['--quick'],
    expected: { rows: ALL_ROWS.filter((name) => name !== 'test'), quick: true, named: false, list: false },
  },
  {
    label: 'one name selects that row alone',
    args: ['workflows'],
    expected: { rows: ['workflows'], quick: false, named: true, list: false },
  },
  {
    label: 'two names run in the table order, not the argument order',
    args: ['lint', 'format'],
    expected: { rows: ['format', 'lint'], quick: false, named: true, list: false },
  },
  {
    label: 'a named slow row runs under --quick',
    args: ['--quick', 'test'],
    expected: { rows: ['test'], quick: true, named: true, list: false },
  },
  {
    label: '--rows asks for the list',
    args: ['--rows'],
    expected: { rows: ALL_ROWS, quick: false, named: false, list: true },
  },
  {
    label: 'a misspelled --quick is refused',
    args: ['--quik'],
    expected: { refusal: 'no such flag: "--quik". The gate takes --quick and --rows.' },
  },
  {
    label: 'a misspelled --rows is refused',
    args: ['--row'],
    expected: { refusal: 'no such flag: "--row". The gate takes --quick and --rows.' },
  },
  {
    label: 'a row name written as a flag is refused',
    args: ['--typecheck'],
    expected: { refusal: 'no such flag: "--typecheck". The gate takes --quick and --rows.' },
  },
  {
    label: 'an unknown flag and an unknown name are refused together',
    args: ['--quik', 'nosuchrow'],
    expected: {
      refusal:
        'no such flag: "--quik". The gate takes --quick and --rows. no such row: "nosuchrow". bun run check:rows lists them.',
    },
  },
  {
    label: 'a name holding a C1 control sequence is refused with it escaped',
    args: ['\u009b31m'],
    expected: { refusal: 'no such row: "\\u009b31m". bun run check:rows lists them.' },
  },
  {
    label: 'an unknown name is refused',
    args: ['nosuchrow'],
    expected: { refusal: 'no such row: "nosuchrow". bun run check:rows lists them.' },
  },
  {
    label: 'one unknown name among known ones refuses the run, naming it alone',
    args: ['workflows', 'zizmor'],
    expected: { refusal: 'no such row: "zizmor". bun run check:rows lists them.' },
  },
  {
    label: 'a tool the workflows row runs, actionlint, names no row and is refused',
    args: ['actionlint'],
    expected: { refusal: 'no such row: "actionlint". bun run check:rows lists them.' },
  },
  {
    label: 'a tool the workflows row runs, zizmor, names no row and is refused',
    args: ['zizmor'],
    expected: { refusal: 'no such row: "zizmor". bun run check:rows lists them.' },
  },
  {
    label: 'the tool the toml row runs, taplo, names no row and is refused',
    args: ['taplo'],
    expected: { refusal: 'no such row: "taplo". bun run check:rows lists them.' },
  },
  {
    label: 'format:check, a package.json script that is not a row, is refused',
    args: ['format:check'],
    expected: { refusal: 'no such row: "format:check". bun run check:rows lists them.' },
  },
  {
    label: 'a name holding a newline is refused on one line, the newline escaped',
    args: ['a\nb'],
    expected: { refusal: 'no such row: "a\\nb". bun run check:rows lists them.' },
  },
];

test.each([...SELECT_CASES])('selectRows: $label', ({ args, expected }: SelectCase) => {
  const selection = check.selectRows(args);
  const selected: SelectCase['expected'] =
    'refusal' in selection
      ? { refusal: selection.refusal }
      : {
          rows: selection.rows.map((each) => each.name),
          quick: selection.quick,
          named: selection.named,
          list: selection.list,
        };

  expect(selected).toEqual(expected);
});

// The refusal keeps a mistyped row from reading as a green gate only while the
// process exits 1. It comes before the preflight, so the run starts nothing.
test('main refuses an unknown row with exit 1, the refusal alone on stderr, and nothing on stdout', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);
  const logs = spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const code = await check.main(['nosuchrow']);

    expect(code).toBe(1);
    expect(errors.mock.calls).toEqual([['no such row: "nosuchrow". bun run check:rows lists them.']]);
    expect(logs.mock.calls).toEqual([]);
    expect(calls).toEqual([]);
  } finally {
    errors.mockRestore();
    logs.mockRestore();
  }
});

/* ///// A single row's binaries ///// */

// A second copy of check.ts under its own specifier, so its binaries map
// starts empty, as in a `bun run check <row>` process that skips the tools
// row. The specifier is held in a variable, so tsc resolves no module from the
// query string.
const SINGLE_ROW_CHECK = './check.ts?single-row';

test('a single row run fills the binaries through tools.resolve once, and installs nothing', async () => {
  const single = (await import(SINGLE_ROW_CHECK)) as typeof check;
  const singleRow = (name: string): Row => {
    const found = single.rows.find((candidate) => candidate.name === name);
    if (found === undefined) {
      throw new Error(`fixture: the second check.ts has no row ${name}`);
    }
    return found;
  };
  // The case proves nothing unless the copy is its own module and still starts
  // every program through the recorder.
  expect(single.rows).not.toBe(check.rows);
  await singleRow('scripts:test').check(false);
  expect(calls.map((call) => call.cmd)).toEqual([[process.execPath, '--no-env-file', 'test', './scripts/']]);
  plantTree();
  calls = [];
  const before = { installs, resolves };

  expect(await outcome(() => singleRow('workflows').check(true))).toBe('passed');
  expect(resolves - before.resolves).toBe(1);
  expect(installs - before.installs).toBe(0);
  expect(callsTo(binaryPath('actionlint')).length).toBeGreaterThan(0);
});

/* ///// What the rows read from their tools ///// */

/** What running `work` ended with: `line: ` and the row's line, or the message it threw. */
async function lineOrMessage(work: () => string | undefined | Promise<string | undefined>): Promise<string> {
  try {
    return `line: ${String(await work())}`;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Whether `cmd` is the gate Bun running bun test, as the scripts:test row starts it. */
function isBunTest(cmd: readonly string[]): boolean {
  return cmd[0] === process.execPath && cmd[1] === '--no-env-file' && cmd[2] === 'test';
}

/** The answer for every call but vitest's, which answers `vitest`. */
function vitestAnswers(vitest: Answer): (cmd: readonly string[]) => Answer {
  return (cmd: readonly string[]): Answer => (tool(cmd) === 'vitest' ? vitest : passing(cmd));
}

/* ///// The test row's count ///// */

interface CountCase {
  readonly label: string;
  readonly answer: Answer;
  /** The row's line after `line: `, or the start of the message it throws. */
  readonly expected: string;
}

// The row fails when the run checked nothing, whatever vitest's exit code
// says: no test counted, or every counted test skipped or left to do. vitest
// reports a name filter as a skip, and the row allows none, so it fails on any
// skipped or todo test too. Its line names the tests and the files.
const COUNT_CASES: readonly CountCase[] = [
  {
    label: 'every test passed',
    answer: { stdout: ' Test Files  6 passed (6)\n      Tests  330 passed (330)\n' },
    expected: 'line: 330 tests across 6 files',
  },
  {
    label: 'some tests skipped',
    answer: { stdout: ' Test Files  1 passed (1)\n      Tests  8 passed | 2 skipped (10)\n' },
    expected: 'vitest skipped or left to do 2 of its 10 tests, past the 0 the row allows',
  },
  {
    label: 'a todo counts as skipped',
    answer: { stdout: ' Test Files  1 passed (1)\n      Tests  3 passed | 1 todo (4)\n' },
    expected: 'vitest skipped or left to do 1 of its 4 tests, past the 0 the row allows',
  },
  {
    label: 'a name filter that leaves one test running',
    answer: { stdout: ' Test Files  1 passed | 5 skipped (6)\n      Tests  1 passed | 329 skipped (330)\n' },
    expected: 'vitest skipped or left to do 329 of its 330 tests, past the 0 the row allows',
  },
  {
    label: 'every test skipped',
    answer: { stdout: ' Test Files  6 skipped (6)\n      Tests  330 skipped (330)\n' },
    expected: 'vitest skipped every one of its 330 tests',
  },
  {
    label: 'skipped and todo reach the count',
    answer: { stdout: ' Test Files  1 skipped (1)\n      Tests  2 skipped | 1 todo (3)\n' },
    expected: 'vitest skipped every one of its 3 tests',
  },
  {
    label: 'no Tests line',
    answer: { stdout: 'No test files found, exiting with code 0\n' },
    expected: 'vitest counted no test',
  },
  {
    label: 'a failed run',
    answer: { exitCode: 1, stdout: '      Tests  1 failed | 2 passed (3)\n' },
    expected: 'vitest run --coverage exited 1',
  },
];

test.each([...COUNT_CASES])('the test row: $label', async ({ answer: given, expected }: CountCase) => {
  answer = vitestAnswers(given);

  expect(await lineOrMessage(() => row('test').check(false))).toStartWith(expected);
});

/** A finished vitest run that printed `stdout` and exited 0. */
function vitestRun(stdout: string): Finished {
  return { exitCode: 0, stdout, stderr: '', heldOpen: false };
}

// A skip allowance lets that many skipped or todo tests through and no more,
// and never lets every test be skipped.
test.each([
  ['within it passes and names the skips', 2, 'line: 10 tests across 1 file, 2 skipped'],
  ['past it fails', 1, 'vitest skipped or left to do 2 of its 10 tests, past the 1 the row allows'],
])('a vitest skip allowance: a count %s', (_label: string, allowed: number, expected: string) => {
  const finished = vitestRun(' Test Files  1 passed (1)\n      Tests  8 passed | 2 skipped (10)\n');

  expect(outcomeOf(() => check.vitestCount(finished, allowed))).toStartWith(expected);
});

test('a vitest skip allowance never passes a run whose every test was skipped', () => {
  const finished = vitestRun(' Test Files  1 skipped (1)\n      Tests  3 skipped (3)\n');

  expect(outcomeOf(() => check.vitestCount(finished, 5))).toStartWith('vitest skipped every one of its 3 tests');
});

/** What running `work` ended with: `line: ` and what it returned, or the message it threw. */
function outcomeOf(work: () => string): string {
  try {
    return `line: ${work()}`;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('the test row names vitest.config.mts and runs vitest with CI set', async () => {
  await row('test').check(false);

  const [call] = callsToTool('vitest');
  expect(call?.cmd.slice(BUNX.length + 1)).toEqual(['run', '--coverage', '--config', 'vitest.config.mts']);
  expect(call?.env['CI']).toBe('true');
});

/* ///// scripts:test ///// */

test('scripts:test runs bun test with CI set', async () => {
  await row('scripts:test').check(false);

  expect(calls[0]?.env['CI']).toBe('true');
});

test('scripts:test fails when bun test ran no test', async () => {
  answer = (cmd: readonly string[]): Answer =>
    isBunTest(cmd) ? { stderr: 'Ran 0 tests across 1 file.\n' } : passing(cmd);

  expect(await lineOrMessage(() => row('scripts:test').check(false))).toStartWith('bun test ./scripts/ ran no test');
});

/* ///// Color in what a tool prints ///// */

const ESC = String.fromCharCode(27);

/** `text` between an SGR code and a reset, as a tool colors a word. */
function colored(text: string): string {
  return `${ESC}[1m${text}${ESC}[0m`;
}

test('the test row reads a vitest summary written in color', async () => {
  answer = vitestAnswers({
    stdout: `${colored(' Test Files')}  ${colored('6 passed')} (6)\n${colored('      Tests')}  ${colored('330 passed')} (330)\n`,
  });

  expect(await lineOrMessage(() => row('test').check(false))).toBe('line: 330 tests across 6 files');
});

test('scripts:test reads a bun test summary written in color, its skip line included', async () => {
  answer = (cmd: readonly string[]): Answer =>
    isBunTest(cmd)
      ? { stderr: ` ${colored('3 pass')}\n ${colored('1 skip')}\n${colored('Ran')} 4 tests across 1 file.\n` }
      : passing(cmd);

  expect(await lineOrMessage(() => row('scripts:test').check(false))).toBe('line: 4 tests across 1 file, 1 skipped');
});

/** A row, and an answer that colors the part of one tool's output that row reads. */
interface ColorCase {
  readonly name: string;
  readonly tool: string;
  readonly answer: (cmd: readonly string[]) => Answer;
}

const COLOR_CASES: readonly ColorCase[] = [
  {
    name: 'typecheck',
    tool: "tsc's --listFiles line",
    answer: (cmd: readonly string[]): Answer =>
      tool(cmd) === 'tsc' && cmd.includes('--listFiles')
        ? { stdout: `${colored(resolve('src/a.ts').replaceAll('\\', '/'))}\n` }
        : passing(cmd),
  },
  {
    name: 'toml',
    tool: "taplo's found line",
    answer: (cmd: readonly string[]): Answer =>
      cmd[0] === binaryPath('taplo')
        ? { stderr: `found files ${colored('total=1')} excluded=0 files=["config.toml"]` }
        : passing(cmd),
  },
  {
    name: 'workflows',
    tool: "actionlint's -verbose line and both canaries' findings",
    answer: (cmd: readonly string[]): Answer => {
      if (cmd[0] !== binaryPath('actionlint')) {
        return passing(cmd);
      }
      if (cmd.includes('-verbose')) {
        return { stderr: `${colored('verbose:')} Found total 0 errors in 1 ms for .github/workflows/ci.yml\n` };
      }
      return (cmd.at(-1) ?? '').endsWith('directive.yml')
        ? { exitCode: 1, stdout: `SC0:error:1:1: A ${colored('ShellCheck')} directive is refused` }
        : { exitCode: 1, stdout: `SC${colored('2086')}:info:2:6` };
    },
  },
  {
    name: 'workflows',
    tool: "zizmor's completed line",
    answer: (cmd: readonly string[]): Answer =>
      cmd[0] === binaryPath('zizmor') && !cmd.includes('--no-config')
        ? { stderr: `${colored('completed')} .github/workflows/ci.yml\n` }
        : passing(cmd),
  },
];

test.each([...COLOR_CASES])('$name reads $tool written in color', async ({ name, answer: colors }: ColorCase) => {
  plantTree();
  answer = colors;

  expect(await outcome(() => row(name).check(true))).toBe('passed');
});

/* ///// format and Prettier's ignore comment ///// */

// Written in two halves, so the format row that checks this file finds no comment here.
const PRETTIER_IGNORE = ['prettier', 'ignore'].join('-');

test("format refuses Prettier's ignore comment before Prettier starts", async () => {
  plantTree();
  writeFileSync('src/a.ts', `const kept = 1;\n// ${PRETTIER_IGNORE}\nconst skipped   =   2;\n`);

  const message = await outcome(() => row('format').check(false));

  expect(message).toContain('"src/a.ts" line 2');
  expect(message).toContain('Prettier ignore comment');
  expect(callsToTool('prettier')).toEqual([]);
});

/* ///// typecheck coverage ///// */

test('typecheck fails on a tracked TypeScript file that no project reads', async () => {
  plantTree();
  writeFileSync('src/b.ts', 'x\n');
  answer = (cmd: readonly string[]): Answer =>
    cmd[0] === 'git' && cmd[1] === 'ls-files' && !cmd.includes('--error-unmatch')
      ? { stdout: [...TRACKED, 'src/b.ts'].map((path) => `${path}\0`).join('') }
      : passing(cmd);

  expect(await outcome(() => row('typecheck').check(false))).toContain('no project reads "src/b.ts"');
});

/* ///// typecheck and the pinned compiler ///// */

interface CompilerCase {
  readonly label: string;
  /** What `tsc --version` prints. */
  readonly printed: string;
  /** The package.json the working directory holds, or undefined for the fixture's. */
  readonly manifest?: string;
  /** What the row ends with: `passed`, or its whole message. */
  readonly expected: string;
  /** The arguments of each tsc call, after the tool name, in order. */
  readonly passes: readonly (readonly string[])[];
}

// Two packages ship a tsc, so the row holds `tsc --version` to the major
// package.json pins for @typescript/native before it checks any project, and
// checks none when the compiler or the pin is wrong.
const COMPILER_CASES: readonly CompilerCase[] = [
  {
    label: 'the pinned major answers, asked before any project',
    printed: 'Version 7.9.4\n',
    expected: 'passed',
    passes: [
      ['--version'],
      ...['tsconfig.json', 'tests/tsconfig.json', 'scripts/tsconfig.json'].map((project) => [
        '--noEmit',
        '--listFiles',
        '--project',
        project,
      ]),
    ],
  },
  {
    label: 'another major answers, and no project is checked',
    printed: 'Version 6.8.1\n',
    expected:
      'tsc --version printed "Version 6.8.1", and package.json pins major 7, so node_modules/.bin/tsc is another package\'s compiler',
    passes: [['--version']],
  },
  {
    label: 'package.json pins no native compiler, and no tsc starts',
    printed: 'Version 7.9.4\n',
    manifest: JSON.stringify({ devDependencies: {} }),
    expected: 'package.json names no @typescript/native in devDependencies, and the typecheck row runs that compiler',
    passes: [],
  },
];

test.each([...COMPILER_CASES])('typecheck: $label', async ({ printed, manifest, expected, passes }: CompilerCase) => {
  plantTree();
  if (manifest !== undefined) {
    writeFileSync('package.json', manifest);
  }
  answer = (cmd: readonly string[]): Answer =>
    tool(cmd) === 'tsc' && cmd.includes('--version') ? { stdout: printed } : passing(cmd);

  expect(await outcome(() => row('typecheck').check(false))).toBe(expected);
  expect(callsToTool('tsc').map((call) => call.cmd.slice(BUNX.length + 1))).toEqual(passes.map((pass) => [...pass]));
});

/* ///// The ShellCheck stand-in and the canaries ///// */

/** The words actionlint's `-shellcheck=` flag carries in `cmd`, or undefined. */
function shellcheckFlag(cmd: readonly string[]): string | undefined {
  return cmd.find((arg) => arg.startsWith('-shellcheck='))?.slice('-shellcheck='.length);
}

/** `path` as actionlint reads one word of the flag: single-quoted, with forward slashes. */
function word(path: string): string {
  return `'${path.replaceAll('\\', '/')}'`;
}

// actionlint splits the flag into words and drops the backslashes of an
// unquoted Windows path, so each word is quoted with forward slashes.
test('actionlint hands ShellCheck to the stand-in: the gate Bun, no env file, the stand-in, then ShellCheck', async () => {
  plantTree();

  await row('workflows').check(false);

  const flags = callsTo(binaryPath('actionlint')).map((call) => shellcheckFlag(call.cmd));
  expect(flags.length).toBe(3);
  for (const flag of flags) {
    expect(flag).toBe(
      [process.execPath, '--no-env-file', join(ROOT, 'scripts', 'shellcheck.ts'), binaryPath('shellcheck')]
        .map((path) => word(path))
        .join(' '),
    );
  }
});

interface CanaryCase {
  readonly label: string;
  readonly canary: string;
  readonly answer: Answer;
  readonly expected: string;
}

// A canary proves the wiring only when actionlint exits 1 with the one
// finding the canary carries, so any other exit or text turns the row red
// naming that canary, before any workflow is linted.
const CANARY_CASES: readonly CanaryCase[] = [
  {
    label: 'the finding canary without SC2086',
    canary: 'finding.yml',
    answer: { exitCode: 1, stdout: 'finding.yml:8:9: some other finding' },
    expected: 'actionlint reported no "SC2086" over the finding.yml canary',
  },
  {
    label: 'the directive canary without the refusal',
    canary: 'directive.yml',
    answer: { exitCode: 1, stdout: 'directive.yml:8:9: shellcheck reported issue in this script: SC2086:info:2:6' },
    expected: 'actionlint reported no "A ShellCheck directive is refused" over the directive.yml canary',
  },
  {
    label: 'the finding canary exiting 0',
    canary: 'finding.yml',
    answer: { exitCode: 0, stdout: 'finding.yml:8:9: SC2086' },
    expected: 'actionlint over the finding.yml canary exited 0',
  },
  {
    label: 'the directive canary exiting 0',
    canary: 'directive.yml',
    answer: { exitCode: 0, stdout: 'A ShellCheck directive is refused' },
    expected: 'actionlint over the directive.yml canary exited 0',
  },
];

test.each([...CANARY_CASES])('actionlint fails on $label', async ({ canary, answer: given, expected }: CanaryCase) => {
  plantTree();
  answer = (cmd: readonly string[]): Answer =>
    cmd[0] === binaryPath('actionlint') && (cmd.at(-1) ?? '').endsWith(canary) ? given : passing(cmd);

  expect(await outcome(() => row('workflows').check(false))).toStartWith(expected);
  expect(callsTo(binaryPath('actionlint')).some((call) => call.cmd.includes('-verbose'))).toBe(false);
});

test('actionlint refuses a ShellCheck path holding a single quote before actionlint starts', async () => {
  plantTree();
  quotedShellcheck = true;
  try {
    await row('tools').check(false);
    calls = [];

    const message = await outcome(() => row('workflows').check(false));

    expect(message).toContain('holds a single quote');
    expect(callsTo(binaryPath('actionlint'))).toEqual([]);
  } finally {
    quotedShellcheck = false;
    await row('tools').check(false);
  }
});

/* ///// The secrets-inherit hold ///// */

/** zizmor's report of one job passing secrets: inherit from `file` to `callee`. */
function inheritedCall(file: string, callee: string): (typeof INHERITED)[number] {
  return {
    ident: 'secrets-inherit',
    locations: [
      {
        symbolic: { kind: 'Primary', key: { Local: { verbatim_path: `.github/workflows/${file}` } } },
        concrete: { feature: callee, location: { start_point: { row: 9 } } },
      },
    ],
  };
}

/** The answer for every call but the hold's zizmor run, which prints `report`. */
function holdAnswers(report: unknown): (cmd: readonly string[]) => Answer {
  return (cmd: readonly string[]): Answer =>
    cmd[0] === binaryPath('zizmor') && cmd.includes('--no-config')
      ? { exitCode: 13, stdout: JSON.stringify(report) }
      : passing(cmd);
}

// The hold runs zizmor with no config and inline ignores off, so it sees every
// job that passes secrets: inherit, waived or not, and no ZIZMOR_CONFIG can
// name a config against --no-config.
test('the hold runs zizmor over .github with no config, no ignores and json output', async () => {
  plantTree();

  await row('workflows').check(true);

  const hold = callsTo(binaryPath('zizmor')).find((call) => call.cmd.includes('--no-config'));
  expect(hold?.cmd.slice(1)).toEqual([
    '--no-progress',
    '--offline',
    '--no-config',
    '--no-ignores',
    '--strict-collection',
    '--format',
    'json',
    '--collect=all',
    '.github',
  ]);
  expect(Object.hasOwn(hold?.env ?? {}, 'ZIZMOR_CONFIG')).toBe(true);
  expect(hold?.env['ZIZMOR_CONFIG']).toBeUndefined();
});

test('the hold refuses a job that passes secrets: inherit outside zachthedev/.github', async () => {
  plantTree();
  answer = holdAnswers([
    inheritedCall('cd.yml', 'someone-else/.github/.github/workflows/release-pr.yml@abc'),
    inheritedCall('deps.yml', 'zachthedev/.github/.github/workflows/deps.yml@abc'),
  ]);

  const message = await outcome(() => row('workflows').check(true));

  expect(message).toContain('".github/workflows/cd.yml" line 10');
  expect(message).toContain('"someone-else/.github/.github/workflows/release-pr.yml@abc"');
});

test('the hold refuses a waived file that holds no such job', async () => {
  plantTree();
  answer = holdAnswers([inheritedCall('cd.yml', 'zachthedev/.github/.github/workflows/release-pr.yml@abc')]);

  expect(await outcome(() => row('workflows').check(true))).toContain('the secrets-inherit waiver names "deps.yml"');
});

test('the hold reads its waivers from the committed zizmor.yml', async () => {
  plantTree();
  writeFileSync(
    '.github/zizmor.yml',
    'rules:\n  secrets-inherit:\n    ignore:\n      - cd.yml\n      - deps.yml\n      - release.yml\n',
  );

  expect(await outcome(() => row('workflows').check(true))).toContain('the secrets-inherit waiver names "release.yml"');
});

test('the hold fails on a zizmor.yml that does not parse', async () => {
  plantTree();
  writeFileSync('.github/zizmor.yml', 'rules: [unclosed\n');

  expect(await outcome(() => row('workflows').check(true))).toContain('.github/zizmor.yml does not parse');
});
