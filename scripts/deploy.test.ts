// This repository's own cases for scripts/deploy.ts, which runs its whole
// deploy when it loads, so each case starts it as a process. The case's
// checkout holds a compiled stand-in as node_modules/.bin/wrangler, which bun x
// --no-install runs there in place of wrangler. The stand-in records each start
// and exits as the case says. The environment is built from scratch: bun x's
// cache is an empty directory, and a proxy nobody answers stands behind it, so
// no case reaches wrangler, Cloudflare or the network.

import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { WINDOWS } from './stand-ins';

// Each case starts a Bun process and up to three stand-in starts, and a loaded
// machine starts one in seconds, so a case gets longer than the default.
setDefaultTimeout(30_000);

/** The script under test, run from the case's working directory. */
const DEPLOY = join(import.meta.dir, 'deploy.ts');

/** What the stand-in writes into each record, so a record no stand-in wrote never reads as one. */
const MARK = 'deploy-test-stand-in';

/** The file name bun x runs for wrangler from node_modules/.bin. */
const WRANGLER = WINDOWS ? 'wrangler.exe' : 'wrangler';

/** The file name a bare `bun` start finds. */
const BUN = WINDOWS ? 'bun.exe' : 'bun';

/** What the deploy reads on stdin, which its starts inherit. */
const PIPED = 'piped to the deploy\n';

/**
 * The stand-in's source. It records the name it ran under, its arguments,
 * working directory and stdin, whether it saw the deploy's environment, and
 * whether ACCESS_KEY reached its environment in any case of the name. It reads
 * stdin on every start, or on the starts whose arguments contain
 * STANDIN_READ_AT when that is set, recording null for the rest. It writes one
 * line to stdout and one to stderr, then exits 7 when its arguments contain
 * STANDIN_FAIL_AT and 0 otherwise.
 */
const RECORDER = `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const said = args.join(' ');
const readAt = process.env['STANDIN_READ_AT'] ?? '';
const stdin = readAt === '' || said.includes(readAt) ? await new Response(Bun.stdin.stream()).text() : null;
appendFileSync(process.env['STANDIN_LOG'] ?? '', JSON.stringify({
  mark: '${MARK}',
  self: process.execPath,
  args,
  cwd: process.cwd(),
  stdin,
  sawEnv: process.env['DEPLOY_TEST_ENV'] === 'carried',
  sawKey: Object.keys(process.env).some((name) => name.toUpperCase() === 'ACCESS_KEY'),
}) + '\\n');
process.stdout.write('out: ' + said + '\\n');
process.stderr.write('err: ' + said + '\\n');
const failAt = process.env['STANDIN_FAIL_AT'] ?? '';
process.exit(failAt !== '' && said.includes(failAt) ? 7 : 0);
`;

/** One start of the stand-in, as it recorded it. */
interface Start {
  readonly mark: string;
  /** The path the stand-in ran as. */
  readonly self: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** What it read on stdin, or null where the case left stdin unread. */
  readonly stdin: string | null;
  readonly sawEnv: boolean;
  readonly sawKey: boolean;
}

/** The directory holding the compiled stand-in, outside every case. */
let standInDir: string;
/** The compiled stand-in. */
let recorder: string;
/** The case's working directory, a checkout holding the stand-in as wrangler. */
let cwd: string;
/** The case's PATH directory, empty unless the case plants a program there. */
let pathDir: string;
/** The case's bun x cache, empty, so bun x finds no wrangler but the checkout's. */
let cacheDir: string;
/** The file the stand-in appends each start to. */
let log: string;

beforeAll(() => {
  standInDir = mkdtempSync(join(tmpdir(), 'deploy-stand-in-'));
  writeFileSync(join(standInDir, 'recorder.ts'), RECORDER);
  recorder = join(standInDir, WINDOWS ? 'recorder.exe' : 'recorder');
  // A compiled program, so bun x runs it from node_modules/.bin as it runs an
  // installed binary. Compiling for this platform reads the running Bun alone.
  // It loads no .env file, so what it records is what the start was handed.
  const compiled = Bun.spawnSync({
    cmd: [
      process.execPath,
      'build',
      '--compile',
      '--no-compile-autoload-dotenv',
      join(standInDir, 'recorder.ts'),
      '--outfile',
      recorder,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  if (compiled.exitCode !== 0) {
    throw new Error(`bun build --compile exited ${String(compiled.exitCode)}: ${compiled.stderr.toString()}`);
  }
  // The fixture holds only when the stand-in records a start, so it proves
  // that once here, before any case relies on it.
  const probeLog = join(standInDir, 'probe.jsonl');
  writeFileSync(probeLog, '');
  const probe = Bun.spawnSync({
    cmd: [recorder, 'probe'],
    env: { ...systemEnv(), STANDIN_LOG: probeLog },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  expect(probe.exitCode).toBe(0);
  expect(readStarts(probeLog, basename(recorder)).map((start) => start.args)).toEqual([['probe']]);
}, 120_000);

afterAll(() => {
  rmSync(standInDir, { recursive: true, force: true });
});

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'deploy-case-'));
  pathDir = mkdtempSync(join(tmpdir(), 'deploy-path-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'deploy-cache-'));
  log = join(cwd, 'starts.jsonl');
  writeFileSync(log, '');
  mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
  linkSync(recorder, join(cwd, 'node_modules', '.bin', WRANGLER));
});

afterEach(() => {
  for (const dir of [cwd, pathDir, cacheDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * What a process needs from this one to start at all: Windows its system
 * root, and Bun its temporary directory. Nothing else is carried over, and
 * NoDefaultCurrentDirectoryInExePath is left out, so a bare name searches the
 * working directory first on Windows, as a user's own shell does.
 */
function systemEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * The environment a case's deploy gets, built from scratch: PATH is the
 * case's own directory, bun x's cache is an empty one, and a proxy nobody
 * answers takes any request.
 */
function baseEnv(): Record<string, string> {
  return {
    ...systemEnv(),
    PATH: pathDir,
    BUN_INSTALL_CACHE_DIR: cacheDir,
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
  };
}

/**
 * Every start recorded in `path`, each checked to be the stand-in's own record
 * and to have run as `name`, before any assertion reads it.
 */
function readStarts(path: string, name: string): Start[] {
  const starts = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Start);
  for (const start of starts) {
    expect(start.mark).toBe(MARK);
    expect(basename(start.self)).toBe(name);
  }
  return starts;
}

/** What one deploy run left: its exit code, its output and the starts the stand-in recorded. */
interface Deployed {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly starts: readonly Start[];
}

/**
 * Runs the deploy in the case's checkout with `env` over the base environment,
 * writing {@link PIPED} to its stdin through a pipe, as a shell or a runner
 * hands it one, and closing it.
 */
async function deploy(env: Readonly<Record<string, string>>): Promise<Deployed> {
  const child = Bun.spawn({
    cmd: [process.execPath, DEPLOY],
    cwd,
    env: { ...baseEnv(), STANDIN_LOG: log, DEPLOY_TEST_ENV: 'carried', ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  await child.stdin.write(PIPED);
  await child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr, starts: readStarts(log, WRANGLER) };
}

/** The migrations start's arguments. */
const MIGRATIONS = ['d1', 'migrations', 'apply', 'AUDIT_DB', '--remote'];

/** An ACCESS_KEY no shell could pass as one word: a space, quotes, a dollar sign, a backtick and newlines. */
const AWKWARD_KEY = 'key with "quotes" \'and\' $HOME `x`\nsecond line\n';

interface PassCase {
  readonly label: string;
  readonly env: Readonly<Record<string, string>>;
  /** Each start's arguments, in order. */
  readonly args: readonly (readonly string[])[];
  /** What each start read on stdin, in order. */
  readonly stdin: readonly (string | null)[];
  /** The deploy's lines and each start's own, which reach the deploy's stdout in order. */
  readonly stdout: string;
  /** Each start's stderr line, which reaches the deploy's stderr. */
  readonly stderr: string;
}

const PASS_CASES: readonly PassCase[] = [
  {
    label: 'no CUSTOM_DOMAIN and no ACCESS_KEY migrates and deploys to workers.dev, syncing no secret',
    env: {},
    args: [MIGRATIONS, ['deploy']],
    stdin: [PIPED, ''],
    stdout:
      'Applying D1 migrations…\nout: d1 migrations apply AUDIT_DB --remote\nDeploying to the workers.dev URL…\nout: deploy\nACCESS_KEY not in environment; skipping secret sync.\n',
    stderr: 'err: d1 migrations apply AUDIT_DB --remote\nerr: deploy\n',
  },
  {
    label: 'an empty CUSTOM_DOMAIN and ACCESS_KEY read as unset',
    env: { CUSTOM_DOMAIN: '', ACCESS_KEY: '' },
    args: [MIGRATIONS, ['deploy']],
    stdin: [PIPED, ''],
    stdout:
      'Applying D1 migrations…\nout: d1 migrations apply AUDIT_DB --remote\nDeploying to the workers.dev URL…\nout: deploy\nACCESS_KEY not in environment; skipping secret sync.\n',
    stderr: 'err: d1 migrations apply AUDIT_DB --remote\nerr: deploy\n',
  },
  {
    label: 'CUSTOM_DOMAIN deploys with --domain, and ACCESS_KEY reaches secret put on stdin alone, byte for byte',
    env: { CUSTOM_DOMAIN: 'ddns.example.com', ACCESS_KEY: AWKWARD_KEY },
    args: [MIGRATIONS, ['deploy', '--domain', 'ddns.example.com'], ['secret', 'put', 'ACCESS_KEY']],
    stdin: [PIPED, '', AWKWARD_KEY],
    stdout:
      'Applying D1 migrations…\nout: d1 migrations apply AUDIT_DB --remote\nDeploying with custom domain ddns.example.com…\nout: deploy --domain ddns.example.com\nSyncing ACCESS_KEY worker secret…\nout: secret put ACCESS_KEY\n',
    stderr:
      'err: d1 migrations apply AUDIT_DB --remote\nerr: deploy --domain ddns.example.com\nerr: secret put ACCESS_KEY\n',
  },
  // The first start drains a shared stdin, so only a case whose earlier start
  // leaves it unread shows that the deploy start reads the operator's own, as
  // wrangler's prompts need.
  {
    label: 'the deploy start reads the stdin the deploy was given',
    env: { CUSTOM_DOMAIN: 'ddns.example.com', STANDIN_READ_AT: 'deploy' },
    args: [MIGRATIONS, ['deploy', '--domain', 'ddns.example.com']],
    stdin: [null, PIPED],
    stdout:
      'Applying D1 migrations…\nout: d1 migrations apply AUDIT_DB --remote\nDeploying with custom domain ddns.example.com…\nout: deploy --domain ddns.example.com\nACCESS_KEY not in environment; skipping secret sync.\n',
    stderr: 'err: d1 migrations apply AUDIT_DB --remote\nerr: deploy --domain ddns.example.com\n',
  },
];

test.each([...PASS_CASES])('$label', async ({ env, args, stdin, stdout, stderr }: PassCase) => {
  const deployed = await deploy(env);

  expect(deployed.stderr).toBe(stderr);
  expect(deployed.exitCode).toBe(0);
  expect(deployed.stdout).toBe(stdout);
  expect(deployed.starts.map((start) => start.args)).toEqual([...args]);
  expect(deployed.starts.map((start) => start.stdin)).toEqual([...stdin]);
  for (const start of deployed.starts) {
    expect(realpathSync(start.cwd)).toBe(realpathSync(cwd));
    expect(start.sawEnv).toBe(true);
    expect(start.sawKey).toBe(false);
  }
});

// Windows searches the working directory ahead of PATH for a bare name, so a
// deploy that started `bun` by name would run either file here.
test(`a ${BUN} in the working directory and on PATH starts nothing`, async () => {
  for (const dir of [cwd, pathDir]) {
    linkSync(recorder, join(dir, BUN));
  }

  const deployed = await deploy({ ACCESS_KEY: 'k' });

  expect(deployed.exitCode).toBe(0);
  expect(deployed.starts.map((start) => start.args)).toEqual([MIGRATIONS, ['deploy'], ['secret', 'put', 'ACCESS_KEY']]);
  expect(readStarts(log, WRANGLER)).toHaveLength(3);
});

// Windows reads one variable under every case of its name, so the deploy
// reads this one as ACCESS_KEY there and syncs it. Elsewhere it is another
// variable. Either way no start's environment carries it.
test('an ACCESS_KEY spelled in another case reaches no start', async () => {
  const deployed = await deploy({ access_key: 'k' });

  expect(deployed.exitCode).toBe(0);
  expect(deployed.starts.map((start) => start.args)).toEqual(
    WINDOWS ? [MIGRATIONS, ['deploy'], ['secret', 'put', 'ACCESS_KEY']] : [MIGRATIONS, ['deploy']],
  );
  expect(deployed.starts.map((start) => start.sawKey)).toEqual(deployed.starts.map(() => false));
});

// wrangler's parser takes a value such as --help as a flag and exits 0, so a
// bad value deploys nothing and starts nothing.
test.each(['--help', 'a b', 'example', 'ddns.example.com --remote'])(
  'CUSTOM_DOMAIN %p is refused before any start',
  async (domain: string) => {
    const deployed = await deploy({ CUSTOM_DOMAIN: domain, ACCESS_KEY: 'k' });

    expect(deployed.exitCode).toBe(1);
    expect(deployed.stdout).toBe('');
    expect(deployed.stderr).toBe(`CUSTOM_DOMAIN is not a hostname: ${JSON.stringify(domain)}\n`);
    expect(deployed.starts).toEqual([]);
  },
);

interface FailCase {
  readonly label: string;
  readonly failAt: string;
  readonly env: Readonly<Record<string, string>>;
  /** The starts that ran, the failing one last. */
  readonly args: readonly (readonly string[])[];
  readonly stdout: string;
}

const FAIL_CASES: readonly FailCase[] = [
  {
    label: 'migrations',
    failAt: 'd1 migrations',
    env: { CUSTOM_DOMAIN: 'ddns.example.com', ACCESS_KEY: 'k' },
    args: [MIGRATIONS],
    stdout: 'Applying D1 migrations…\nout: d1 migrations apply AUDIT_DB --remote\n',
  },
  {
    label: 'deploy',
    failAt: 'deploy',
    env: { CUSTOM_DOMAIN: 'ddns.example.com', ACCESS_KEY: 'k' },
    args: [MIGRATIONS, ['deploy', '--domain', 'ddns.example.com']],
    stdout:
      'Applying D1 migrations…\nout: d1 migrations apply AUDIT_DB --remote\nDeploying with custom domain ddns.example.com…\nout: deploy --domain ddns.example.com\n',
  },
  {
    label: 'secret put',
    failAt: 'secret put',
    env: { ACCESS_KEY: 'k' },
    args: [MIGRATIONS, ['deploy'], ['secret', 'put', 'ACCESS_KEY']],
    stdout:
      'Applying D1 migrations…\nout: d1 migrations apply AUDIT_DB --remote\nDeploying to the workers.dev URL…\nout: deploy\nSyncing ACCESS_KEY worker secret…\nout: secret put ACCESS_KEY\n',
  },
];

test.each([...FAIL_CASES])(
  'a failing $label start ends the deploy with exit 1, and no later start runs',
  async ({ failAt, env, args, stdout }: FailCase) => {
    const deployed = await deploy({ ...env, STANDIN_FAIL_AT: failAt });

    expect(deployed.exitCode).toBe(1);
    expect(deployed.stdout).toBe(stdout);
    // Bun's report of the uncaught error follows the starts' own lines, with
    // the source line and the file's path, so the message is matched alone.
    expect(deployed.stderr).toStartWith(args.map((each) => `err: ${each.join(' ')}\n`).join(''));
    expect(deployed.stderr.split(/\r?\n/)).toContain('error: Failed with exit code 7');
    expect(deployed.starts.map((start) => start.args)).toEqual([...args]);
    expect(deployed.starts.map((start) => start.sawKey)).toEqual(args.map(() => false));
  },
);

test('a checkout without wrangler in node_modules/.bin is refused before any start', async () => {
  rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });

  const deployed = await deploy({ ACCESS_KEY: 'k' });

  expect(deployed.exitCode).toBe(1);
  expect(deployed.stdout).toBe('');
  expect(deployed.stderr).toBe(
    'wrangler is not installed in this checkout: run bun install --frozen-lockfile, or bun install --frozen-lockfile --ignore-scripts in a worktree (CONTRIBUTING.md#setup).\n',
  );
  expect(deployed.starts).toEqual([]);
});
