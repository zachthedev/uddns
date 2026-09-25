// This repository's own call sites for the gate and its installs. The shared
// gate tests beside this file hold no name of this repository's.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTS } from './check';

const ROOT = join(import.meta.dir, '..');

type Table = Record<string, unknown>;

/** `value` as a mapping, or a fixture error naming `what`. */
function table(value: unknown, what: string): Table {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`fixture: ${what} is not a mapping`);
  }
  return value as Table;
}

/** `value` as a list of mappings, or a fixture error naming `what`. */
function tables(value: unknown, what: string): Table[] {
  if (!Array.isArray(value)) {
    throw new Error(`fixture: ${what} is not a list`);
  }
  return value.map((item: unknown) => table(item, what));
}

/** The parsed YAML file at `path` below the root. */
function yaml(path: string): Table {
  return table(Bun.YAML.parse(readFileSync(join(ROOT, path), 'utf8')), path);
}

/** The steps of `job` in the workflow at `path`. */
function steps(path: string, job: string): Table[] {
  return tables(
    table(table(yaml(path)['jobs'], `${path} jobs`)[job], `${path} ${job}`)['steps'],
    `${path} ${job} steps`,
  );
}

/** The one step named `name` among `list`. */
function step(list: readonly Table[], name: string): Table {
  const found = list.filter((item) => item['name'] === name);
  expect(found).toHaveLength(1);
  return found[0] ?? {};
}

/** The index of the one step among `list` that uses `action`, at any ref. */
function using(list: readonly Table[], action: string): number {
  const found = list.flatMap((item, index) =>
    typeof item['uses'] === 'string' && item['uses'].startsWith(`${action}@`) ? [index] : [],
  );
  expect(found).toHaveLength(1);
  return found[0] ?? -1;
}

/** Every `run` value among `list`, in order. */
function runs(list: readonly Table[]): unknown[] {
  return list.filter((item) => 'run' in item).map((item) => item['run']);
}

// The script runner puts node_modules/.bin first on PATH, so a committed bun
// there would run in place of the gate. The call sites that decide a merge
// start the file with a bare bun.
test("CI's gate job starts the gate file itself, not through the script runner", () => {
  expect(runs(steps('.github/workflows/ci.yml', 'gate')).at(-1)).toBe('bun --no-env-file scripts/check.ts');
});

test('the push hook starts the gate file itself, in its quick form', () => {
  const jobs = tables(table(yaml('lefthook.yml')['pre-push'], 'pre-push')['jobs'], 'pre-push jobs');

  expect(step(jobs, 'check')['run']).toBe('bun --no-env-file scripts/check.ts --quick');
});

// mise-action runs mise in a workspace it trusts, so a pull request's
// mise.toml would load there before the gate refuses it.
test("CI's gate job starts mise before the checkout, and exports nothing mise.toml sets", () => {
  const list = steps('.github/workflows/ci.yml', 'gate');
  const mise = using(list, 'jdx/mise-action');

  expect(mise).toBeLessThan(using(list, 'actions/checkout'));
  expect(table(list[mise]?.['with'], 'mise-action with')).toMatchObject({
    install: false,
    cache: false,
    github_token: '',
    env: false,
    export_path: false,
    add_shims_to_path: false,
  });
});

test('the ci workflow pins the four mise config names for every step', () => {
  expect(yaml('.github/workflows/ci.yml')['env']).toEqual({
    MISE_OVERRIDE_CONFIG_FILENAMES: 'mise.toml',
    MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: 'none',
    MISE_ENV: '',
    MISE_AUTO_ENV: 'false',
  });
});

// The job's whole run list, so an install anywhere in it, prefixed by another
// command or on a later line of a step, fails the case.
test.each([
  [
    '.github/workflows/ci.yml',
    'gate',
    ['bun install --frozen-lockfile --ignore-scripts', 'bun --no-env-file scripts/check.ts'],
  ],
  ['.github/workflows/cd.yml', 'deploy', ['bun install --frozen-lockfile --ignore-scripts', 'bun run deploy']],
])('%s job %s installs once, with no install script', (path: string, job: string, expected: string[]) => {
  expect(runs(steps(path, job))).toEqual(expected);
});

test('the package scripts a contributor runs start the gate file', () => {
  const manifest = table(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')), 'package.json');
  const scripts = table(manifest['scripts'], 'package.json scripts');

  expect([scripts['check'], scripts['check:quick'], scripts['check:rows']]).toEqual([
    'bun --no-env-file scripts/check.ts',
    'bun --no-env-file scripts/check.ts --quick',
    'bun --no-env-file scripts/check.ts --rows',
  ]);
});

// A project the typecheck script names and the gate does not is checked by
// hand and skipped in CI, so the two lists are one list.
test("the typecheck script checks the gate's projects, in the gate's order", () => {
  const manifest = table(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')), 'package.json');
  const script = table(manifest['scripts'], 'package.json scripts')['typecheck'];
  if (typeof script !== 'string') {
    throw new Error('fixture: package.json has no typecheck script');
  }

  const named = [...script.matchAll(/(?:^|\s)(?:-p|--project)\s+(\S+)/g)].map((match) => match[1]);

  expect(named).toEqual([...PROJECTS]);
});
