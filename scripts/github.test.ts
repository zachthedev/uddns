import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubToken, takeTokens } from './github';
import { type Answer, isolate, launcherName, spellings, StandIns } from './stand-ins';

// Every stand-in start is a Bun process, and a loaded machine starts one in
// seconds, so a case gets longer than the runner's five-second default.
setDefaultTimeout(30_000);

// The rule, written out here rather than read from the module: every name gh,
// zizmor and mise read a GitHub token from is cleared, and gh alone is handed
// its own two.
const CLEARED: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'ZIZMOR_GITHUB_TOKEN',
  'MISE_GITHUB_TOKEN',
  'MISE_GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_API_TOKEN',
];
const GH_OWN: readonly string[] = ['GH_TOKEN', 'GITHUB_TOKEN'];
const NOT_GH_OWN: readonly string[] = CLEARED.filter((name) => !GH_OWN.includes(name));

/** `name` in lower case and in a mixed case, beside its canonical spelling. */
function variants(name: string): string[] {
  const lower = name.toLowerCase();
  const mixed = lower.replace(
    /(^|_)([a-z])/g,
    (_match: string, edge: string, letter: string) => edge + letter.toUpperCase(),
  );
  return [name, lower, mixed];
}

let standIns: StandIns;
let restore: () => void;
let workdir: string;
let home: string;

beforeAll(() => {
  standIns = new StandIns(['gh']);
  home = process.cwd();
});

afterAll(() => {
  standIns.remove();
});

beforeEach(() => {
  restore = isolate(standIns);
  standIns.clear();
  // No case runs in the repository, so no .env file there reaches a child.
  workdir = mkdtempSync(join(tmpdir(), 'gate-github-'));
  process.chdir(workdir);
});

afterEach(() => {
  process.chdir(home);
  rmSync(workdir, { recursive: true, force: true });
  restore();
});

/* ///// Clearing ///// */

test.each([...CLEARED])('takeTokens removes %s in every spelling', (name: string) => {
  const environment: Record<string, string | undefined> = { KEEP_ME: 'kept' };
  for (const spelling of variants(name)) {
    environment[spelling] = `canary-${spelling}`;
  }

  takeTokens(environment);

  expect(spellings(environment, name)).toEqual([]);
  expect(environment['KEEP_ME']).toBe('kept');
});

test('takeTokens leaves every name the rule does not clear', () => {
  const others = ['PATH', 'GH_HOST', 'GITHUB_TOKEN_FILE', 'MY_GH_TOKEN', 'GH_TOKENS', 'ZIZMOR_CONFIG'];
  const environment: Record<string, string | undefined> = Object.fromEntries(
    others.map((name) => [name, `value-${name}`]),
  );

  takeTokens(environment);

  expect(Object.keys(environment).sort()).toEqual([...others].sort());
});

test("takeTokens returns gh's own two as the environment held them, and nothing else", () => {
  const environment: Record<string, string | undefined> = Object.fromEntries(
    CLEARED.map((name) => [name, `canary-${name}`]),
  );

  const kept = takeTokens(environment);

  expect(Object.keys(kept).sort()).toEqual([...GH_OWN].sort());
  for (const name of GH_OWN) {
    expect(kept[name]).toBe(`canary-${name}`);
  }
});

test("takeTokens returns neither of gh's two when the environment held neither", () => {
  const kept = takeTokens({ PATH: '/bin' });

  expect(kept['GH_TOKEN']).toBeUndefined();
  expect(kept['GITHUB_TOKEN']).toBeUndefined();
});

/** Starts Bun on `code` with `extra` beside the isolated environment, and returns its stdout. */
function child(code: string, extra: Readonly<Record<string, string>>): string {
  const finished = Bun.spawnSync({
    cmd: [process.execPath, '--no-env-file', '-e', code],
    cwd: workdir,
    env: { ...process.env, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  expect(finished.exitCode).toBe(0);
  return finished.stdout.toString().trim();
}

const MODULE = JSON.stringify(join(import.meta.dir, 'github.ts'));

test.each([0, 1, 2])(
  'loading the module clears every name from the environment, spelling %i of each',
  (index: number) => {
    const extra: Record<string, string> = { GATE_UNRELATED: 'kept' };
    for (const name of CLEARED) {
      extra[variants(name)[index] ?? name] = `canary-${name}`;
    }

    const printed = child(`await import(${MODULE}); console.log(JSON.stringify(Object.keys(process.env)));`, extra);
    const survivors = JSON.parse(printed) as string[];

    for (const name of CLEARED) {
      expect(spellings(Object.fromEntries(survivors.map((key) => [key, ''])), name)).toEqual([]);
    }
    expect(survivors).toContain('GATE_UNRELATED');
  },
);

/* ///// What gh is handed ///// */

test('githubToken hands gh exactly GH_TOKEN and GITHUB_TOKEN, as given', () => {
  standIns.answer('gh', { stdout: 'token-from-gh\n' });

  githubToken(standIns.path('gh'), { GH_TOKEN: 'canary-gh', GITHUB_TOKEN: 'canary-github' });

  const calls = standIns.calls();
  expect(calls.map((call) => call.args)).toEqual([['auth', 'token']]);
  const env = calls[0]?.env ?? {};
  expect(env['GH_TOKEN']).toBe('canary-gh');
  expect(env['GITHUB_TOKEN']).toBe('canary-github');
  for (const name of NOT_GH_OWN) {
    expect(spellings(env, name)).toEqual([]);
  }
});

test('githubToken hands gh neither name, in any spelling, when the gate started with neither', () => {
  standIns.answer('gh', { exitCode: 1 });
  process.env['gh_token'] = 'stray';
  process.env['Github_Token'] = 'stray';

  githubToken(standIns.path('gh'), { GH_TOKEN: undefined, GITHUB_TOKEN: undefined });

  const env = standIns.calls()[0]?.env ?? {};
  expect(standIns.calls()).toHaveLength(1);
  for (const name of CLEARED) {
    expect(spellings(env, name)).toEqual([]);
  }
});

test('the gate hands gh the two names it started with, and no child the other four', () => {
  standIns.answer('gh', { stdout: 'token-from-gh\n' });
  const extra = Object.fromEntries(CLEARED.map((name) => [name, `canary-${name}`]));

  const printed = child(
    `const { githubToken } = await import(${MODULE}); console.log(githubToken(${JSON.stringify(standIns.path('gh'))}) ?? 'none');`,
    extra,
  );

  expect(printed).toBe('token-from-gh');
  const env = standIns.calls()[0]?.env ?? {};
  for (const name of GH_OWN) {
    expect(env[name]).toBe(`canary-${name}`);
  }
  for (const name of NOT_GH_OWN) {
    expect(spellings(env, name)).toEqual([]);
  }
});

/* ///// What gh answers ///// */

interface AnswerCase {
  readonly label: string;
  readonly answer: Answer;
  readonly expected: string | undefined;
}

const ANSWERS: readonly AnswerCase[] = [
  {
    label: 'a token on exit 0 is the token, trimmed',
    answer: { stdout: '  token-from-gh\n' },
    expected: 'token-from-gh',
  },
  { label: 'a failed gh is no token', answer: { stdout: 'token-from-gh\n', exitCode: 1 }, expected: undefined },
  { label: 'a silent gh is no token', answer: { stdout: '' }, expected: undefined },
  { label: 'a gh printing only whitespace is no token', answer: { stdout: ' \n\t\n' }, expected: undefined },
];

test.each([...ANSWERS])('$label', ({ answer, expected }: AnswerCase) => {
  standIns.answer('gh', answer);

  expect(githubToken(standIns.path('gh'), { GH_TOKEN: undefined, GITHUB_TOKEN: undefined })).toBe(expected);
  expect(standIns.calls()).toHaveLength(1);
});

test('a missing gh is no token', () => {
  const absent = join(standIns.dir, launcherName('absent'));

  expect(githubToken(absent, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined })).toBeUndefined();
  expect(standIns.calls()).toEqual([]);
});

test('a gh that outlives the deadline is no token, and the deadline ends the wait', async () => {
  const sleepMs = 3_000;
  standIns.answer('gh', { stdout: 'late-token\n', sleepMs });
  const started = performance.now();

  const token = githubToken(standIns.path('gh'), { GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, 300);
  const waited = performance.now() - started;
  // The stand-in outlives its killed launcher on Windows; let it finish.
  await Bun.sleep(sleepMs);

  expect(token).toBeUndefined();
  expect(waited).toBeLessThan(sleepMs);
});
