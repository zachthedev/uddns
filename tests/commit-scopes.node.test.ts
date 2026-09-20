import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Paths are strings rather than URL instances: this project's types carry both
 * the Workers URL and node's, and readFileSync accepts only the second.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repository file by its path from the root, as committed. */
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

/**
 * Where the vocabulary lives. commitlint.config.js reads it and CONTRIBUTING.md
 * names it, so this suite holds all three to the one path.
 */
const VOCABULARY_PATH = '.github/commit-scopes.json';

/** One scope and what it covers, which is the shape of every entry in the file. */
interface ScopeEntry {
  readonly scope: string;
  readonly covers: string;
}

const isScopeEntry = (value: unknown): value is ScopeEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)['scope'] === 'string' &&
  typeof (value as Record<string, unknown>)['covers'] === 'string';

/**
 * The vocabulary, read from the file that defines it. A literal copy here
 * would be a second place the list lives, which is the drift this suite exists
 * to catch.
 */
const vocabulary = JSON.parse(read(VOCABULARY_PATH)) as unknown;

/**
 * The scope names the well-formed entries carry. A malformed entry is reported
 * by the shape test and drops out here, so the tests below still run and name
 * the scope it would have contributed.
 */
const scopes: string[] = Array.isArray(vocabulary) ? vocabulary.filter(isScopeEntry).map((entry) => entry.scope) : [];

const commitlintConfigSource = read('commitlint.config.js');

/** Enough scope names in one document to count as a restatement of the list. */
const RESTATEMENT_THRESHOLD = 3;

/** The shape of a scope name, which is also what makes one recognizable in prose. */
const SCOPE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Every markdown file in a directory, as paths from the repository root. */
const markdownIn = (directory: string, recursive: boolean): string[] =>
  readdirSync(join(REPO_ROOT, directory), { recursive, encoding: 'utf8' })
    .map((entry: string) => `${directory}${entry.split(sep).join('/')}`)
    .filter((path: string) => path.endsWith('.md'));

/** Every markdown document that could restate the list, keyed by its path from the root. */
const documents = new Map<string, string>(
  [...markdownIn('', false), ...markdownIn('docs/', false), ...markdownIn('.github/', true)].map((path) => [
    path,
    read(path),
  ]),
);

/** Every inline-code token in the text that is one of the vocabulary's scopes. */
const scopesMentionedIn = (text: string, names: readonly string[]): string[] =>
  names.filter((scope) => text.includes(`\`${scope}\``));

describe('the commit scope vocabulary', () => {
  it('is a non-empty array of entries that each name a scope and what it covers', () => {
    expect(Array.isArray(vocabulary), `${VOCABULARY_PATH} must hold an array`).toBe(true);
    const entries = vocabulary as unknown[];

    expect(entries.length, `${VOCABULARY_PATH} lists no scope`).toBeGreaterThan(0);
    expect(
      entries.filter((entry) => !isScopeEntry(entry)),
      `every entry of ${VOCABULARY_PATH} is an object with string "scope" and "covers" properties`,
    ).toEqual([]);
    expect(
      entries.filter((entry): entry is ScopeEntry => isScopeEntry(entry) && entry.covers.trim().length === 0),
      'a scope that says nothing about what it covers',
    ).toEqual([]);
  });

  it('names unique, sorted, kebab-case scopes', () => {
    expect(scopes.filter((scope) => !SCOPE_NAME.test(scope))).toEqual([]);
    expect(scopes.filter((scope, index) => scopes.indexOf(scope) !== index)).toEqual([]);
    expect(scopes).toEqual([...scopes].sort());
  });

  it('reaches commitlint by reference, with no scope named in the config', () => {
    expect(commitlintConfigSource).toContain(VOCABULARY_PATH);

    const restated = scopes.filter(
      (scope) => commitlintConfigSource.includes(`'${scope}'`) || commitlintConfigSource.includes(`"${scope}"`),
    );
    expect(restated, 'commitlint.config.js must read the vocabulary, not restate it').toEqual([]);
  });

  it('is the list commitlint enforces', async () => {
    // Loading the config runs the read it performs for a real commit, so
    // this asserts the rule commitlint applies rather than the text of it.
    const config = (await import('../commitlint.config.js')) as { default: { rules: Record<string, unknown> } };

    expect(config.default.rules['scope-enum']).toEqual([2, 'always', scopes]);
  });
});

describe('the contributor guide', () => {
  it('points at the vocabulary file by path', () => {
    expect(
      read('CONTRIBUTING.md'),
      `CONTRIBUTING.md must name \`${VOCABULARY_PATH}\`, which is where a contributor finds the scopes`,
    ).toContain(`\`${VOCABULARY_PATH}\``);
  });

  /**
   * The guide names commands and never the steps behind them, so the only
   * thing that can drift is a script name. Every name it uses must exist.
   */
  it('names only scripts that package.json defines', () => {
    const guide = read('CONTRIBUTING.md');
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const named = [...new Set([...guide.matchAll(/bun run ([a-z][a-z0-9:-]*)/g)].map((match) => match[1]))].filter(
      (name): name is string => name !== undefined,
    );

    expect(named.length, 'CONTRIBUTING.md names no `bun run` script, so this binding asserts nothing').toBeGreaterThan(
      0,
    );
    expect(
      named.filter((name) => !(name in scripts)),
      'CONTRIBUTING.md names a script that package.json does not define',
    ).toEqual([]);
  });
});

describe('documentation', () => {
  it('restates the vocabulary nowhere', () => {
    // The file is the only copy. A document that lists the scopes is a second
    // copy, and a second copy drifts the way any duplicate list does.
    for (const [path, source] of documents) {
      const mentioned = scopesMentionedIn(source, scopes);

      expect(
        mentioned.length < RESTATEMENT_THRESHOLD,
        `${path} names ${String(mentioned.length)} scopes (${mentioned.join(', ')}); point at ${VOCABULARY_PATH} rather than listing them`,
      ).toBe(true);
    }
  });
});
