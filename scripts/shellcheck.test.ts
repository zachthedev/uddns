import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isolate, StandIns } from './stand-ins';

// Every case starts Bun twice, and a loaded machine starts one in seconds, so a
// case gets longer than the runner's five-second default.
setDefaultTimeout(30_000);

/** The module under test, which actionlint starts once per workflow script. */
const STAND_IN = join(import.meta.dir, 'shellcheck.ts');

/** The running Bun's directory, which every case starts the stand-in in. */
const BUN_DIRECTORY = dirname(process.execPath);

// A path relative to Bun's own directory reaches Bun on every layout. No
// relative path reaches Bun from a checkout on another Windows drive. There
// path.relative returns the absolute path, which the stand-in accepts.
const RELATIVE_BUN = `.${sep}${basename(process.execPath)}`;

/** The arguments actionlint 1.7.12 hands ShellCheck for a bash script. */
const SHELLCHECK_ARGS: readonly string[] = [
  '--norc',
  '-f',
  'json',
  '-x',
  '--shell',
  'bash',
  '-e',
  'SC1091,SC2194,SC2050,SC2153,SC2154,SC2157,SC2043',
  '-',
];

// A program in ShellCheck's place. It records its working directory, its
// arguments, the names in its environment and the bytes on its stdin, read
// unless FAKE_SKIP_READ is set. Then it prints and exits as the FAKE_
// variables say.
const FAKE = `import { writeFileSync } from 'node:fs';
const stdin = process.env.FAKE_SKIP_READ === undefined ? new Uint8Array(await Bun.stdin.arrayBuffer()) : new Uint8Array();
writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), names: Object.keys(process.env), stdin: [...stdin] }));
process.stdout.write(process.env.FAKE_STDOUT ?? '');
process.stderr.write(process.env.FAKE_STDERR ?? '');
process.exitCode = Number(process.env.FAKE_EXIT ?? '0');
`;

/** What the fake recorded about the one start of it. */
interface Recorded {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly names: readonly string[];
  readonly stdin: readonly number[];
}

/** One finished start of the stand-in. */
interface Ended {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let standIns: StandIns;
let restore: () => void;
let fake: string;
let record: string;

beforeAll(() => {
  // No program is planted: the directory gives the fake and its record a home
  // outside the checkout, and isolate() keeps the gate's variables from them.
  standIns = new StandIns([]);
  fake = join(standIns.dir, 'fake-shellcheck.ts');
  record = join(standIns.dir, 'fake-record.json');
  writeFileSync(fake, FAKE);
});

afterAll(() => {
  standIns.remove();
});

beforeEach(() => {
  restore = isolate(standIns);
  rmSync(record, { force: true });
});

afterEach(() => {
  restore();
});

/** Starts the stand-in as actionlint does, in Bun's directory, with `script` on stdin and `program` as ShellCheck. */
function standIn(
  script: string | Uint8Array,
  env: Readonly<Record<string, string>> = {},
  program: readonly string[] = [process.execPath, '--no-env-file', fake],
): Ended {
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--no-env-file', STAND_IN, ...program, ...SHELLCHECK_ARGS],
    cwd: BUN_DIRECTORY,
    env: { ...process.env, FAKE_RECORD: record, ...env },
    stdin: typeof script === 'string' ? new TextEncoder().encode(script) : script,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

/** What the fake recorded, or undefined when it never started. */
function recorded(): Recorded | undefined {
  return existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as Recorded) : undefined;
}

/* ///// Directives ///// */

const NO_BREAK_SPACE = String.fromCharCode(0xa0);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

interface DirectiveCase {
  readonly label: string;
  readonly line: string;
}

// Each line as ShellCheck reads it once YAML is decoded. ShellCheck honors
// every one but the capitalized word, which the refusal covers too.
const DIRECTIVES: readonly DirectiveCase[] = [
  { label: 'a disable directive', line: '# shellcheck disable=SC2086' },
  { label: 'no space after #', line: '#shellcheck disable=all' },
  { label: 'a source directive', line: '# shellcheck source=/dev/null' },
  { label: 'an enable directive', line: '# shellcheck enable=require-variable-braces' },
  { label: 'two keys', line: '# shellcheck source=/dev/null disable=SC2086' },
  { label: 'a key right after a quoted value', line: "# shellcheck source='x'disable=SC2086" },
  { label: 'tabs', line: '#\tshellcheck\tdisable=SC2086' },
  { label: 'no-break spaces', line: `#${NO_BREAK_SPACE}shellcheck${NO_BREAK_SPACE}disable=SC2086` },
  { label: 'zero-width spaces', line: `#${ZERO_WIDTH_SPACE}shellcheck${ZERO_WIDTH_SPACE}disable=SC2086` },
  { label: 'a capitalized word', line: '# ShellCheck disable=SC2086' },
  { label: 'after a command and a semicolon', line: 'true;# shellcheck disable=SC2086' },
  { label: 'after a command and a space', line: 'echo hi # shellcheck disable=SC2086' },
];

test.each([...DIRECTIVES])(
  '$label is refused in ShellCheck JSON naming its line, and ShellCheck never starts',
  ({ line }: DirectiveCase) => {
    const ended = standIn(`set -eo pipefail\necho one\n${line}\necho $V\n`);

    expect(ended.exitCode).toBe(1);
    expect(JSON.parse(ended.stdout)).toEqual([
      {
        file: '-',
        line: 3,
        endLine: 3,
        column: 1,
        endColumn: 1,
        level: 'error',
        code: 0,
        message: expect.stringContaining(`A ShellCheck directive is refused in a workflow script`) as string,
        fix: null,
      },
    ]);
    expect(recorded()).toBeUndefined();
  },
);

test('two directives are two findings, each on its own line', () => {
  const ended = standIn('# shellcheck disable=SC2086\necho $V\n# shellcheck disable=SC2046\n');

  expect(ended.exitCode).toBe(1);
  expect((JSON.parse(ended.stdout) as { line: number }[]).map((finding) => finding.line)).toEqual([1, 3]);
});

test('the finding quotes the line it refuses', () => {
  const ended = standIn('# shellcheck disable=SC2086\n');

  expect(ended.stdout).toContain(JSON.stringify(JSON.stringify('# shellcheck disable=SC2086')).slice(1, -1));
});

test.each(['echo shellcheck disable=SC2086', '#shellcheckdisable=SC2086', '# shell check disable=SC2086', ''])(
  '%p is no directive and reaches ShellCheck',
  (line: string) => {
    const ended = standIn(`${line}\n`);

    expect(ended.exitCode).toBe(0);
    expect(recorded()).toBeDefined();
  },
);

/* ///// Passing through ///// */

test("ShellCheck gets actionlint's arguments and the exact bytes, and its output and exit code come back unchanged", () => {
  const script = new Uint8Array([...new TextEncoder().encode('echo $V\r\necho caf'), 0xc3, 0xa9, 0x0a, 0xff, 0x0a]);

  const ended = standIn(script, {
    FAKE_STDOUT: '[{"line":1,"code":2086}]',
    FAKE_STDERR: 'a warning',
    FAKE_EXIT: '1',
  });

  expect(ended).toEqual({ exitCode: 1, stdout: '[{"line":1,"code":2086}]', stderr: 'a warning' });
  expect(recorded()?.args).toEqual([...SHELLCHECK_ARGS]);
  expect(recorded()?.stdin).toEqual([...script]);
});

test('a clean ShellCheck run comes back clean', () => {
  expect(standIn('echo "$V"\n', { FAKE_STDOUT: '[]' })).toEqual({ exitCode: 0, stdout: '[]', stderr: '' });
});

test.each(['2', '3', '4'])(
  'a ShellCheck exiting %s passes its stderr and exit code, and nothing on stdout',
  (exit: string) => {
    expect(standIn('echo "$V"\n', { FAKE_STDOUT: '[]', FAKE_STDERR: 'a failure', FAKE_EXIT: exit })).toEqual({
      exitCode: Number(exit),
      stdout: '',
      stderr: 'a failure',
    });
  },
);

// Four megabytes fill any pipe, so the write fails once the program is gone.
test('a ShellCheck that exits without reading the script leaves exit 2 and nothing on stdout', () => {
  const ended = standIn('echo "$V"\n'.repeat(400_000), { FAKE_SKIP_READ: '1', FAKE_STDOUT: '[]' });

  expect(ended.exitCode).toBe(2);
  expect(ended.stdout).toBe('');
  expect(ended.stderr).toContain('ShellCheck did not read the whole script');
});

test('SHELLCHECK_OPTS reaches ShellCheck in no spelling, and every other variable reaches it', () => {
  standIn('echo "$V"\n', { SHELLCHECK_OPTS: '--exclude=SC2086', Shellcheck_Opts: '--exclude=SC2086', GATE_KEPT: 'x' });

  const names = recorded()?.names ?? [];
  expect(names.filter((name) => name.toUpperCase() === 'SHELLCHECK_OPTS')).toEqual([]);
  expect(names).toContain('GATE_KEPT');
});

/* ///// Failing closed ///// */

test("ShellCheck starts in Bun's directory, where the relative path names the running Bun", () => {
  expect(isAbsolute(RELATIVE_BUN)).toBe(false);
  expect(resolve(BUN_DIRECTORY, RELATIVE_BUN)).toBe(process.execPath);

  standIn('echo "$V"\n');

  const ran = recorded();
  expect(ran).toBeDefined();
  // getcwd reports a working directory by its real path, and process.execPath
  // can keep a link, so both sides are compared resolved.
  expect(realpathSync.native(ran?.cwd ?? '')).toBe(realpathSync.native(BUN_DIRECTORY));
});

// actionlint reads an exit other than 0 with nothing on stdout as a failed
// run, so each of these fails the row rather than passing a script unread. The
// relative path names the running Bun from the directory the stand-in starts
// in, so only the stand-in's own check refuses it.
test.each([
  ['no ShellCheck named', (): string[] => []],
  ['ShellCheck named by a bare name', (): string[] => ['shellcheck']],
  ['ShellCheck named by a relative path that exists', (): string[] => [RELATIVE_BUN, '--no-env-file', fake]],
  ['a ShellCheck that does not exist', (): string[] => [join(import.meta.dir, 'no-such-shellcheck.exe')]],
] as const)('%s exits 2 with nothing on stdout, and starts nothing', (_label: string, program: () => string[]) => {
  const ended = standIn('echo "$V"\n', {}, program());

  expect(ended.exitCode).toBe(2);
  expect(ended.stdout).toBe('');
  expect(ended.stderr).toContain('the ShellCheck stand-in failed');
  expect(recorded()).toBeUndefined();
});
