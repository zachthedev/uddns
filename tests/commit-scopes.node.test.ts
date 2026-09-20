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
 * The scope vocabulary, read from the file that defines it. A literal copy here
 * would be a second place the list lives, which is the drift this suite exists
 * to catch.
 */
const { scopes } = JSON.parse(read('.github/commit-scopes.json')) as { scopes: unknown };

const commitlintConfigSource = read('commitlint.config.js');

/**
 * Prose restates the vocabulary for a human reader, so a document wraps its
 * list in these markers and this suite holds the two together. They are HTML
 * comments, so nothing shows once the markdown renders.
 */
const REGION = /<!--\s*commit-scopes:start\s*-->([\s\S]*?)<!--\s*commit-scopes:end\s*-->/;

/** Enough scope names in one document to count as a restatement of the list. */
const RESTATEMENT_THRESHOLD = 3;

/** The shape of a scope name, which is also what makes one recognizable in prose. */
const SCOPE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Every markdown file in a directory, as paths from the repository root. */
const markdownIn = (directory: string, recursive: boolean): string[] =>
  readdirSync(join(REPO_ROOT, directory), { recursive, encoding: 'utf8' })
    .map((entry: string) => `${directory}${entry.split(sep).join('/')}`)
    .filter((path: string) => path.endsWith('.md'));

/** Every markdown document that could carry the list, keyed by its path from the root. */
const documents = new Map<string, string>(
  [...markdownIn('', false), ...markdownIn('docs/', false), ...markdownIn('.github/', true)].map((path) => [
    path,
    read(path),
  ]),
);

/** The scope a documentation line names, which is its first inline-code token. */
const namedScope = (line: string): string | undefined => /`([^`]+)`/.exec(line)?.[1];

/** Each document carrying a marked region, paired with the region's contents. */
const documentsWithRegion = (): [string, string][] =>
  [...documents]
    .map(([path, source]): [string, string | undefined] => [path, REGION.exec(source)?.[1]])
    .filter((entry): entry is [string, string] => entry[1] !== undefined);

/** Every inline-code token in the text that is one of the vocabulary's scopes. */
const scopesMentionedIn = (text: string, vocabulary: readonly string[]): string[] =>
  vocabulary.filter((scope) => text.includes(`\`${scope}\``));

describe('the commit scope vocabulary', () => {
  it('is a non-empty list of unique, sorted, kebab-case scopes', () => {
    expect(Array.isArray(scopes)).toBe(true);
    const list = scopes as string[];

    expect(list.length).toBeGreaterThan(0);
    expect(list.filter((scope) => !SCOPE_NAME.test(scope))).toEqual([]);
    expect(list.filter((scope, index) => list.indexOf(scope) !== index)).toEqual([]);
    expect(list).toEqual([...list].sort());
  });

  it('reaches commitlint by reference, with no scope named in the config', () => {
    expect(commitlintConfigSource).toContain('.github/commit-scopes.json');

    const restated = (scopes as string[]).filter(
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

describe('documentation that restates the vocabulary', () => {
  it('is bound to at least one document', () => {
    // A binding that skips every document asserts nothing while reading
    // green, so the absence of any region is itself the failure.
    expect(
      documentsWithRegion().length,
      'no document carries a commit-scopes region, so this binding asserts nothing; wrap the scope list in <!-- commit-scopes:start --> and <!-- commit-scopes:end --> in the document that publishes it',
    ).toBeGreaterThan(0);
  });

  it('lists exactly the vocabulary inside every commit-scopes region', () => {
    const vocabulary = scopes as string[];

    for (const [path, region] of documentsWithRegion()) {
      const documented = region
        .split('\n')
        .map(namedScope)
        .filter((token): token is string => token !== undefined && SCOPE_NAME.test(token));

      expect(
        documented.filter((scope) => !vocabulary.includes(scope)),
        `${path} documents a scope the vocabulary omits`,
      ).toEqual([]);
      expect(
        vocabulary.filter((scope) => !documented.includes(scope)),
        `${path} omits a scope the vocabulary defines`,
      ).toEqual([]);
    }
  });

  it('keeps every prose list of scopes inside a region', () => {
    const vocabulary = scopes as string[];

    for (const [path, source] of documents) {
      const outside = source.replace(REGION, '');
      const mentioned = scopesMentionedIn(outside, vocabulary);

      expect(
        mentioned.length < RESTATEMENT_THRESHOLD,
        `${path} names ${String(mentioned.length)} scopes (${mentioned.join(', ')}) outside a commit-scopes region; wrap the list in <!-- commit-scopes:start --> and <!-- commit-scopes:end --> so this suite binds it to .github/commit-scopes.json`,
      ).toBe(true);
    }
  });
});

describe('the contributor guide', () => {
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
