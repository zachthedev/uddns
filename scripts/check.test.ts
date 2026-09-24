// This repository's own cases for scripts/check.ts: the command line each row
// starts, the NO_PROXY the workerd rows get, and the cf-typegen:check row's
// order and restore. run() is swapped for a recorder before check.ts loads,
// so no case starts a program: nothing reaches gh, git, mise, wrangler,
// workerd or the network.

import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
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
  _timeoutMs: number,
  env: Readonly<Record<string, string | undefined>> = {},
  options: RunOptions = {},
): Promise<Finished> {
  calls.push({ cmd: [...cmd], env: { ...env }, options: { ...options }, typesPresent: existsSync(TYPES) });
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, heldOpen: false, ...answer(cmd) });
}

// Copied before the mocks replace them in place, so afterAll can put them
// back for the test files that run after this one in the same process.
const REAL_RUN = { ...runModule };
const REAL_TOOLS = { ...toolsModule };

let standIns: StandIns;
let installs = 0;

/** The path the mocked tools row resolves for `key`, which no case starts. */
function binaryPath(key: string): string {
  return join(standIns.dir, key);
}

await mock.module('./run', () => ({ ...REAL_RUN, run: recorder }));
await mock.module('./tools', () => ({
  ...REAL_TOOLS,
  install: (): Promise<void> => {
    installs += 1;
    return Promise.resolve();
  },
  resolve: (): Promise<ReadonlyMap<string, string>> =>
    Promise.resolve(new Map(REAL_TOOLS.TOOLS.map((tool) => [tool.key, binaryPath(tool.key)]))),
}));

// check.ts reads its node_modules path from the working directory it loads in.
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

/** The tracked workflows, which the actionlint and zizmor rows read. */
const WORKFLOWS: readonly string[] = ['.github/workflows/ci.yml'];

/** Writes every {@link TRACKED} file into the working directory. */
function plantTree(): void {
  for (const path of TRACKED) {
    // Bun's mkdirSync refuses '.' even with recursive set.
    if (dirname(path) !== '.') {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, path.endsWith('.md') ? '# Title\n' : 'x\n');
  }
}

/** The package entry `cmd` starts, relative to the node_modules check.ts loaded beside, or undefined. */
function entry(cmd: readonly string[]): string | undefined {
  const prefix = join(ROOT, 'node_modules');
  const second = cmd[1] ?? '';
  return cmd[0] === process.execPath && second.startsWith(prefix)
    ? second.slice(prefix.length + 1).replaceAll('\\', '/')
    : undefined;
}

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
  switch (entry(cmd)) {
    case '@typescript/native/bin/tsc':
      return { stdout: `${resolve('src/a.ts').replaceAll('\\', '/')}\n` };
    case 'eslint/bin/eslint.js':
      return { stdout: JSON.stringify([{ filePath: resolve('src/a.ts'), messages: [] }]) };
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
    return args.includes('-verbose')
      ? {
          stderr: handed(cmd)
            .map((path) => `verbose: Found total 0 errors in 1 ms for ${path}\n`)
            .join(''),
        }
      : { stdout: 'canary.yml:7:9: shellcheck reported issue in this script: SC2086:info:1:6' };
  }
  if (program === binaryPath('zizmor')) {
    return { stderr: WORKFLOWS.map((path) => `completed ${path}\n`).join('') };
  }
  return {};
}

/** The recorded calls to the program `program`, by name or path. */
function callsTo(program: string): Call[] {
  return calls.filter((call) => call.cmd[0] === program);
}

/** The recorded calls that start the package entry `path`. */
function callsToEntry(path: string): Call[] {
  return calls.filter((call) => entry(call.cmd) === path);
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
  ['typecheck', '@typescript/native/bin/tsc'],
  ['cf-typegen:check', 'wrangler/bin/wrangler.js'],
  ['format:check', 'prettier/bin/prettier.cjs'],
  ['lint', 'eslint/bin/eslint.js'],
  ['test', 'vitest/vitest.mjs'],
];

test.each([...PACKAGE_ROWS])('%s starts the gate Bun on the absolute entry %s', async (name: string, path: string) => {
  plantTree();
  writeFileSync(TYPES, 'x\n');

  await row(name).check(false);

  const started = calls.filter((call) => call.cmd[0] === process.execPath);
  expect(started.length).toBeGreaterThan(0);
  for (const call of started) {
    expect(call.cmd[1]).toBe(join(ROOT, 'node_modules', path));
    expect(isAbsolute(call.cmd[1] ?? '')).toBe(true);
  }
});

test('no row starts a program through bun run, bunx or node, or by a name other than git and gh', async () => {
  await runEveryRow();

  for (const call of calls) {
    const [program = ''] = call.cmd;
    expect(isAbsolute(program) || program === 'git' || program === 'gh').toBe(true);
    if (program === process.execPath) {
      expect(call.cmd[1]).not.toBe('run');
    }
  }
});

test('scripts:test runs bun test over scripts/ with the gate Bun, its report shown', async () => {
  await row('scripts:test').check(false);

  expect(calls.map((call) => call.cmd)).toEqual([[process.execPath, 'test', './scripts/']]);
  expect(calls[0]?.options.show).toBe(true);
});

test('typecheck names each project with --project, one tsc pass each, in order', async () => {
  plantTree();

  await row('typecheck').check(false);

  const passes = callsToEntry('@typescript/native/bin/tsc');
  expect(passes.map((call) => after(call.cmd, '--project'))).toEqual([...check.PROJECTS]);
  for (const call of passes) {
    expect(call.cmd).toContain('--noEmit');
    expect(call.cmd).toContain('--listFiles');
  }
});

test('lint names eslint.config.ts and allows no warning', async () => {
  plantTree();

  await row('lint').check(false);

  const [call] = callsToEntry('eslint/bin/eslint.js');
  expect(after(call?.cmd ?? [], '--config')).toBe('eslint.config.ts');
  expect(call?.cmd).toContain('--max-warnings=0');
  expect(after(call?.cmd ?? [], '--format')).toBe('json');
});

test('format:check names .prettierrc and .prettierignore, reads no .editorconfig, and hands over the files Prettier formats', async () => {
  plantTree();

  await row('format:check').check(false);

  const [call] = callsToEntry('prettier/bin/prettier.cjs');
  const cmd = call?.cmd ?? [];
  expect(after(cmd, '--config')).toBe('.prettierrc');
  expect(after(cmd, '--ignore-path')).toBe('.prettierignore');
  expect(cmd).toContain('--no-editorconfig');
  expect([...handed(cmd)].sort()).toEqual(['.github/workflows/ci.yml', 'README.md', 'src/a.ts']);
});

test('taplo names .taplo.toml, hands over the tracked TOML files, and asks for its found line', async () => {
  plantTree();

  await row('taplo').check(false);

  const [call] = callsTo(binaryPath('taplo'));
  expect(call?.cmd).toEqual([binaryPath('taplo'), 'fmt', '--check', '--config', '.taplo.toml', '--', 'config.toml']);
  expect(call?.env['RUST_LOG']).toBe('info');
});

test('zizmor in the quick form runs offline over .github with its config named, and asks gh nothing', async () => {
  plantTree();

  await row('zizmor').check(true);

  const [call] = callsTo(binaryPath('zizmor'));
  const cmd = call?.cmd ?? [];
  expect(after(cmd, '--config')).toBe('.github/zizmor.yml');
  expect(cmd).toContain('--strict-collection');
  expect(cmd).toContain('--collect=all');
  expect(cmd).toContain('--offline');
  expect(cmd.at(-1)).toBe('.github');
  expect(callsTo('gh')).toEqual([]);
});

test('zizmor in the full form runs offline when gh answers with no token', async () => {
  plantTree();

  await row('zizmor').check(false);

  expect(callsTo('gh').map((call) => call.cmd)).toEqual([['gh', 'auth', 'token']]);
  expect(callsTo(binaryPath('zizmor'))[0]?.cmd).toContain('--offline');
});

test('zizmor in the full form runs online with the token gh answers, handed to zizmor alone', async () => {
  plantTree();
  const base = passing;
  answer = (cmd: readonly string[]): Answer => (cmd[0] === 'gh' ? { stdout: 'canary-token\n' } : base(cmd));

  await row('zizmor').check(false);

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
  ['cf-typegen:check', 'wrangler/bin/wrangler.js'],
  ['test', 'vitest/vitest.mjs'],
])('%s hands %s one NO_PROXY spelling, carrying the gate list and loopback', async (name: string, path: string) => {
  plantTree();
  writeFileSync(TYPES, 'x\n');
  process.env['NO_PROXY'] = 'a.example';

  await row(name).check(false);

  const [call] = callsToEntry(path);
  expect(spellings(call?.env ?? {}, 'NO_PROXY')).toEqual(['NO_PROXY']);
  expect(call?.env['NO_PROXY']).toBe(`a.example,${LOOPBACK}`);
});

test('the test row runs vitest run --coverage with its report shown', async () => {
  await row('test').check(false);

  const [call] = callsToEntry('vitest/vitest.mjs');
  expect(call?.cmd.slice(2)).toEqual(['run', '--coverage']);
  expect(call?.options.show).toBe(true);
});

test.each([
  ['format:check', 'no tracked file is one Prettier formats, so the row checks nothing'],
  ['taplo', 'no TOML file is tracked, so the row checks nothing'],
  ['actionlint', 'no workflow is tracked under .github/workflows, so the row checks nothing'],
  ['zizmor', 'no workflow is tracked under .github/workflows, so the row checks nothing'],
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
    if (entry(cmd) === 'wrangler/bin/wrangler.js') {
      return overrides.wrangler ?? {};
    }
    if (cmd[0] === 'git' && cmd[1] === 'checkout') {
      return overrides.restore ?? {};
    }
    return {};
  };
}

/** What each recorded call was: the git subcommand, or the package entry. */
function steps(): string[] {
  return calls.map((call) =>
    call.cmd[0] === 'git' ? `git ${call.cmd[1] ?? ''}` : (entry(call.cmd) ?? call.cmd[0] ?? ''),
  );
}

test('cf-typegen:check asks git, removes the file, regenerates it, then diffs it, with no GIT_ variable', async () => {
  writeFileSync(TYPES, 'x\n');
  process.env['GIT_DIR'] = join(cwd, 'elsewhere');
  process.env['GIT_INDEX_FILE'] = join(cwd, 'index');
  answer = typegen({});

  await check.cfTypegen();

  expect(calls.map((call) => call.cmd)).toEqual([
    ['git', 'ls-files', '--error-unmatch', '--', TYPES],
    [
      process.execPath,
      join(ROOT, 'node_modules', 'wrangler/bin/wrangler.js'),
      'types',
      '--env-file',
      '.dev.vars.template',
    ],
    ['git', 'diff', '--no-ext-diff', '--exit-code', '--', TYPES],
  ]);
  expect(calls[1]?.typesPresent).toBe(false);
  for (const call of calls.filter((each) => each.cmd[0] === 'git')) {
    for (const name of ['GIT_DIR', 'GIT_INDEX_FILE']) {
      expect(Object.hasOwn(call.env, name)).toBe(true);
      expect(call.env[name]).toBeUndefined();
    }
  }
});

test('cf-typegen:check refuses an untracked types file before it removes anything', async () => {
  writeFileSync(TYPES, 'x\n');
  answer = typegen({ listed: { exitCode: 1, stderr: `error: pathspec '${TYPES}' did not match` } });

  expect(await outcome(() => check.cfTypegen())).toStartWith(`${TYPES} is not tracked`);
  expect(existsSync(TYPES)).toBe(true);
  expect(steps()).toEqual(['git ls-files']);
});

test.each([
  ['fails', { exitCode: 1, stderr: 'wrangler broke' }, 'wrangler types exited 1 saying: wrangler broke'],
  ['is killed at its deadline', { exitCode: -1, timedOut: true }, 'wrangler types was killed at its deadline'],
])(
  'cf-typegen:check restores the tracked file when wrangler %s, and diffs nothing',
  async (_label: string, wrangler: Answer, message: string) => {
    writeFileSync(TYPES, 'x\n');
    answer = typegen({ wrangler });

    expect(await outcome(() => check.cfTypegen())).toStartWith(message);
    expect(steps()).toEqual(['git ls-files', 'wrangler/bin/wrangler.js', 'git checkout']);
    expect(calls.at(-1)?.cmd).toEqual(['git', 'checkout', '--', TYPES]);
  },
);

test('cf-typegen:check names both failures when the restore fails too', async () => {
  writeFileSync(TYPES, 'x\n');
  answer = typegen({ wrangler: { exitCode: 1 }, restore: { exitCode: 1, stderr: 'checkout broke' } });

  const message = await outcome(() => check.cfTypegen());

  expect(message).toStartWith('wrangler types exited 1');
  expect(message).toContain(`git could not restore ${TYPES}: it exited 1 saying: checkout broke`);
});

test('the tools row installs through the tools module, once per run', () => {
  // beforeAll ran the row once.
  expect(installs).toBe(1);
});
