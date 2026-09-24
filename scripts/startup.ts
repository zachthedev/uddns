/**
 * The files Bun and the gate's tools read before they run, refused where they
 * would change what a row checks: a file a tool without a named config would
 * read, a key in bunfig.toml, package.json or .prettierrc that runs or swaps
 * code, what resolves the gate's own imports, and the root's program names.
 *
 * @remarks
 * The gate calls {@link trackedFindings} and {@link startupFindings} before
 * any row, so this file and everything it imports read Bun and `node:`
 * built-ins alone. A package imported here would load from node_modules before
 * the check that refuses a planted one. No config's text is held here:
 * code-owner review is the control on a change to one. The comparison helpers
 * here serve tools.ts too, which holds mise.toml and mise.lock. What differs
 * between repositories of the set lives in expected.ts.
 */

import type { Dirent } from 'node:fs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EXPECTED_PROJECT_CONFIGS, EXPECTED_UNTYPED_SOURCES } from './expected';
import { describe, fold, isProgramName, quote, run } from './run';

/** The file pinning a version for every tool mise installs. */
export const PINS = 'mise.toml';

/** The file holding a checksum, a url and a backend per platform for every pinned tool. */
export const LOCK = 'mise.lock';

/** The manifest Bun and bun install read. */
const PACKAGE_JSON = 'package.json';

/** The project's TypeScript config, which the typecheck row names with `--project`. */
export const TSCONFIG = 'tsconfig.json';

/** The one Prettier config, which every Prettier run names with `--config`. */
export const PRETTIERRC = '.prettierrc';

/** The one Prettier ignore file, which every Prettier run names with `--ignore-path`. */
export const PRETTIERIGNORE = '.prettierignore';

/** The one ESLint config, which the lint row and the commit hook name with `--config`. */
export const ESLINT_CONFIG = 'eslint.config.ts';

/** The one taplo config, which the toml row names with `--config`. */
export const TAPLO_CONFIG = '.taplo.toml';

/** The one zizmor config, which the workflows row names with `--config`. */
export const ZIZMOR_CONFIG = '.github/zizmor.yml';

/** The one lefthook config, which lefthook reads first of every name it searches. */
const LEFTHOOK_CONFIG = 'lefthook.yml';

/** The root files a repository carries under a program's name: the lockfile Bun writes and the two mise files. */
const PROGRAM_NAMED_FILES: readonly string[] = ['bun.lock', PINS, LOCK];

/* ///// Comparing parsed files ///// */

/** Whether `value`, parsed from TOML or JSON, is a table. */
export function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether two values parsed from TOML or JSON are the same: equal primitives, equal arrays item by item, tables with the same keys and equal values. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isTable(a) || isTable(b)) {
    if (!isTable(a) || !isTable(b)) {
      return false;
    }
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }
  return a === b;
}

/** Any value read from a file the gate checks, for a finding, through {@link quote}. */
export function quoteValue(value: unknown): string {
  if (value === undefined) {
    return 'nothing';
  }
  return quote(typeof value === 'string' ? value : JSON.stringify(value));
}

/** The entries of `path`, or none when it is a file rather than a directory. */
export async function directoryEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOTDIR') {
      return [];
    }
    throw error;
  }
}

/**
 * Every key that appears twice within one object of `text`, which is JSON
 * that parses.
 *
 * @remarks
 * Strings are skipped whole, and a key is decoded, so an escaped spelling
 * counts as the key it spells.
 */
function repeatedKeys(text: string): string[] {
  const repeated: string[] = [];
  // One entry per open object or array; an array has no keys.
  const open: (Set<string> | undefined)[] = [];
  let at = 0;
  while (at < text.length) {
    const character = text[at];
    if (character === '"') {
      let end = at + 1;
      while (text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      const token = text.slice(at, end + 1);
      at = end + 1;
      while (/\s/.test(text[at] ?? '')) {
        at++;
      }
      const keys = open.at(-1);
      if (keys !== undefined && text[at] === ':') {
        const key = String(JSON.parse(token));
        if (keys.has(key)) {
          repeated.push(key);
        }
        keys.add(key);
      }
      continue;
    }
    if (character === '{') {
      open.push(new Set());
    } else if (character === '[') {
      open.push(undefined);
    } else if (character === '}' || character === ']') {
      open.pop();
    }
    at++;
  }
  return repeated;
}

/**
 * `text` parsed as JSON, refusing a key repeated within one object.
 *
 * @remarks
 * Bun's package.json and tsconfig reader keeps the first of two equal keys,
 * and a JSON parser the last, so the gate refuses a file with a repeated key
 * rather than read it two ways.
 *
 * @throws When the text does not parse, or repeats a key
 */
function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const repeated = repeatedKeys(text);
  if (repeated.length > 0) {
    throw new Error(
      `it repeats ${repeated.map((key) => quote(key)).join(', ')} within one object, and Bun reads the first where a JSON parser reads the last`,
    );
  }
  return parsed;
}

/* ///// The tracked files ///// */

/** How many tracked paths under node_modules a finding names before it counts the rest. */
const NODE_MODULES_SHOWN = 5;

/**
 * The files Bun 1.4.2 loads into the environment of `bun run` from the
 * directory it starts in: the plain pair and each mode's pair.
 */
const BUN_ENV_FILES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
];

/** A program that reads a file it finds by name: the names it reads, and the one the gate names for it. */
interface ConfigSearch {
  /** What a refused file is, read after "is". */
  readonly what: string;
  /** Every path the program reads, as a pattern over the folded path: `*` is any run within one segment, and a leading `**` slash is any directory, the root included. */
  readonly paths: readonly string[];
  /** The one path the gate names for the program, which passes in this exact spelling alone. */
  readonly named?: string;
  /** What the program does with a refused file, read after "and". */
  readonly reads: string;
  /**
   * True for a file a contributor keeps on their own machine, refused only
   * when tracked. Every other file is refused on disk too, tracked or not.
   */
  readonly personal?: true;
}

/**
 * Every program the gate, its hooks or an install start that reads a file it
 * finds by name and takes no flag naming one, with every name it reads,
 * measured on the pinned versions.
 *
 * @remarks
 * Prettier, ESLint, commitlint, taplo and zizmor each run with their one
 * config named, and the named form stops every other name each reads, so none
 * is listed here. actionlint, lefthook, bun install and Bun's env loader take
 * no config flag, so every other name they read is refused. The patterns reach
 * past each program's own search where that costs nothing, to any directory
 * and any extension. The root `.config` directory, which mise, lefthook and
 * cosmiconfig read whatever a flag names, is refused whole on its own.
 */
const CONFIG_SEARCHES: readonly ConfigSearch[] = [
  {
    what: 'an env file Bun loads',
    paths: BUN_ENV_FILES.map((name) => `**/${name}`),
    reads: 'Bun loads it into the environment of every bun run started beside it',
    personal: true,
  },
  {
    what: 'an .npmrc',
    paths: ['**/.npmrc'],
    reads: 'bun install fetches from the registry it names',
    personal: true,
  },
  {
    what: 'an actionlint config',
    paths: ['.github/actionlint.yaml', '.github/actionlint.yml'],
    reads: 'actionlint reads it, and it can ignore any finding by pattern, ShellCheck included',
  },
  {
    what: 'a lefthook config',
    paths: ['lefthook', 'lefthook.*', '.lefthook', '.lefthook.*'],
    named: LEFTHOOK_CONFIG,
    reads: 'lefthook reads it in place of lefthook.yml when that file is missing',
  },
  {
    what: 'a local lefthook config',
    paths: ['lefthook-local', 'lefthook-local.*', '.lefthook-local', '.lefthook-local.*'],
    reads: 'lefthook merges it over lefthook.yml, where it can replace any hook job. .gitignore lists it',
    personal: true,
  },
  {
    what: "Claude Code's local settings",
    paths: ['.claude/settings.local.json'],
    reads: "Claude Code reads it as one contributor's own settings. .gitignore lists it",
    personal: true,
  },
];

/** `glob`, one of a {@link ConfigSearch}'s paths, as a pattern over a whole folded path. */
function searchPattern(glob: string): RegExp {
  const anywhere = glob.startsWith('**/');
  const body = (anywhere ? glob.slice(3) : glob)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${body}$`);
}

/**
 * The root paths of every personal file {@link CONFIG_SEARCHES} names, each as
 * a pattern with the number of segments it spans. .prettierignore skips each
 * one, and anything below it.
 */
const PERSONAL_ROOTS: readonly { readonly pattern: RegExp; readonly depth: number }[] = CONFIG_SEARCHES.filter(
  (search) => search.personal === true,
)
  .flatMap((search) => search.paths)
  .filter((path) => !path.startsWith('**/'))
  .map((path) => ({ pattern: searchPattern(path), depth: path.split('/').length }));

/**
 * The folded root path of the {@link PERSONAL_ROOTS} entry that `segments`,
 * a folded path, sits below, or undefined when it sits below none. A file at
 * such a path itself is refused as the personal file.
 */
function personalRoot(segments: readonly string[]): string | undefined {
  return PERSONAL_ROOTS.map(({ pattern, depth }) => ({
    pattern,
    root: segments.slice(0, depth).join('/'),
    depth,
  })).find(({ pattern, root, depth }) => segments.length > depth && pattern.test(root))?.root;
}

/** Every way the tracked `package.json` at `path` patches a package, as findings. */
function packageKeyFindings(path: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseJson(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    // Unreadable, malformed or read two ways: refused, since whether it names a patch is unknown.
    return [
      `${quote(path)} does not parse as the gate reads it, so whether it patches a package is unknown: ${quote(error instanceof Error ? error.message : String(error))}`,
    ];
  }
  const manifest = isTable(parsed) ? parsed : {};
  const found: string[] = [];
  if (Object.hasOwn(manifest, PATCHES_KEY)) {
    found.push(
      `${quote(path)} carries a ${PATCHES_KEY} key, and bun install applies each patch it names over the package bun.lock pins, so a tool a row runs can change while its pin stays the same. Remove it`,
    );
  }
  return found;
}

/**
 * The `package.json` key bun install reads patches from. A patch bun.lock
 * records with no entry here is not applied, so the manifest is the file read.
 */
const PATCHES_KEY = 'patchedDependencies';

/** The names Bun and typescript-eslint read a project's TypeScript options from. */
const PROJECT_CONFIG_NAMES: readonly string[] = ['tsconfig.json', 'jsconfig.json'];

/** The compiler options that send a bare import somewhere other than node_modules, folded. */
const REDIRECTING_OPTIONS: readonly string[] = ['paths', 'baseurl'];

/**
 * The file an `extends` entry in the config at `from` names, or why the gate
 * refuses it: a path relative to the config, as written or with `.json` added,
 * whose canonical path lies inside the checkout.
 *
 * @remarks
 * A package's config or a file outside the checkout is one this read cannot
 * hold, and a missing one is refused rather than read as nothing, so each is
 * a finding.
 */
function extendedConfig(from: string, target: unknown): { readonly file: string } | { readonly refused: string } {
  if (typeof target !== 'string' || !/^\.\.?[\\/]/.test(target)) {
    return {
      refused: `names ${quoteValue(target)} in extends, and the gate follows a path relative to the config alone, never a package or an absolute path`,
    };
  }
  const directory = dirname(from);
  const file = [resolve(directory, target), resolve(directory, `${target}.json`)].find((candidate) =>
    existsSync(candidate),
  );
  if (file === undefined) {
    return { refused: `names ${quote(target)} in extends, and no such file exists` };
  }
  const inside = relative(realpathSync.native('.'), realpathSync.native(file));
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return { refused: `names ${quote(target)} in extends, and it resolves outside the checkout` };
  }
  return { file };
}

/**
 * Every way the project config at `config`, or a config its `extends` chain
 * reads, sets an option in {@link REDIRECTING_OPTIONS} or reaches a config
 * the gate cannot read, as findings. `file` is the config read at this step,
 * and `seen` the ones read before it, so a cycle ends.
 *
 * @remarks
 * Bun applies `paths` and `baseUrl` to every import in the directory below the
 * config, node_modules code included, so under Bun a bare package name a
 * commit hook's tool imports resolves to repository code. `extends` is one
 * path or a list, and the gate follows every entry inside the checkout. The
 * set's project configs are plain JSON, so a comment is refused with any other
 * text JSON does not parse. A key is compared through {@link fold}, and a file
 * that repeats a key is refused, so no spelling Bun reads differently passes.
 */
function redirectFindings(config: string, file: string, seen: Set<string>): string[] {
  const at = resolve(file);
  if (seen.has(at)) {
    return [];
  }
  seen.add(at);
  const shown =
    file === config ? quote(config) : `${quote(config)}, through ${quote(relative('.', at).replaceAll('\\', '/'))},`;
  let parsed: unknown;
  try {
    parsed = parseJson(readFileSync(at, 'utf8'));
  } catch (error: unknown) {
    return [
      `${shown} does not parse as plain JSON, so whether Bun redirects an import through it is unknown: ${quote(error instanceof Error ? error.message : String(error))}`,
    ];
  }
  if (!isTable(parsed)) {
    return [];
  }
  const found: string[] = [];
  const options = parsed['compilerOptions'];
  if (isTable(options)) {
    for (const key of Object.keys(options).filter((name) => REDIRECTING_OPTIONS.includes(fold(name)))) {
      found.push(
        `${shown} sets compilerOptions.${key}, and Bun applies it to every import below it, node_modules code included, so a bare package name can resolve to repository code. Alias through package.json imports (# names)`,
      );
    }
  }
  if (Object.hasOwn(parsed, 'extends')) {
    const extended = parsed['extends'];
    for (const target of Array.isArray(extended) ? extended : [extended]) {
      const next = extendedConfig(at, target);
      if (!('file' in next)) {
        found.push(`${shown} ${next.refused}`);
        continue;
      }
      found.push(...redirectFindings(config, next.file, seen));
    }
  }
  return found;
}

/**
 * Every finding against the project config at `path`: one outside the paths
 * expected.ts names is refused, and a named one is read through its `extends`
 * chain.
 *
 * @remarks
 * typescript-eslint reads the project config nearest each file it lints, and
 * no flag names another, so one at an unnamed path changes what the lint row
 * reports. The rule is where a config sits, never what it holds.
 */
function projectConfigFindings(path: string): string[] {
  if (path !== SCRIPTS_TSCONFIG && !EXPECTED_PROJECT_CONFIGS.includes(path)) {
    return [
      `${quote(path)} is a TypeScript project config outside the paths scripts/expected.ts names, and typescript-eslint reads the nearest one for each file it lints while Bun applies its paths and baseUrl to every import below it. Name it in scripts/expected.ts, or remove it`,
    ];
  }
  return redirectFindings(path, path, new Set());
}

/**
 * The directory names a version control system keeps its own data in.
 * Prettier's CLI skips a file it is handed under one without a word, while
 * its getFileInfo accepts it, so the format row would count a file it never
 * checked.
 */
const VCS_DIRECTORIES: readonly string[] = ['.git', '.sl', '.svn', '.hg', '.jj'];

/**
 * The root directories the lint and format rows skip: ESLint's globalIgnores
 * and .prettierignore name each. A checkout fills them locally, and a file
 * force-added there is tracked like any other, which the product can import.
 */
const SKIPPED_DIRECTORIES: readonly string[] = ['dist', 'coverage', '.claude/worktrees'];

/**
 * A JavaScript or declaration file, by the end of its folded name: `.js`,
 * `.jsx`, `.mjs`, `.cjs`, `.d.ts`, `.d.mts`, `.d.cts`, and a declaration for
 * another extension such as `.d.css.ts`.
 */
const UNTYPED_SOURCE = /\.(?:[cm]?jsx?|d\.(?:[^./]+\.)?[cm]?ts)$/;

/** The directory GitHub reads workflows from, which reads one whose name ends in lowercase `.yml` here. */
const WORKFLOWS = '.github/workflows';

/**
 * An inline zizmor waiver, which zizmor honors in any file it audits. Spaces
 * and case are allowed to differ, so a spelling zizmor might read never
 * passes.
 */
const ZIZMOR_IGNORE_COMMENT = /zizmor\s*:\s*ignore\s*\[/i;

/**
 * The `shell:` values a workflow may name. actionlint hands ShellCheck a
 * script whose shell is bash or sh, and pwsh is the one other shell the set
 * writes, so any other value runs a script no linter reads.
 */
const WORKFLOW_SHELLS: readonly string[] = ['bash', 'sh', 'pwsh'];

/**
 * Every `shell:` value in the workflow at `path` outside
 * {@link WORKFLOW_SHELLS}, as findings: under the workflow's `defaults.run`,
 * a job's `defaults.run`, or a step.
 *
 * @remarks
 * actionlint skips ShellCheck for a value such as `/bin/bash -e {0}`
 * although bash runs the script, so a value is held to the exact names. Bun's
 * YAML reader refuses some text actionlint's accepts, so a workflow it cannot
 * read is a finding rather than a pass.
 */
function shellFindings(path: string, text: string): string[] {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error: unknown) {
    return [
      `${quote(path)} does not parse as the gate reads YAML, so its shell values are unknown: ${quote(error instanceof Error ? error.message : String(error))}`,
    ];
  }
  if (!isTable(parsed)) {
    return [`${quote(path)} is not one YAML mapping as the gate reads it, so its shell values are unknown`];
  }
  const shells: (readonly [string, unknown])[] = [];
  const defaultShell = (where: string, holder: unknown): void => {
    const defaults = isTable(holder) ? holder['defaults'] : undefined;
    const run = isTable(defaults) ? defaults['run'] : undefined;
    if (isTable(run) && Object.hasOwn(run, 'shell')) {
      shells.push([`${where}defaults.run.shell`, run['shell']]);
    }
  };
  defaultShell('', parsed);
  const jobs = parsed['jobs'];
  for (const [id, job] of isTable(jobs) ? Object.entries(jobs) : []) {
    defaultShell(`jobs.${id}.`, job);
    const steps = isTable(job) ? job['steps'] : undefined;
    for (const [index, step] of (Array.isArray(steps) ? (steps as unknown[]) : []).entries()) {
      if (isTable(step) && Object.hasOwn(step, 'shell')) {
        shells.push([`jobs.${id}.steps[${String(index)}].shell`, step['shell']]);
      }
    }
  }
  return shells
    .filter(([, value]) => typeof value !== 'string' || !WORKFLOW_SHELLS.includes(value))
    .map(
      ([where, value]) =>
        `${quote(path)} sets ${where} to ${quoteValue(value)}, and actionlint hands ShellCheck a bash or sh script alone. Use ${WORKFLOW_SHELLS.join(', ')}`,
    );
}

/**
 * Every way the tracked file at `path` falls outside what the workflows and
 * format rows read, as findings: a workflow whose path is not
 * `.github/workflows/<name>.yml` exactly, a workflow `shell:` value outside
 * {@link WORKFLOW_SHELLS}, an inline zizmor waiver under `.github`, a path
 * under a version control directory or one of {@link SKIPPED_DIRECTORIES},
 * and a JavaScript or declaration file expected.ts does not name.
 *
 * @remarks
 * actionlint and zizmor read a workflow by its lowercase `.yml` name alone,
 * so a `.YML` or `.yaml` one passes both unread. A zizmor waiver belongs in
 * zizmor.yml, the one place a reviewer reads waivers. A ShellCheck
 * directive is refused by scripts/shellcheck.ts, which reads each script as
 * ShellCheck does.
 */
function rowScopeFindings(path: string, segments: readonly string[]): string[] {
  const found: string[] = [];
  const folded = segments.join('/');
  const directory = segments.slice(0, -1).join('/');
  const present = segments[0] === '.github' && existsSync(path);
  const text = present ? readFileSync(path, 'utf8') : '';
  if (directory === WORKFLOWS && /\.ya?ml$/.test(folded)) {
    if (!(path.startsWith(`${WORKFLOWS}/`) && path.endsWith('.yml'))) {
      found.push(
        `${quote(path)} is a workflow outside ${WORKFLOWS}/<name>.yml, and actionlint and zizmor read that spelling alone. Rename it`,
      );
    }
    if (present) {
      found.push(...shellFindings(path, text));
    }
  }
  if (ZIZMOR_IGNORE_COMMENT.test(text)) {
    found.push(
      `${quote(path)} carries a zizmor ignore comment, and zizmor waives the audit it names. A waiver is an entry in ${ZIZMOR_CONFIG}`,
    );
  }
  const vcs = segments.slice(0, -1).find((segment) => VCS_DIRECTORIES.includes(segment));
  if (vcs !== undefined) {
    found.push(
      `${quote(path)} sits under a ${vcs} directory, and Prettier skips a file there without a word, so the format row would count a file it never checked. Move it`,
    );
  }
  const skipped = SKIPPED_DIRECTORIES.find((directory) => folded.startsWith(`${directory}/`));
  if (skipped !== undefined) {
    found.push(
      `${quote(path)} is tracked under ${skipped}/, which the lint and format rows skip, so no row checks it while the product can still import it. Remove it from the index with git rm --cached`,
    );
  }
  if (UNTYPED_SOURCE.test(folded) && !EXPECTED_UNTYPED_SOURCES.includes(path)) {
    found.push(
      `${quote(path)} is JavaScript or a declaration file, which tsc never checks, and ESLint lints no .jsx. Write it as TypeScript, or name it in scripts/expected.ts`,
    );
  }
  return found;
}

/** The variables git starts with, and nothing else: no system or global config. */
const GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  // /dev/null is the spelling Git for Windows reads as an empty file too.
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/** The paths one `git ls-files` call lists, split, or a finding when git fails. */
async function listFiles(args: readonly string[], what: string): Promise<string[] | string> {
  const listed = await run(['git', 'ls-files', '-z', ...args], GIT_ENVIRONMENT, { inherit: false });
  if (listed.exitCode !== 0) {
    return `git could not list the ${what} the gate refuses: it ${describe(listed)}`;
  }
  return [...new Set(listed.stdout.split('\0').filter((path) => path.length > 0))];
}

/**
 * A finding when git's work tree is not this checkout, or undefined when it
 * is, compared by canonical path.
 *
 * @remarks
 * git passes over a `.git` directory it cannot read, an empty one among them,
 * and uses the first repository above it, where `git ls-files` lists that
 * repository's files without a word. A `.git` file it cannot read fails
 * instead.
 */
async function topLevelFinding(): Promise<string | undefined> {
  const finished = await run(['git', 'rev-parse', '--show-toplevel'], GIT_ENVIRONMENT, { inherit: false });
  const top = finished.stdout.trim();
  if (finished.exitCode !== 0 || top.length === 0) {
    return `git could not name the work tree it reads: it ${describe(finished)}`;
  }
  let same: boolean;
  try {
    same = realpathSync.native(top) === realpathSync.native('.');
  } catch {
    // A top directory that cannot be resolved is not this checkout.
    same = false;
  }
  return same
    ? undefined
    : `git reads the work tree at ${quote(top)}, not this checkout, so every file it lists belongs to another repository. A .git here that git cannot read, such as an empty directory, sends it to one above. Run the gate from the root of a clone`;
}

/**
 * Every file in the tree the gate refuses to run beside, as findings: a file
 * a program in {@link CONFIG_SEARCHES} reads, a project config outside the
 * named paths or one that redirects a bare import, `patchedDependencies` in
 * any tracked `package.json`, a tracked path under a `node_modules`
 * directory, a `node_modules` directory on disk below the root, and a tracked
 * file outside what the workflows and format rows read.
 *
 * @remarks
 * git lists nothing until it names this checkout as its work tree, and a
 * work tree anywhere else is the one finding. It then lists the tracked files
 * once and the untracked ones on disk once, the ignored ones included,
 * outside the root node_modules and Claude Code's worktrees.
 * The gate compares each name through {@link fold}, since git's `icase`
 * pathspec magic folds ASCII alone. A config that changes what a row reports
 * is refused on disk, tracked or not, so a local gate agrees with CI, and a
 * personal file is refused only when tracked. git starts with its two config
 * switches and nothing else, so no variable an env file set reaches it. Bun
 * loads an env file into the gate's environment before the gate runs, so a
 * committed one sets variables for every process the gate starts. bun install
 * fetches from the registry an `.npmrc` names, and CI's install runs before
 * the gate. `bun install` keeps a committed file under `node_modules` in place
 * of what it would install, `bun run` puts `node_modules/.bin` ahead of PATH,
 * and a nearer `node_modules` shadows the installed package for the files
 * beside it.
 */
export async function trackedFindings(): Promise<string[]> {
  const top = await topLevelFinding();
  if (top !== undefined) {
    return [top];
  }
  const tracked = await listFiles([], 'tracked files');
  const untracked = await listFiles(
    ['--others', '--exclude=/node_modules/', '--exclude=/.claude/worktrees/'],
    'untracked files',
  );
  if (typeof tracked === 'string' || typeof untracked === 'string') {
    return [tracked, untracked].filter((entry) => typeof entry === 'string');
  }
  const trackedSet = new Set(tracked);
  const searches = CONFIG_SEARCHES.map((search) => ({ ...search, patterns: search.paths.map(searchPattern) }));
  const found: string[] = [];
  const modules: string[] = [];
  const nested = new Set<string>();
  for (const path of [...tracked, ...untracked.filter((entry) => !trackedSet.has(entry))]) {
    const isTracked = trackedSet.has(path);
    const segments = path.split('/').map(fold);
    // node_modules itself too: a tracked link by that name stands in for the whole directory.
    const at = segments.indexOf('node_modules');
    if (at >= 0) {
      if (isTracked) {
        modules.push(path);
      } else if (at > 0) {
        nested.add(
          path
            .split('/')
            .slice(0, at + 1)
            .join('/'),
        );
      }
      continue;
    }
    const folded = segments.join('/');
    const search = searches.find(
      (entry) =>
        (isTracked || entry.personal !== true) &&
        path !== entry.named &&
        entry.patterns.some((pattern) => pattern.test(folded)),
    );
    if (search !== undefined) {
      const remove = search.personal === true ? 'Remove it from the index with git rm --cached' : 'Remove it';
      found.push(`${quote(path)} is ${search.what}, and ${search.reads}. ${remove}`);
    }
    const under = isTracked ? personalRoot(segments) : undefined;
    if (under !== undefined) {
      found.push(
        `${quote(path)} is tracked under ${quote(under)}, a name .prettierignore skips as a personal file, so the format row never checks it. Remove it from the index with git rm --cached`,
      );
    }
    const base = segments.at(-1) ?? '';
    if (PROJECT_CONFIG_NAMES.includes(base)) {
      found.push(...projectConfigFindings(path));
    }
    if (isTracked) {
      if (base === PACKAGE_JSON && existsSync(path)) {
        found.push(...packageKeyFindings(path));
      }
      found.push(...rowScopeFindings(path, segments));
    }
  }
  if (modules.length > 0) {
    const shown = modules.slice(0, NODE_MODULES_SHOWN).map((path) => quote(path));
    const more = modules.length > NODE_MODULES_SHOWN ? ` and ${String(modules.length - NODE_MODULES_SHOWN)} more` : '';
    found.push(
      `${shown.join(', ')}${more} ${modules.length === 1 ? 'is' : 'are'} tracked as or under a node_modules directory. bun install keeps what it finds there, bun run puts node_modules/.bin ahead of PATH, and Bun resolves an import from the nearest node_modules first. Remove each from the index with git rm -r --cached`,
    );
  }
  if (nested.size > 0) {
    const directories = [...nested];
    const shown = directories.slice(0, NODE_MODULES_SHOWN).map((path) => quote(path));
    const more =
      directories.length > NODE_MODULES_SHOWN ? ` and ${String(directories.length - NODE_MODULES_SHOWN)} more` : '';
    found.push(
      `${shown.join(', ')}${more} ${directories.length === 1 ? 'is a node_modules directory' : 'are node_modules directories'} below the root. Bun, tsc and typescript-eslint resolve a bare import from the nearest node_modules first, so each replaces the installed package for the files beside it, and CI's checkout holds none. Remove each`,
    );
  }
  return found;
}

/* ///// The files Bun reads before the gate ///// */

/** The file Bun reads its settings from, in the directory it starts in. */
const BUNFIG = 'bunfig.toml';

/** The directory holding the gate's scripts. */
const SCRIPTS = 'scripts';

/**
 * The gate's own TypeScript config. Bun resolves a module a gate script
 * imports through the tsconfig.json nearest to the script, with no merge, so
 * this one keeps the root config away from the gate.
 */
const SCRIPTS_TSCONFIG = `${SCRIPTS}/tsconfig.json`;

/**
 * The names Bun reads under a script's directory to resolve its imports:
 * another tsconfig or jsconfig, a package scope, and a `node_modules` that
 * shadows the installed one.
 */
const RESOLUTION_NAMES: readonly string[] = ['tsconfig.json', 'jsconfig.json', 'package.json', 'node_modules'];

/**
 * The one key {@link BUNFIG} may carry, under its one table: the install
 * cooldown.
 *
 * @remarks
 * Bun reads the file on every `bun <file>`, `bun run`, `bun test` and
 * `bun install` started in the checkout, and no flag turns that off. A
 * top-level `preload` runs a module before the gate's first line, a `[test]`
 * preload runs one before every test, a `[define]` table rewrites values in
 * the code Bun runs, and `[install.cache] dir` points the install at a folder
 * the branch commits. Any key but this one is refused, so a key the gate has
 * never heard of is refused too. The file is committed because Renovate's
 * lock file maintenance runs `bun install` in a container with no user-level
 * config.
 */
const BUNFIG_KEY = ['install', 'minimumReleaseAge'] as const;

/** Every key {@link BUNFIG} carries beside {@link BUNFIG_KEY}, as findings. */
async function bunfigFindings(): Promise<string[]> {
  const file = Bun.file(BUNFIG);
  if (!(await file.exists())) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(await file.text());
  } catch (error: unknown) {
    return [
      `${BUNFIG} does not parse, so which keys Bun reads from it is unknown: ${quote(error instanceof Error ? error.message : String(error))}`,
    ];
  }
  if (!isTable(parsed)) {
    return [`${BUNFIG} is not a table`];
  }
  const [table, key] = BUNFIG_KEY;
  const found: string[] = [];
  for (const name of Object.keys(parsed)) {
    if (name !== table) {
      found.push(
        `${BUNFIG} carries ${quote(name)}, and it holds [${table}] ${key} alone. Bun runs a preload and applies a define before the gate's first line`,
      );
    }
  }
  const install = parsed[table];
  if (install !== undefined && !isTable(install)) {
    found.push(`${BUNFIG} carries ${table} as ${quoteValue(install)}, and it is a table holding ${key} alone`);
  }
  for (const name of isTable(install) ? Object.keys(install) : []) {
    if (name !== key) {
      found.push(
        `${BUNFIG} [${table}] carries ${quote(name)}, and it holds ${key} alone. A cache dir or a registry there changes what bun install puts under node_modules`,
      );
    }
  }
  return found;
}

/** The {@link PRETTIERRC} key naming the plugins Prettier imports, at the top or in an override's options. */
const PRETTIER_PLUGINS = 'plugins';

/** The path of every {@link PRETTIER_PLUGINS} key within `value`, at any depth, as `a.b[0].c`. */
function pluginKeys(value: unknown, at: string): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item, index) => pluginKeys(item, `${at}[${String(index)}]`));
  }
  if (!isTable(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => {
    const path = at === '' ? key : `${at}.${key}`;
    return [...(key === PRETTIER_PLUGINS ? [path] : []), ...pluginKeys(inner, path)];
  });
}

/**
 * Every way {@link PRETTIERRC} makes the format row run code, as findings: a
 * value other than a JSON object, and a {@link PRETTIER_PLUGINS} key at any
 * depth.
 *
 * @remarks
 * Prettier 3.9.8 under `--config .prettierrc` imports each plugin the file
 * names, a package or a local path, at the top or in an override matching a
 * file it checks, and imports a shared config module the file names as a
 * string, each measured running its code. It reads the file as YAML, so the
 * gate holds it to plain JSON, which both read alike, and refuses any other
 * text rather than read it two ways.
 */
async function prettierrcFindings(): Promise<string[]> {
  const file = Bun.file(PRETTIERRC);
  if (!(await file.exists())) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseJson(await file.text());
  } catch (error: unknown) {
    return [
      `${PRETTIERRC} does not parse as plain JSON, so whether Prettier loads code through it is unknown: ${quote(error instanceof Error ? error.message : String(error))}`,
    ];
  }
  if (!isTable(parsed)) {
    return [
      `${PRETTIERRC} holds ${quoteValue(parsed)}, and it is an object of formatting options. Prettier imports a shared config module a string names and runs it`,
    ];
  }
  return pluginKeys(parsed, '').map(
    (path) =>
      `${PRETTIERRC} carries ${quote(path)}, and Prettier imports each plugin it names, a package or a local path, and runs it in the format row. Remove it`,
  );
}

/**
 * Every file and directory under `path`, links not followed. A `node_modules`
 * directory is listed and not entered, since one under `scripts/` is refused
 * whole.
 */
async function walk(path: string): Promise<Dirent[]> {
  const entries = await directoryEntries(path);
  const found: Dirent[] = [...entries];
  for (const entry of entries) {
    if (entry.isDirectory() && fold(entry.name) !== 'node_modules') {
      found.push(...(await walk(join(entry.parentPath, entry.name))));
    }
  }
  return found;
}

/**
 * The findings against what Bun reads to resolve the gate's own imports: a
 * missing {@link SCRIPTS_TSCONFIG}, and any other {@link RESOLUTION_NAMES}
 * entry under `scripts/`. The tsconfig's own `paths`, `baseUrl` and `extends`
 * are read with every other project config's.
 */
async function scriptsFindings(): Promise<string[]> {
  const found: string[] = [];
  if (!existsSync(SCRIPTS_TSCONFIG)) {
    found.push(
      `${SCRIPTS_TSCONFIG} is missing, and it keeps the root tsconfig.json away from the gate's imports. Restore it`,
    );
  }
  for (const entry of await walk(SCRIPTS)) {
    const path = join(entry.parentPath, entry.name).replaceAll('\\', '/');
    if (RESOLUTION_NAMES.includes(fold(entry.name)) && fold(path) !== SCRIPTS_TSCONFIG) {
      found.push(`${quote(path)} is one Bun reads to resolve a gate script's imports, and ${SCRIPTS} holds none`);
    }
  }
  return found;
}

/** The `package.json` tables that name the packages bun install puts under node_modules. */
const DEPENDENCY_KEYS: readonly string[] = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** The lockfile bun install writes, whose `packages` table names every package it installs and where. */
const BUN_LOCK = 'bun.lock';

/** How many missing packages the finding names before it counts the rest. */
const MISSING_SHOWN = 5;

/**
 * Whether the platform named `current` is one a bun.lock `os` or `cpu` value
 * admits: absent, a name, or a list of names where `!` excludes one. Bun
 * writes `none` for a platform it has no name for, which admits nothing. A
 * value of any other shape admits every platform, so the package is required.
 */
function admits(value: unknown, current: string): boolean {
  const names: unknown[] = typeof value === 'string' ? [value] : Array.isArray(value) ? (value as unknown[]) : [];
  const listed = names.filter((name) => typeof name === 'string');
  if (listed.length === 0 || listed.length !== names.length) {
    return true;
  }
  const allowed = listed.filter((name) => !name.startsWith('!'));
  return (allowed.length === 0 || allowed.includes(current)) && !listed.includes(`!${current}`);
}

/**
 * The chain of package names a bun.lock `packages` key spells, from the root:
 * `eslint/ignore` is the `ignore` nested under `eslint`, and a scoped name
 * spans two parts.
 */
function lockNames(key: string): string[] {
  const parts = key.split('/');
  const names: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    const name = part.startsWith('@') ? `${part}/${parts[index + 1] ?? ''}` : part;
    index += name.split('/').length - 1;
    names.push(name);
  }
  return names;
}

/** The `node_modules` path, as segments below the root, where bun install puts the package a bun.lock key names. */
function lockPath(key: string): string[] {
  return lockNames(key).flatMap((name) => ['node_modules', ...name.split('/')]);
}

/**
 * The key of the package a dependency named `name` of the package at key
 * `from` resolves to, or undefined when bun.lock holds none: the key nested
 * under `from` first, then each key nested under a package above it, then the
 * hoisted one. The root is the empty key.
 */
function lockEdge(packages: ReadonlyMap<string, LockPackage>, from: string, name: string): string | undefined {
  const chain = from === '' ? [] : lockNames(from);
  for (let depth = chain.length; depth >= 0; depth -= 1) {
    const key = [...chain.slice(0, depth), name].join('/');
    if (packages.has(key)) {
      return key;
    }
  }
  return undefined;
}

/** A bun.lock `packages` entry as the install check reads it. */
interface LockPackage {
  readonly os: unknown;
  readonly cpu: unknown;
  /** Whether the entry names a `libc`, which Bun reports for no system. */
  readonly libc: boolean;
  /** The names under `dependencies`, `optionalDependencies` and `peerDependencies`, less `optionalPeers`. */
  readonly dependencies: readonly string[];
}

/**
 * The `packages` table of a parsed bun.lock, by key. An entry's fields are
 * the first table in its list, which holds them for a registry package and
 * for a git, tarball or folder one alike.
 */
function lockPackages(lock: unknown): Map<string, LockPackage> {
  const table = isTable(lock) ? lock['packages'] : undefined;
  const packages = new Map<string, LockPackage>();
  for (const [key, entry] of isTable(table) ? Object.entries(table) : []) {
    const fields = (Array.isArray(entry) ? (entry as unknown[]) : []).find((item) => isTable(item)) ?? {};
    const names = (field: string): string[] => {
      const value = fields[field];
      return isTable(value) ? Object.keys(value) : [];
    };
    const optionalPeers = fields['optionalPeers'];
    const skipped = Array.isArray(optionalPeers) ? (optionalPeers as unknown[]) : [];
    packages.set(key, {
      os: fields['os'],
      cpu: fields['cpu'],
      libc: Object.hasOwn(fields, 'libc'),
      dependencies: [
        ...names('dependencies'),
        ...names('optionalDependencies'),
        ...names('peerDependencies').filter((name) => !skipped.includes(name)),
      ],
    });
  }
  return packages;
}

/**
 * Every package bun install puts under the checkout's `node_modules` for this
 * platform that is missing there, or held through a link out of the checkout,
 * as findings, each at the path its {@link BUN_LOCK} key names. The walk starts
 * at each root {@link PACKAGE_JSON} name and follows every edge bun.lock
 * records, and an entry whose `os` or `cpu` leaves this platform out is passed
 * over with every package reached through it alone.
 *
 * @remarks
 * Bun 1.4.2 installs a package only through a parent it installs, and skips an
 * entry whose `os` or `cpu` leaves the platform out, whether a root name or a
 * dependency of any kind. So sharp's `@img/sharp-wasm32`, reached only through
 * a FreeBSD parent and a parent whose `cpu` is `none`, lands nowhere, while a
 * package a skipped parent shares with an installed one lands. Bun resolves a
 * bare import from the nearest `node_modules` holding the package, so a
 * checkout that lacks one loads a parent directory's copy, and with no
 * `node_modules` at all Bun tries to install it at run time. Either way the
 * code that runs is not the version bun.lock pins. That holds for a package
 * the manifest never names too, as the typecheck row's native compiler, the
 * platform package `@typescript/native` resolves. The gate imports zod and
 * prettier, eslint.config.ts and commitlint.config.js import their plugins,
 * and each package is refused here before any row loads it. An entry naming a
 * `libc`, and everything reached through it alone, is checked for a link out
 * alone, since which libc this system runs is not something Bun reports.
 */
async function installFindings(): Promise<string[]> {
  let manifest: unknown;
  let lock: unknown;
  try {
    manifest = parseJson(await Bun.file(PACKAGE_JSON).text());
  } catch (error: unknown) {
    // Missing, malformed or read two ways: refused, since which packages Bun must find is unknown.
    return [
      `${PACKAGE_JSON} does not parse as the gate reads it, so which packages node_modules must hold is unknown: ${quote(error instanceof Error ? error.message : String(error))}`,
    ];
  }
  try {
    lock = Bun.JSONC.parse(await Bun.file(BUN_LOCK).text());
  } catch (error: unknown) {
    // Missing or malformed: refused, since where bun install puts each package is unknown.
    return [
      `${BUN_LOCK} does not parse as the gate reads it, so which packages node_modules must hold is unknown: ${quote(error instanceof Error ? error.message : String(error))}`,
    ];
  }
  const packages = lockPackages(lock);
  // Each key reached, and whether it must be present rather than checked for a link out alone.
  const reached = new Map<string, boolean>();
  const queue: (readonly [string, boolean])[] = DEPENDENCY_KEYS.flatMap((field) => {
    const table = isTable(manifest) ? manifest[field] : undefined;
    return (isTable(table) ? Object.keys(table) : []).map(
      (name) => [lockEdge(packages, '', name) ?? name, true] as const,
    );
  });
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [key, must] = next;
    const entry = packages.get(key);
    if (
      reached.get(key) === true ||
      (reached.has(key) && !must) ||
      (entry !== undefined && (!admits(entry.os, process.platform) || !admits(entry.cpu, process.arch)))
    ) {
      continue;
    }
    const needed = must && entry?.libc !== true;
    reached.set(key, needed);
    for (const name of entry?.dependencies ?? []) {
      const child = lockEdge(packages, key, name);
      if (child !== undefined) {
        queue.push([child, needed]);
      }
    }
  }
  const required = new Map([...reached].map(([key, must]) => [lockPath(key).join('/'), must]));
  const root = realpathSync.native('.');
  const missing: string[] = [];
  const found: string[] = [];
  for (const [path, must] of required) {
    let real: string;
    try {
      real = realpathSync.native(resolve(path, PACKAGE_JSON));
    } catch {
      // Missing, or a link to nothing: either way the checkout does not hold the package.
      if (must) {
        missing.push(path);
      }
      continue;
    }
    const inside = relative(root, real);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      found.push(
        `${quote(path)} leads out of the checkout, to ${quote(real)}, so what loads is not this checkout's install. Run bun install`,
      );
    }
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, MISSING_SHOWN).map((path) => quote(path));
    const more = missing.length > MISSING_SHOWN ? ` and ${String(missing.length - MISSING_SHOWN)} more` : '';
    found.unshift(
      `${shown.join(', ')}${more} ${missing.length === 1 ? 'is' : 'are'} missing, where bun install puts ${missing.length === 1 ? 'it' : 'them'} for this platform. Bun then loads a copy from a parent directory's node_modules or installs one at run time, neither the version bun.lock pins. Run bun install`,
    );
  }
  return found;
}

/* ///// The root ///// */

/**
 * The root entry actionlint reads the start of the ShellCheck stand-in's
 * command line as: every word of it is single-quoted, and actionlint 1.7.12
 * looks the whole value up as one program path before it splits the words.
 * On Linux and macOS the value starts `'/`, a relative path whose first
 * segment is this name.
 */
const QUOTE_ENTRY = "'";

/**
 * Every root entry the gate refuses, as findings: a file named like a program
 * the gate, its hooks or an install start, with any extension or none, a
 * `.config` in any case, and a file, directory or link named {@link QUOTE_ENTRY}.
 *
 * @remarks
 * The gate starts a program from an absolute PATH entry outside the
 * repository alone. Windows runs a file from the working directory ahead of
 * PATH for a bare name that anything else starts, so a clone carries none,
 * and the gate refuses one before any row.
 */
async function programFindings(): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir('.', { withFileTypes: true })) {
    if (entry.name === QUOTE_ENTRY) {
      found.push(
        `${quote(entry.name)} is at the root, and actionlint reads the ShellCheck stand-in's whole command line as a path below it before splitting the words, so a file there runs in place of ShellCheck on Linux and macOS. Remove it`,
      );
    }
    if (!entry.isDirectory() && !PROGRAM_NAMED_FILES.includes(fold(entry.name)) && isProgramName(entry.name)) {
      found.push(
        `${quote(entry.name)} is named like a program the gate, its hooks or an install start, and a clone carries no program at its root. Remove it`,
      );
    }
    if (fold(entry.name) === '.config') {
      found.push(
        `${quote(entry.name)} is at the root, and mise, lefthook and commitlint's cosmiconfig each read a config from it whatever a flag names. Remove it`,
      );
    }
  }
  return found;
}

/**
 * Every way the files Bun and the gate's tools read before they run would
 * change what a row checks, as findings: a key in {@link BUNFIG} beside the
 * cooldown, a {@link PRETTIERRC} that loads code, what resolves the gate's own
 * imports, a package bun.lock installs that node_modules lacks, and a root
 * entry named like a program or read as the ShellCheck stand-in's path.
 *
 * @remarks
 * The gate calls this before any row, because Bun honored its files before
 * the gate's first line: a finding keeps a changed file from merging, and it
 * cannot stop what the file already ran.
 */
export async function startupFindings(): Promise<string[]> {
  return [
    ...(await bunfigFindings()),
    ...(await prettierrcFindings()),
    ...(await scriptsFindings()),
    ...(await installFindings()),
    ...(await programFindings()),
  ];
}
