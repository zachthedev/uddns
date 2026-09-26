// This repository's own call sites for the gate. The shared gate tests beside
// this file hold no name of this repository's.

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

/** The one step named `name` among `list`. */
function step(list: readonly Table[], name: string): Table {
  const found = list.filter((item) => item['name'] === name);
  expect(found).toHaveLength(1);
  return found[0] ?? {};
}

// The script runner puts node_modules/.bin first on PATH, so a committed bun
// there would run in place of the gate. The push hook starts the file with a
// bare bun.
test('the push hook starts the gate file itself, in its quick form', () => {
  const jobs = tables(table(yaml('lefthook.yml')['pre-push'], 'pre-push')['jobs'], 'pre-push jobs');

  expect(step(jobs, 'check')['run']).toBe('bun --no-env-file scripts/check.ts --quick');
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
