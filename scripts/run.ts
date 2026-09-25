import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, sep } from 'node:path';

/** Characters that change how a line reads without printing: bidi controls, zero-width marks, line and paragraph separators, and interlinear annotation marks. */
const INVISIBLE = /[\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

/**
 * `value`, read from a file the gate checks, for a finding: JSON-encoded, so a
 * control character prints as an escape, with every {@link INVISIBLE}
 * character escaped too, and cut short.
 */
export function quote(value: string): string {
  return JSON.stringify(value.slice(0, 200)).replace(
    INVISIBLE,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The character with code point `code`, so no control character is written into this file as a literal. */
const character = (code: number): string => String.fromCharCode(code);

/**
 * Every character that prints nothing or moves the cursor: the C0 controls
 * but tab and newline, DEL, the C1 controls, and every {@link INVISIBLE}
 * character.
 */
const UNPRINTABLE = new RegExp(
  `[${character(0)}-${character(8)}${character(0x0b)}-${character(0x1f)}${character(0x7f)}-${character(0x9f)}]|${INVISIBLE.source}`,
  'g',
);

/**
 * `text`, a line the gate prints, with Windows line endings made plain and
 * every {@link UNPRINTABLE} character written as its `\u` escape.
 *
 * @remarks
 * A row's message carries tool output, and a tool quotes the files it reads,
 * so a job id or path in a workflow reaches the terminal through it. An
 * escape sequence or a carriage return there could rewrite the lines above
 * it, so the gate prints every line through this.
 */
export function printable(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replace(UNPRINTABLE, (found) => `\\u${found.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * An ANSI control sequence: ESC and `[`, or the one-byte CSI, then parameter
 * bytes, intermediate bytes and a final byte. Or an operating system command,
 * such as a terminal hyperlink: ESC and `]`, then any text up to BEL or ESC
 * and a backslash.
 */
const CONTROL_SEQUENCE = new RegExp(
  `(?:${character(0x1b)}\\[|${character(0x9b)})[0-?]*[ -/]*[@-~]|${character(0x1b)}\\][^${character(0x07)}${character(0x1b)}]*(?:${character(0x07)}|${character(0x1b)}\\\\)`,
  'g',
);

/**
 * `printed`, a tool's output, with every ANSI control sequence removed and
 * Windows line endings made plain, so a pattern matches colored output as it
 * matches plain output.
 *
 * @remarks
 * Every child gets NO_COLOR, and yet a tool can color its output on one
 * machine alone, as `dotnet test` does on a GitHub runner, so every parser of
 * tool output reads through this.
 */
export function plain(printed: string): string {
  return printed.replace(CONTROL_SEQUENCE, '').replaceAll('\r\n', '\n');
}

/**
 * `name` keyed for comparison against a name a tool reads: mapped to upper and
 * back to lower case. This is the set's one folding rule, the same in every
 * stack's gate.
 *
 * @remarks
 * A case-insensitive filesystem hands a tool a tracked file under a spelling
 * that differs from the one the tool asks for. The key merges ASCII case, the
 * letters that map to an ASCII one such as ſ with s and the Kelvin sign with
 * k, full case mapping's expansions such as ß with ss and ﬁ with fi, and
 * dotless ı with i. Every name the gate refuses is ASCII and every file it
 * names passes in its exact spelling alone, so a merge beyond what a
 * filesystem does costs a false refusal at worst.
 */
export function fold(name: string): string {
  return name.toUpperCase().toLowerCase();
}

/** Whether `path` is a file this process can start. */
function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    // A missing or unreadable candidate is the ordinary miss of a PATH search.
    return false;
  }
}

/**
 * The repository root in its canonical form: the working directory, where
 * `bun run` starts every gate script.
 *
 * @remarks
 * The native realpath resolves every link and junction and expands a Windows
 * 8.3 short name, which the portable realpath leaves in place.
 */
function repositoryRoot(): string {
  return realpathSync.native(process.cwd());
}

/**
 * Whether `path`, a PATH entry or a program found in one, resolves to the
 * repository root or a path inside it, comparing canonical paths without
 * regard to case where the filesystem ignores it.
 *
 * @remarks
 * A path whose canonical form cannot be resolved counts as inside, so it is
 * never used: a missing directory holds no program, and one the system cannot
 * resolve is not one the gate can place.
 */
function isInsideRepository(path: string, root: string): boolean {
  let resolved: string;
  try {
    resolved = realpathSync.native(path);
  } catch {
    return true;
  }
  const fold = (path: string): string =>
    process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
  const base = fold(root);
  const target = fold(resolved);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * The PATH entries the gate searches and hands every child: the absolute ones
 * whose canonical path lies outside the repository, in PATH's order.
 *
 * @remarks
 * Windows searches the working directory ahead of PATH for a bare name, and
 * Bun's own lookup reads an empty or `.` entry as the working directory, so a
 * file at the repository root named like a program would run in its place.
 * `bun run` puts the checkout's `node_modules/.bin` ahead of PATH as an
 * absolute entry, where a planted file would run the same way.
 */
function searchedDirectories(): string[] {
  const windows = process.platform === 'win32';
  const root = repositoryRoot();
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .map((entry) => (windows ? entry.replace(/^"(.*)"$/, '$1') : entry))
    .filter((directory) => isAbsolute(directory) && !isInsideRepository(directory, root));
}

/**
 * The absolute path of `program`, found through PATH alone.
 *
 * @remarks
 * Only the {@link searchedDirectories} are searched. On Windows each PATHEXT
 * extension is tried in PATHEXT's order, as cmd.exe tries them, unless the
 * name already carries one. A candidate whose own canonical path lies inside
 * the repository is passed over, since a link in a directory outside can lead
 * back in. A program given as an absolute path is returned as it is, and a
 * relative path is never resolved.
 *
 * @returns The path to start, or undefined when no absolute PATH entry that
 * resolves outside the repository holds a program that resolves outside it too
 */
export function resolveProgram(program: string): string | undefined {
  if (isAbsolute(program)) {
    return program;
  }
  if (program.includes('/') || program.includes('\\')) {
    return undefined;
  }
  const windows = process.platform === 'win32';
  const extensions = windows
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((extension) => extension.length > 0)
    : [];
  const carries = extensions.some((extension) => extension.toLowerCase() === extname(program).toLowerCase());
  const names = windows && !carries ? extensions.map((extension) => program + extension) : [program];
  const root = repositoryRoot();
  for (const directory of searchedDirectories()) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isRunnable(candidate) && !isInsideRepository(candidate, root)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * The command that starts `tool`, a JavaScript tool the checkout installs,
 * through `bun x --bun --no-install` under the Bun running the gate.
 *
 * @remarks
 * `bun x` is bunx. It runs the command the install put in the working
 * directory's `node_modules/.bin`, under Bun rather than a `node` on PATH,
 * and it fetches nothing. When that directory lacks the command, bunx runs a
 * copy from a parent directory's `node_modules/.bin`, from PATH or from its
 * own cache, none of them the version bun.lock pins. So the command is
 * refused first unless the entry bunx reads resolves, through every link, to
 * a regular file: `<tool>.exe` on Windows, and `<tool>` elsewhere, where the
 * install writes a link. A link left behind by a removed package points at
 * nothing. bunx ignores `--no-env-file`, so none is passed.
 *
 * @throws When the entry is missing, a dangling link or not a file, naming
 * the install to run
 */
export function jsTool(tool: string): string[] {
  const bin = `node_modules/.bin/${process.platform === 'win32' ? `${tool}.exe` : tool}`;
  let installed: boolean;
  try {
    installed = statSync(realpathSync.native(bin)).isFile();
  } catch {
    // Missing, or a link to nothing: the checkout does not hold the tool.
    installed = false;
  }
  if (!installed) {
    throw new Error(
      `${tool} is not installed in this checkout: run bun install --frozen-lockfile, or bun install --frozen-lockfile --ignore-scripts in a worktree (CONTRIBUTING.md#setup).`,
    );
  }
  return [process.execPath, 'x', '--bun', '--no-install', tool];
}

/**
 * One finished process: what it printed and how it ended.
 */
export interface Finished {
  /**
   * The exit code, or -1 when a process it started held its output open after
   * it exited.
   */
  readonly exitCode: number;
  /** Standard output, decoded as UTF-8. */
  readonly stdout: string;
  /** Standard error, decoded as UTF-8. */
  readonly stderr: string;
  /**
   * True when the process exited and a process it started still held its
   * output open {@link DRAIN_MS} later, so what it printed may be cut short.
   */
  readonly heldOpen: boolean;
}

/** How {@link run} starts a process, beyond its command and variables. */
export interface RunOptions {
  /**
   * When false the process starts with the given variables alone and
   * inherits nothing from the gate's environment.
   */
  readonly inherit?: boolean;
  /**
   * How long the process may run before Bun kills it, the process alone and
   * with no tree kill. Only a caller that reads no answer as its own fallback
   * passes one, as the gh token read does.
   */
  readonly timeoutMs?: number;
}

/**
 * The proxy variables, in both spellings the tools' HTTP clients read. Bun
 * 1.4.2 on Windows reads a lowercase-only name directly but leaves it out when
 * it lists the environment, so {@link run} reads each one by name.
 */
export const PROXY_NAMES: readonly string[] = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

/**
 * What every process that inherits the gate's environment gets, so no tool
 * colors its output: NO_COLOR set, and the two names that force color
 * removed. Bun 1.4.2 colors bun test's summary under FORCE_COLOR even with
 * NO_COLOR set.
 */
const COLORLESS: Readonly<Record<string, string | undefined>> = {
  NO_COLOR: '1',
  FORCE_COLOR: undefined,
  CLICOLOR_FORCE: undefined,
};

/**
 * What every process that inherits the gate's environment goes without:
 * BUN_OPTIONS, which every Bun the gate starts directly reads as arguments
 * ahead of its own, where a test name pattern hides tests from a count and a
 * preload or an env file reaches inside a row. An ordinary shell can set it.
 * On Windows Bun reads the name in any spelling.
 */
const WITHHELD: Readonly<Record<string, undefined>> = {
  BUN_OPTIONS: undefined,
};

/** How long a process's output may stay open after it exits, since a process it started can hold it. */
const DRAIN_MS = 10_000;

/**
 * Everything `stream` carries, decoded as UTF-8. The read stops when `stop`
 * settles, so a process left holding a pipe open cannot hold the gate.
 */
async function readAll(stream: unknown, stop: Promise<void>): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    return '';
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  stop
    .then(() => reader.cancel())
    .catch(() => {
      // The stream closed on its own first, which is the ordinary end.
    });
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Runs one command to completion with its output captured.
 *
 * @remarks
 * Every process the gate starts goes through here. No row carries a deadline:
 * the CI job's timeout-minutes bounds the gate, and Ctrl-C ends a local run.
 * When a process it started still holds its output {@link DRAIN_MS} after it
 * exited, the run fails, and that process runs on, since nothing Bun offers
 * reaches a process whose parent is gone.
 *
 * The program starts from the path {@link resolveProgram} finds, never from
 * the working directory. A program no absolute PATH entry holds is a failed
 * process, exit 127 with the reason as its stderr, and so is a spawn error, so
 * a missing prerequisite reads like any other red row rather than a crash of
 * the gate. A process that inherits the gate's environment gets PATH as the
 * {@link searchedDirectories} alone, so a program it starts by name resolves
 * outside the repository too, gets every {@link PROXY_NAMES} value the gate
 * can read, and gets {@link COLORLESS} and goes without {@link WITHHELD},
 * in every spelling, unless `env` names the same variables.
 *
 * @param cmd - The program and its arguments, the program first
 * @param env - Variables added to the gate's own environment for this process,
 * or its whole environment when `options.inherit` is false. Each replaces
 * every inherited spelling of its name, because Windows reads a name without
 * regard to case and a second spelling in the block can win. A variable given
 * as undefined is removed, in every spelling
 * @returns What the process printed and how it ended
 */
export async function run(
  cmd: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  options: RunOptions = {},
): Promise<Finished> {
  const inherit = options.inherit !== false;
  const given = inherit ? { ...COLORLESS, ...WITHHELD, ...env } : env;
  const replaced = new Set(Object.keys(given).map((name) => name.toUpperCase()));
  const merged: Record<string, string> = {};
  if (inherit) {
    if (!replaced.has('PATH')) {
      replaced.add('PATH');
      merged['PATH'] = searchedDirectories().join(delimiter);
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !replaced.has(name.toUpperCase())) {
        merged[name] = value;
      }
    }
    // Windows reads one name in any case, so a spelling already present covers the others.
    const present = new Set(
      Object.keys(merged).map((name) => (process.platform === 'win32' ? name.toUpperCase() : name)),
    );
    for (const name of PROXY_NAMES) {
      const key = process.platform === 'win32' ? name.toUpperCase() : name;
      const value = process.env[name];
      if (value !== undefined && !replaced.has(name.toUpperCase()) && !present.has(key)) {
        merged[name] = value;
        present.add(key);
      }
    }
  }
  for (const [name, value] of Object.entries(given)) {
    if (value !== undefined) {
      merged[name] = value;
    }
  }
  const [program = '', ...args] = cmd;
  const path = resolveProgram(program);
  if (path === undefined) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: `${quote(program)}: no absolute PATH entry holds it, and the working directory is never searched`,
      heldOpen: false,
    };
  }
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: [path, ...args],
      cwd: process.cwd(),
      env: merged,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 127, stdout: '', stderr: `${quote(program)}: ${message}`, heldOpen: false };
  }
  let heldOpen = false;
  let settled = false;
  let stopReading: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stopReading = resolve;
  });
  let drain: ReturnType<typeof setTimeout> | undefined;
  void child.exited.then(() => {
    if (!settled) {
      drain = setTimeout(() => {
        heldOpen = true;
        stopReading();
      }, DRAIN_MS);
    }
  });
  const [stdout, stderr] = await Promise.all([readAll(child.stdout, stopped), readAll(child.stderr, stopped)]);
  const exitCode = await Promise.race([child.exited, stopped.then(() => -1)]);
  settled = true;
  clearTimeout(drain);
  return { exitCode: heldOpen ? -1 : exitCode, stdout, stderr, heldOpen };
}

/**
 * The whole environment of every git the gate and its scripts start: no
 * system or global config, and nothing else.
 *
 * @remarks
 * A git hook exports `GIT_DIR` and `GIT_INDEX_FILE`, and either points git at
 * a repository or an index other than the working tree, so a gate run from a
 * hook would read or write the hook's own. An env file Bun loaded can set any
 * other `GIT_` name. git lists, searches and diffs the tree with none of them,
 * and /dev/null is the spelling Git for Windows reads as an empty file too.
 */
const GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/** Runs git with `args` in {@link GIT_ENVIRONMENT} and nothing inherited. */
export async function git(args: readonly string[]): Promise<Finished> {
  return run(['git', ...args], GIT_ENVIRONMENT, { inherit: false });
}

/**
 * The text a failed process leaves for the row's message: its exit and both
 * streams, trimmed, or a note that it printed nothing.
 */
export function describe(finished: Finished): string {
  const printed: string = [finished.stdout, finished.stderr].join('\n').trim();
  const ending: string = finished.heldOpen
    ? `exited, and a process it started still held its output ${String(DRAIN_MS / 1000)} s later and runs on, so its output may be cut short. Find and end that process`
    : `exited ${String(finished.exitCode)}`;
  return `${ending} saying: ${printed.length === 0 ? 'nothing' : printed}`;
}
