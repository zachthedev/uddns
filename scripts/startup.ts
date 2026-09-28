/**
 * The files the gate's tools find by name, refused where they would change
 * what a row checks: a config a tool with no config flag would read, a project
 * config outside the named paths, a node_modules below the root, a workflow
 * the workflows row would not read, and what resolves the gate's own imports.
 *
 * @remarks
 * The gate calls {@link trackedFindings} and {@link startupFindings} before
 * any row, and again after each row that runs repository code. This file and
 * everything it imports read Bun and `node:` built-ins alone, so the checks
 * run on a checkout with no install. No config's text is held here: code-owner
 * review is the control on a change to one. The refusals of tracked files that
 * run code or waive a check before any row reads them, such as a tracked env
 * file, a `patchedDependencies` key, a repeated JSON key or a bunfig.toml
 * preload, live once in the shared commits and workflows jobs. The comparison
 * helpers here serve tools.ts too, which holds mise.toml and mise.lock. What
 * differs between repositories of the set lives in expected.ts.
 */

import type { Dirent } from 'node:fs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXPECTED_PROJECT_CONFIGS } from './expected';
import { describe, fold, git, quote } from './run';

/** The file pinning a version for every tool mise installs. */
export const PINS = 'mise.toml';

/** The file holding a checksum, a url and a backend per platform for every pinned tool. */
export const LOCK = 'mise.lock';

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

/* ///// The tracked files ///// */

/** How many node_modules directories a finding names before it counts the rest. */
const NODE_MODULES_SHOWN = 5;

/** A program that reads a file it finds by name: the names it reads, and the one the gate names for it. */
interface ConfigSearch {
  /** What a refused file is, read after "is". */
  readonly what: string;
  /** Every path the program reads, as a pattern over the folded path: `*` is any run within one segment. */
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
 * Every program the gate or its hooks start that reads a file it finds by
 * name and takes no flag naming one, with every name it reads, measured on
 * the pinned versions.
 *
 * @remarks
 * Prettier, ESLint, commitlint, taplo and zizmor each run with their one
 * config named, and the named form stops every other name each reads, so none
 * is listed here. actionlint and lefthook take no config flag, so every other
 * name they read is refused. The patterns reach past each program's own
 * search where that costs nothing, to any extension. The root `.config`
 * directory, which mise, lefthook and cosmiconfig read whatever a flag names,
 * is refused whole on its own.
 */
const CONFIG_SEARCHES: readonly ConfigSearch[] = [
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
];

/** `glob`, one of a {@link ConfigSearch}'s paths, as a pattern over a whole folded path. */
function searchPattern(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${body}$`);
}

/** The names Bun and typescript-eslint read a project's TypeScript options from. */
const PROJECT_CONFIG_NAMES: readonly string[] = ['tsconfig.json', 'jsconfig.json'];

/**
 * A finding against the project config at `path` when it sits outside the
 * paths expected.ts names, or none.
 *
 * @remarks
 * typescript-eslint reads the project config nearest each file it lints, and
 * no flag names another, so one at an unnamed path changes what the lint row
 * reports. The rule is where a config sits, never what it holds.
 */
function projectConfigFindings(path: string): string[] {
  if (path === SCRIPTS_TSCONFIG || EXPECTED_PROJECT_CONFIGS.includes(path)) {
    return [];
  }
  return [
    `${quote(path)} is a TypeScript project config outside the paths scripts/expected.ts names, and typescript-eslint reads the nearest one for each file it lints. Name it in scripts/expected.ts, or remove it`,
  ];
}

/** The directory GitHub reads workflows from, which reads one whose name ends in lowercase `.yml` here. */
const WORKFLOWS = '.github/workflows';

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
 * Every way the tracked file at `path` falls outside what the workflows row
 * reads, as findings: a workflow whose path is not
 * `.github/workflows/<name>.yml` exactly, and a workflow `shell:` value
 * outside {@link WORKFLOW_SHELLS}.
 *
 * @remarks
 * actionlint and zizmor read a workflow by its lowercase `.yml` name alone,
 * so a `.YML` or `.yaml` one passes both unread. A ShellCheck directive is
 * refused by scripts/shellcheck.ts, which reads each script as ShellCheck
 * does.
 */
function workflowFindings(path: string, segments: readonly string[]): string[] {
  if (segments.slice(0, -1).join('/') !== WORKFLOWS || !/\.ya?ml$/.test(segments.at(-1) ?? '')) {
    return [];
  }
  const found: string[] = [];
  if (!(path.startsWith(`${WORKFLOWS}/`) && path.endsWith('.yml'))) {
    found.push(
      `${quote(path)} is a workflow outside ${WORKFLOWS}/<name>.yml, and actionlint and zizmor read that spelling alone. Rename it`,
    );
  }
  if (existsSync(path)) {
    found.push(...shellFindings(path, readFileSync(path, 'utf8')));
  }
  return found;
}

/** The one directory a composite action lives under, in this exact spelling. */
const ACTIONS = '.github/actions/';

/** The names a composite action's metadata file takes, in this exact spelling. */
const ACTION_NAMES: readonly string[] = ['action.yml', 'action.yaml'];

/**
 * A finding when the tracked file at `path` is a composite action's metadata
 * file outside {@link ACTIONS}, or one named in another case, or none.
 *
 * @remarks
 * zizmor, in the workflows row and in the shared workflows job, reads
 * `.github` alone, while `uses: ./<path>` runs an action from anywhere in the
 * checkout. An action at any other path, such as `tools/x` or a `.GitHub`
 * spelled in another case, would run with no audit, so every one lives under
 * `.github/actions/` in that spelling. A name is compared folded, and only its
 * exact spelling passes: zizmor reads `action.yml` and `action.yaml` alone,
 * while a case-insensitive runner opens `ACTION.YML` for either.
 */
function actionFindings(path: string, segments: readonly string[]): string[] {
  const name = segments.at(-1) ?? '';
  if (!ACTION_NAMES.includes(name)) {
    return [];
  }
  if (!path.startsWith(ACTIONS)) {
    return [
      `${quote(path)} is a composite action outside ${ACTIONS}, where zizmor reads none, while uses: ./<path> runs one from anywhere in the checkout. Move it under ${ACTIONS}`,
    ];
  }
  const spelled = path.split('/').at(-1) ?? '';
  if (!ACTION_NAMES.includes(spelled)) {
    return [
      `${quote(path)} names a composite action in another case than ${ACTION_NAMES.join(' or ')}, which zizmor never reads, while a case-insensitive runner opens it for uses:. Rename it ${name}`,
    ];
  }
  return [];
}

/** The paths one `git ls-files` call lists, split, or a finding when git fails. */
async function listFiles(args: readonly string[], what: string): Promise<string[] | string> {
  const listed = await git(['ls-files', '-z', ...args]);
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
  const finished = await git(['rev-parse', '--show-toplevel']);
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
 * named paths, a `node_modules` directory on disk below the root, a tracked
 * workflow the workflows row would not read or whose shell no linter reads,
 * and a tracked composite action outside `.github/actions/`.
 *
 * @remarks
 * git lists nothing until it names this checkout as its work tree, and a work
 * tree anywhere else is the one finding. It then lists the tracked files once
 * and the untracked ones on disk once, the ignored ones included, outside the
 * root node_modules and Claude Code's worktrees. The gate compares each name
 * through {@link fold}, since git's `icase` pathspec magic folds ASCII alone.
 * A config that changes what a row reports is refused on disk, tracked or
 * not, so a local gate agrees with CI, and a personal file is refused only
 * when tracked. A nearer `node_modules` shadows the installed package for the
 * files beside it, and CI's checkout holds none.
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
  const nested = new Set<string>();
  for (const path of [...tracked, ...untracked.filter((entry) => !trackedSet.has(entry))]) {
    const isTracked = trackedSet.has(path);
    const segments = path.split('/').map(fold);
    const at = segments.indexOf('node_modules');
    if (at >= 0) {
      if (at > 0 && (!isTracked || existsSync(path))) {
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
    if (PROJECT_CONFIG_NAMES.includes(segments.at(-1) ?? '')) {
      found.push(...projectConfigFindings(path));
    }
    if (isTracked) {
      found.push(...workflowFindings(path, segments));
      found.push(...actionFindings(path, segments));
    }
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

/* ///// The files Bun reads to resolve the gate's imports ///// */

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
 * entry under `scripts/`.
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

/* ///// The root ///// */

/**
 * A finding for a `.config` at the root, in any case, on disk whether tracked
 * or not.
 *
 * @remarks
 * mise, lefthook and commitlint's cosmiconfig each read a config from the
 * root .config whatever a flag names, so the gate refuses one on disk, tracked
 * or not. The shared commits job refuses a tracked one before a merge.
 */
async function metaConfigFindings(): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir('.', { withFileTypes: true })) {
    if (fold(entry.name) === '.config') {
      found.push(
        `${quote(entry.name)} is at the root, and mise, lefthook and commitlint's cosmiconfig each read a config from it whatever a flag names. Remove it`,
      );
    }
  }
  return found;
}

/**
 * Every way what Bun reads to resolve the gate's own imports, or a root
 * config several tools read whatever a flag names, would change what a row
 * checks, as findings.
 */
export async function startupFindings(): Promise<string[]> {
  return [...(await scriptsFindings()), ...(await metaConfigFindings())];
}
