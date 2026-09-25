import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, sep } from 'node:path';
import { fold, git, jsTool, resolveProgram, run } from './run';
import { isolate, launcherName, spellings, StandIns, WINDOWS } from './stand-ins';
import { trackedFindings } from './startup';

// Every stand-in start is a Bun process, and a loaded machine starts one in
// seconds, so a case gets longer than the runner's five-second default.
setDefaultTimeout(30_000);

/** How long the planted-program fixture's own bare spawn may take. */
const PROBE_MS = 30_000;

let standIns: StandIns;
let restore: () => void;
let home: string;
/** The working directory of the case, removed after it. */
let cwd: string;
/** Directories beside {@link cwd} the case made, removed after it. */
let beside: string[];

beforeAll(() => {
  standIns = new StandIns(['tool', 'gh', 'git', 'mise']);
  home = process.cwd();
});

afterAll(() => {
  standIns.remove();
});

beforeEach(() => {
  restore = isolate(standIns);
  standIns.clear();
  cwd = mkdtempSync(join(tmpdir(), 'gate-run-'));
  beside = [];
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(home);
  for (const path of [...beside].reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
  rmSync(cwd, { recursive: true, force: true });
  restore();
});

/** A directory beside the working directory, named `<cwd><suffix>`, removed after the case. */
function besideDir(suffix: string): string {
  const path = `${cwd}${suffix}`;
  mkdirSync(path, { recursive: true });
  beside.push(path);
  return path;
}

/** Plants a launcher for `name` in `dir` that records its starts as `label`, and returns its path. */
function plant(dir: string, name: string, label: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, launcherName(name));
  standIns.plant(path, label);
  return path;
}

/** `path` as the file system compares it, so a found path and an expected one compare on Windows. */
function norm(path: string | undefined): string | undefined {
  return WINDOWS ? path?.toLowerCase() : path;
}

/** The names of every recorded start, in order. */
function started(): string[] {
  return standIns.calls().map((call) => call.name);
}

/** An asymmetric matcher for a finding carrying `fragment`. */
function carrying(fragment: string): string {
  return expect.stringContaining(fragment) as string;
}

/* ///// The spawn environment ///// */

test('a name run() is not asked to change reaches the child unchanged', async () => {
  process.env['GATE_PASS'] = 'through';

  await run([standIns.path('tool')]);

  expect(standIns.calls()[0]?.env['GATE_PASS']).toBe('through');
});

test('a name run() sets reaches the child at its value', async () => {
  await run([standIns.path('tool')], { GATE_SET: 'set' });

  expect(standIns.calls()[0]?.env['GATE_SET']).toBe('set');
});

test('a name run() sets replaces every inherited spelling of it', async () => {
  process.env['gate_case'] = 'inherited';
  process.env['Gate_Case'] = 'inherited';

  await run([standIns.path('tool')], { GATE_CASE: 'set' });

  const env = standIns.calls()[0]?.env ?? {};
  expect(spellings(env, 'GATE_CASE')).toEqual(['GATE_CASE']);
  expect(env['GATE_CASE']).toBe('set');
});

test('a name passed as undefined is absent from the child in every spelling', async () => {
  process.env['gate_gone'] = 'inherited';
  process.env['GATE_GONE'] = 'inherited';

  await run([standIns.path('tool')], { GATE_GONE: undefined });

  expect(spellings(standIns.calls()[0]?.env ?? {}, 'GATE_GONE')).toEqual([]);
});

test('a child that inherits gets NO_COLOR, and no FORCE_COLOR or CLICOLOR_FORCE in any spelling', async () => {
  process.env['NO_COLOR'] = '';
  process.env['FORCE_COLOR'] = '1';
  process.env['force_color'] = '3';
  process.env['CLICOLOR_FORCE'] = '1';

  await run([standIns.path('tool')]);

  const env = standIns.calls()[0]?.env ?? {};
  expect(spellings(env, 'NO_COLOR').map((name) => env[name])).toEqual(['1']);
  expect(spellings(env, 'FORCE_COLOR')).toEqual([]);
  expect(spellings(env, 'CLICOLOR_FORCE')).toEqual([]);
});

// The value is a flag Bun starts under without failing, so the stand-in
// records its start whether or not the name reaches it.
test.each(['BUN_OPTIONS', 'bun_options'])(
  'a child that inherits goes without %p, in every spelling of its name',
  async (name: string) => {
    process.env[name] = '--smol';

    await run([standIns.path('tool')]);

    expect(standIns.calls()).toHaveLength(1);
    expect(spellings(standIns.calls()[0]?.env ?? {}, name)).toEqual([]);
  },
);

test('a process started with inherit false receives the variables given and none of the gate environment', async () => {
  process.env['GATE_PASS'] = 'through';

  await run([standIns.path('tool')], { GATE_SET: 'set' }, { inherit: false });

  const env = standIns.calls()[0]?.env ?? {};
  expect(env['GATE_SET']).toBe('set');
  expect(spellings(env, 'GATE_PASS')).toEqual([]);
});

test("a child's PATH holds the gate's absolute entries outside the working directory alone", async () => {
  const inside = join(cwd, 'node_modules', '.bin');
  mkdirSync(inside, { recursive: true });
  process.env['PATH'] = [inside, '.', '', standIns.dir].join(delimiter);

  await run([standIns.path('tool')]);

  const env = standIns.calls()[0]?.env ?? {};
  const names = spellings(env, 'PATH');
  expect(names).toHaveLength(1);
  expect((env[names[0] ?? 'PATH'] ?? '').split(delimiter).map(norm)).toEqual([norm(standIns.dir)]);
});

/* ///// How a process ends ///// */

test('the exit code and stdout come back as the process left them', async () => {
  standIns.answer('tool', { stdout: 'printed', exitCode: 3 });

  const finished = await run([standIns.path('tool')]);

  expect(finished).toMatchObject({ exitCode: 3, stdout: 'printed', heldOpen: false });
});

test('a program no PATH entry holds exits 127, saying which and that the working directory is never searched', async () => {
  const finished = await run(['gate-absent-program']);

  expect(finished.exitCode).toBe(127);
  expect(finished.stderr).toStartWith('"gate-absent-program": ');
  expect(finished.stderr).toContain('working directory is never searched');
  expect(started()).toEqual([]);
});

/* ///// Name folding ///// */

// Each character is built from its code point, so no editor or formatter can
// turn an escape into the character or the character into an escape.
const at = (codePoint: number): string => String.fromCodePoint(codePoint);

const FOLDS: readonly (readonly [string, string, string])[] = [
  ['ASCII case', 'MISE.TOML', 'mise.toml'],
  ['long s, mapped to s', `${at(0x17f)}hellcheck`, 'shellcheck'],
  ['the Kelvin sign, mapped to k', `${at(0x212a)}ey`, 'key'],
  ['the fi ligature, expanded', `${at(0xfb01)}le`, 'file'],
  ['sharp s, expanded', `stra${at(0xdf)}e`, 'strasse'],
  ['dotless i, mapped to i', `m${at(0x131)}se`, 'mise'],
  ['a fullwidth letter, left as it is', `${at(0xff4d)}ise`, `${at(0xff4d)}ise`],
];

test.each([...FOLDS])('fold: %s', (_label: string, name: string, folded: string) => {
  expect(fold(name)).toBe(folded);
});

/* ///// The resolver ///// */

interface RelativeCase {
  readonly label: string;
  /** The PATH entry, relative to the working directory, and where its program sits. */
  readonly entry: () => { entry: string; dir: string };
}

const RELATIVE: readonly RelativeCase[] = [
  { label: 'an empty entry', entry: () => ({ entry: '', dir: cwd }) },
  { label: 'a . entry', entry: () => ({ entry: '.', dir: cwd }) },
  { label: 'a relative entry below', entry: () => ({ entry: 'rel', dir: join(cwd, 'rel') }) },
  {
    label: 'a relative entry beside',
    entry: () => ({ entry: `..${sep}${basename(cwd)}-sib`, dir: besideDir('-sib') }),
  },
];

test.each([...RELATIVE])('$label is never searched', ({ entry }: RelativeCase) => {
  const shape = entry();
  plant(shape.dir, 'gh', 'planted');
  process.env['PATH'] = [shape.entry, standIns.dir].join(delimiter);

  expect(norm(resolveProgram('gh'))).toBe(norm(standIns.path('gh')));
});

const INSIDE: readonly string[] = ['', 'node_modules/.bin', 'deep/er'];

test.each([...INSIDE])('an absolute entry inside the working directory (%p) is skipped', (below: string) => {
  const dir = join(cwd, below);
  plant(dir, 'gh', 'planted');
  process.env['PATH'] = [dir, standIns.dir].join(delimiter);

  expect(norm(resolveProgram('gh'))).toBe(norm(standIns.path('gh')));
});

test('an entry beside the working directory whose name shares its prefix is searched', () => {
  const dir = besideDir('-other');
  const path = plant(dir, 'gh', 'beside');
  process.env['PATH'] = [dir, standIns.dir].join(delimiter);

  expect(norm(resolveProgram('gh'))).toBe(norm(path));
});

test('a link outside the working directory to a directory inside it is skipped', () => {
  const target = join(cwd, 'node_modules', '.bin');
  plant(target, 'gh', 'planted');
  const link = `${cwd}-link`;
  symlinkSync(target, link, WINDOWS ? 'junction' : 'dir');
  beside.push(link);
  // The fixture holds only when the link reaches the planted file by its own spelling.
  expect(statSync(join(link, launcherName('gh'))).isFile()).toBe(true);
  expect(realpathSync.native(link)).not.toBe(link);
  process.env['PATH'] = [link, standIns.dir].join(delimiter);

  expect(norm(resolveProgram('gh'))).toBe(norm(standIns.path('gh')));
});

/** The Windows 8.3 short spelling of `path`, or `path` itself where the volume keeps none. */
function shortPath(path: string): string {
  const kernel32 = dlopen('kernel32.dll', {
    GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  });
  try {
    const input = Buffer.from(`${path}\0`, 'utf16le');
    const output = Buffer.alloc(2 * 1024);
    const length = kernel32.symbols.GetShortPathNameW(ptr(input), ptr(output), 1024);
    return length === 0 || length > 1024 ? path : output.toString('utf16le', 0, length * 2);
  } finally {
    kernel32.close();
  }
}

/** Whether the temporary volume gives a long directory name an 8.3 short one. */
function shortNamesAvailable(): boolean {
  if (!WINDOWS) {
    return false;
  }
  const probe = mkdtempSync(join(tmpdir(), 'gate-short-name-probe-'));
  try {
    return shortPath(probe).toLowerCase() !== probe.toLowerCase();
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test.if(shortNamesAvailable())('an entry inside the working directory spelled by its 8.3 short name is skipped', () => {
  const dir = join(cwd, 'node_modules', '.bin');
  plant(dir, 'gh', 'planted');
  const short = shortPath(dir);
  // The fixture holds only when the short spelling differs and reaches the planted file.
  expect(short.toLowerCase()).not.toBe(dir.toLowerCase());
  expect(statSync(join(short, launcherName('gh'))).isFile()).toBe(true);
  process.env['PATH'] = [short, standIns.dir].join(delimiter);

  expect(norm(resolveProgram('gh'))).toBe(norm(standIns.path('gh')));
});

test('the first absolute entry holding the program wins', () => {
  const first = plant(besideDir('-a'), 'gh', 'first');
  plant(besideDir('-b'), 'gh', 'second');
  process.env['PATH'] = [dirname(first), `${cwd}-b`].join(delimiter);

  expect(norm(resolveProgram('gh'))).toBe(norm(first));
});

test('a directory named like the program is skipped', () => {
  mkdirSync(join(besideDir('-a'), launcherName('gh')));
  process.env['PATH'] = [`${cwd}-a`, standIns.dir].join(delimiter);

  expect(norm(resolveProgram('gh'))).toBe(norm(standIns.path('gh')));
});

test.if(!WINDOWS)('a file without the executable bit is skipped', () => {
  const path = plant(besideDir('-a'), 'gh', 'not-executable');
  chmodSync(path, 0o644);
  process.env['PATH'] = [`${cwd}-a`, standIns.dir].join(delimiter);

  expect(resolveProgram('gh')).toBe(standIns.path('gh'));
});

test.if(WINDOWS)('extensions are tried in PATHEXT order', () => {
  const dir = besideDir('-a');
  const bat = join(dir, 'gh.bat');
  const cmd = join(dir, 'gh.cmd');
  standIns.plant(bat, 'bat');
  standIns.plant(cmd, 'cmd');
  process.env['PATH'] = dir;

  process.env['PATHEXT'] = '.CMD;.BAT';
  expect(norm(resolveProgram('gh'))).toBe(norm(cmd));
  process.env['PATHEXT'] = '.BAT;.CMD';
  expect(norm(resolveProgram('gh'))).toBe(norm(bat));
});

test.if(WINDOWS)('a name already carrying a PATHEXT extension is tried as given', () => {
  const dir = besideDir('-a');
  standIns.plant(join(dir, 'gh.bat'), 'bat');
  standIns.plant(join(dir, 'gh.bat.cmd'), 'bat-cmd');
  process.env['PATH'] = dir;

  expect(norm(resolveProgram('gh.bat'))).toBe(norm(join(dir, 'gh.bat')));
});

test.if(WINDOWS)('an unset PATHEXT falls back to .COM;.EXE;.BAT;.CMD', () => {
  const dir = besideDir('-a');
  standIns.plant(join(dir, 'gh.cmd'), 'cmd');
  standIns.plant(join(dir, 'other.js'), 'js');
  process.env['PATH'] = dir;
  Reflect.deleteProperty(process.env, 'PATHEXT');

  expect(norm(resolveProgram('gh'))).toBe(norm(join(dir, 'gh.cmd')));
  expect(resolveProgram('other')).toBeUndefined();
});

test.if(WINDOWS)('a PATH entry wrapped in double quotes is unwrapped', () => {
  const dir = besideDir('-a');
  const path = plant(dir, 'gh', 'quoted');
  process.env['PATH'] = `"${dir}"`;

  expect(norm(resolveProgram('gh'))).toBe(norm(path));
});

test('a program given as an absolute path is returned unchanged, whether or not it exists', () => {
  const absent = join(cwd, 'nowhere', launcherName('gh'));

  expect(resolveProgram(absent)).toBe(absent);
  expect(resolveProgram(standIns.path('gh'))).toBe(standIns.path('gh'));
});

test.each(['./gh', 'bin/gh', 'bin\\gh'])(
  'a relative path with a separator (%p) is never resolved',
  (program: string) => {
    plant(cwd, 'gh', 'planted');
    plant(join(cwd, 'bin'), 'gh', 'planted');
    process.env['PATH'] = ['.', 'bin', standIns.dir].join(delimiter);

    expect(resolveProgram(program)).toBeUndefined();
  },
);

/* ///// Planting, end to end ///// */

interface Placement {
  readonly label: string;
  readonly windowsOnly: boolean;
  /** Plants the file and returns the PATH entry to put ahead of the stand-ins, if any. */
  readonly place: (name: string) => string | undefined;
}

const PLACEMENTS: readonly Placement[] = [
  {
    label: 'at the working directory root, with no PATH entry naming it',
    windowsOnly: true,
    place: (name: string) => {
      plant(cwd, name, `planted-${name}`);
      return undefined;
    },
  },
  {
    label: 'at the working directory root, with . first on PATH',
    windowsOnly: false,
    place: (name: string) => {
      plant(cwd, name, `planted-${name}`);
      return '.';
    },
  },
  {
    label: 'in node_modules/.bin, absolute and first on PATH',
    windowsOnly: false,
    place: (name: string) => {
      const dir = join(cwd, 'node_modules', '.bin');
      plant(dir, name, `planted-${name}`);
      return dir;
    },
  },
  {
    label: 'in node_modules/.bin, through a link outside the working directory',
    windowsOnly: false,
    place: (name: string) => {
      const dir = join(cwd, 'node_modules', '.bin');
      plant(dir, name, `planted-${name}`);
      const link = `${cwd}-link`;
      symlinkSync(dir, link, WINDOWS ? 'junction' : 'dir');
      beside.push(link);
      return link;
    },
  },
];

const PLANTED_CASES = PLACEMENTS.filter((placement) => WINDOWS || !placement.windowsOnly).flatMap((placement) =>
  ['gh', 'git', 'mise'].map((name) => ({ name, placement })),
);

test.each(PLANTED_CASES)(
  'run() starts the PATH program, never a $name planted $placement.label',
  async ({ name, placement }: { name: string; placement: Placement }) => {
    const entry = placement.place(name);
    process.env['PATH'] = [...(entry === undefined ? [] : [entry]), standIns.dir].join(delimiter);
    // The fixture holds only when a bare spawn, with the variable that hides
    // the working directory absent as on a runner, starts the planted file.
    expect(spellings(process.env, 'NoDefaultCurrentDirectoryInExePath')).toEqual([]);
    Bun.spawnSync({ cmd: [name, 'probe'], cwd, env: { ...process.env }, timeout: PROBE_MS });
    expect(started()).toEqual([`planted-${name}`]);
    standIns.clear();

    await run([name, 'probe']);

    expect(started()).toEqual([name]);
  },
);

/* ///// JavaScript tools through bunx ///// */

/** The entry bunx reads for `tool` on this platform, below node_modules/.bin. */
function binEntry(tool: string): string {
  return join(cwd, 'node_modules', '.bin', WINDOWS ? `${tool}.exe` : tool);
}

/** Whether this process can make a symbolic link to a file, which Windows grants only in some setups. */
function fileLinksAvailable(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'gate-link-probe-'));
  try {
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** The set wording of the refusal, with `tool` filled in. */
function notInstalled(tool: string): string {
  return `${tool} is not installed in this checkout: run bun install --frozen-lockfile, or bun install --frozen-lockfile --ignore-scripts in a worktree (CONTRIBUTING.md#setup).`;
}

interface InstallCase {
  readonly label: string;
  /** Plants what node_modules/.bin holds for the tool, or nothing. */
  readonly plant: (entry: string) => void;
  /** Whether the case needs a symbolic link to a file. */
  readonly fileLink?: true;
  readonly installed: boolean;
}

const INSTALLS: readonly InstallCase[] = [
  {
    label: 'a file at the entry bunx reads',
    plant: (entry: string) => {
      writeFileSync(entry, '');
    },
    installed: true,
  },
  {
    label: 'a link to a file, as bun install writes on Linux and macOS',
    plant: (entry: string) => {
      writeFileSync(`${entry}.target`, '');
      symlinkSync(`${entry}.target`, entry, 'file');
    },
    fileLink: true,
    installed: true,
  },
  { label: 'no entry', plant: () => undefined, installed: false },
  {
    label: 'a dangling link to a file',
    plant: (entry: string) => {
      symlinkSync(`${entry}.removed`, entry, 'file');
    },
    fileLink: true,
    installed: false,
  },
  {
    label: 'a dangling link to a directory',
    plant: (entry: string) => {
      symlinkSync(join(cwd, 'removed-package'), entry, WINDOWS ? 'junction' : 'dir');
    },
    installed: false,
  },
  {
    label: 'a directory',
    plant: (entry: string) => {
      mkdirSync(entry);
    },
    installed: false,
  },
  {
    label: 'the other platform form alone',
    plant: (entry: string) => {
      writeFileSync(WINDOWS ? entry.slice(0, -'.exe'.length) : `${entry}.exe`, '');
    },
    installed: false,
  },
];

test.each(INSTALLS.filter((entry) => entry.fileLink !== true || fileLinksAvailable()))(
  'jsTool with $label',
  ({ plant, installed }: InstallCase) => {
    mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
    plant(binEntry('prettier'));

    if (installed) {
      expect(jsTool('prettier')).toEqual([process.execPath, 'x', '--bun', '--no-install', 'prettier']);
    } else {
      expect(() => jsTool('prettier')).toThrow(notInstalled('prettier'));
    }
  },
);

test('jsTool reads the tool named and no other', () => {
  mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(binEntry('eslint'), '');

  expect(() => jsTool('prettier')).toThrow(notInstalled('prettier'));
  expect(jsTool('eslint').at(-1)).toBe('eslint');
});

/* ///// The git environment ///// */

test("git starts with its two config switches and nothing from the caller's environment, in any spelling", async () => {
  process.env['GIT_DIR'] = join(cwd, 'elsewhere');
  process.env['git_index_file'] = join(cwd, 'index');
  process.env['Git_Config_Parameters'] = "'core.fsmonitor=x'";
  process.env['GATE_DECOY'] = 'decoy';

  await git(['status']);

  const calls = standIns.calls();
  expect(calls.map((call) => [call.name, ...call.args])).toEqual([['git', 'status']]);
  const env = calls[0]?.env ?? {};
  expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
  expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
  for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GATE_DECOY']) {
    expect(spellings(env, name)).toEqual([]);
  }
});

/* ///// Tracked env files and node_modules ///// */

// The names Bun 1.4.2 loads from the directory it starts in, written out here
// from its loader rather than read from the module.
const BUN_ENV_NAMES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
];

/** The arguments of the git call that names the work tree. */
const TOP_LEVEL = 'rev-parse --show-toplevel';

/** The arguments of the git call that lists the untracked files on disk. */
const UNTRACKED = 'ls-files -z --others --exclude=/node_modules/ --exclude=/.claude/worktrees/';

/**
 * Answers each git call the preflight makes by its exact arguments: the work
 * tree with the case's working directory, the index listing with `tracked`,
 * and the untracked listing with `untracked`, each NUL-separated. Any other
 * git call fails, so a call the case did not expect is a finding.
 */
function answerGit(tracked: readonly string[], untracked: readonly string[] = []): void {
  standIns.answer('git', { exitCode: 3 });
  standIns.answer('git', { stdout: `${cwd}\n` }, TOP_LEVEL);
  standIns.answer('git', { stdout: tracked.map((path) => `${path}\0`).join('') }, 'ls-files -z');
  standIns.answer('git', { stdout: untracked.map((path) => `${path}\0`).join('') }, UNTRACKED);
}

/** The arguments of every git start the case recorded, in order. */
function gitArgs(): (readonly string[])[] {
  return standIns
    .calls()
    .filter((call) => call.name === 'git')
    .map((call) => call.args);
}

test.each([...BUN_ENV_NAMES])('a tracked %p is a finding naming it, at the root and below', async (name: string) => {
  answerGit([name, `docs/${name}`]);

  const found = await trackedFindings();

  expect(found).toEqual([
    carrying(`${JSON.stringify(name)} is an env file Bun loads`),
    carrying(`${JSON.stringify(`docs/${name}`)} is an env file Bun loads`),
  ]);
});

test('a tracked env file in another case is a finding naming it as it is spelled', async () => {
  answerGit(['.Env.Production.Local']);

  expect(await trackedFindings()).toEqual([carrying('".Env.Production.Local" is an env file Bun loads')]);
});

test('git names the work tree, then lists the whole index once and the untracked files once, with no pathspec', async () => {
  answerGit([]);

  expect(await trackedFindings()).toEqual([]);

  const [top, index, others, ...rest] = gitArgs();
  expect(top).toEqual(['rev-parse', '--show-toplevel']);
  expect(index).toEqual(['ls-files', '-z']);
  expect(others?.slice(0, 3)).toEqual(['ls-files', '-z', '--others']);
  expect(others?.filter((arg) => !arg.startsWith('-'))).toEqual(['ls-files']);
  expect(rest).toEqual([]);
});

test('a work tree other than the checkout, as an empty .git directory gives, is the one finding, and nothing is listed', async () => {
  answerGit(['.env']);
  standIns.answer('git', { stdout: `${besideDir('-parent')}\n` }, TOP_LEVEL);

  expect(await trackedFindings()).toEqual([carrying('not this checkout, so every file it lists belongs to another')]);
  expect(gitArgs()).toEqual([['rev-parse', '--show-toplevel']]);
});

test('a git that cannot name the work tree is the one finding, and nothing is listed', async () => {
  answerGit(['.env']);
  standIns.answer('git', { exitCode: 128 }, TOP_LEVEL);

  expect(await trackedFindings()).toEqual([carrying('git could not name the work tree it reads: it exited 128')]);
  expect(gitArgs()).toEqual([['rev-parse', '--show-toplevel']]);
});

test('an untracked config a tool with no named form reads is a finding, and an untracked env file is not', async () => {
  answerGit([], ['.github/actionlint.yaml', '.lefthook.yml', '.env']);

  expect(await trackedFindings()).toEqual([
    carrying('".github/actionlint.yaml" is an actionlint config'),
    carrying('".lefthook.yml" is a lefthook config'),
  ]);
});

test('a config for a tool the gate runs with its config named yields no finding, tracked or not', async () => {
  answerGit(
    ['.prettierrc.json', '.commitlintrc.json', 'taplo.toml', 'zizmor.yml', 'package.yaml'],
    ['src/.prettierrc', 'src/eslint.config.js', 'docs/.taplo.toml'],
  );

  expect(await trackedFindings()).toEqual([]);
});

/* ///// node_modules below the root ///// */

test('a node_modules directory on disk below the root is one finding naming each directory once', async () => {
  answerGit([], ['src/node_modules/zod/index.js', 'src/node_modules/zod/package.json', 'tests/deep/Node_Modules/x.js']);

  const found = await trackedFindings();

  expect(found).toEqual([
    carrying('"src/node_modules", "tests/deep/Node_Modules" are node_modules directories below the root'),
  ]);
});

test('a tracked node_modules below the root is a finding while it is on disk, and not once it is gone', async () => {
  mkdirSync(join(cwd, 'src', 'node_modules', 'zod'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'node_modules', 'zod', 'index.js'), '');
  answerGit(['src/node_modules/zod/index.js', 'tests/node_modules/gone.js']);

  expect(await trackedFindings()).toEqual([carrying('"src/node_modules" is a node_modules directory below the root')]);
});

test('the untracked listing leaves the root node_modules out and nothing below it', async () => {
  answerGit([]);

  await trackedFindings();

  const others = gitArgs().find((args) => args.includes('--others')) ?? [];
  expect(others).toContain('--exclude=/node_modules/');
  expect(others.filter((arg) => /node_modules/i.test(arg))).toEqual(['--exclude=/node_modules/']);
});

test('env files on disk that the index does not hold yield no finding', async () => {
  writeFileSync(join(cwd, '.env'), '');
  answerGit([], [...BUN_ENV_NAMES, 'docs/.env.local']);

  expect(await trackedFindings()).toEqual([]);
});

test('a tracked env template, or an env file for a mode Bun never loads, yields no finding', async () => {
  answerGit(['.env.example', '.env.local.template', 'docs/.env.staging', 'env.example', 'src/dotenv.ts']);

  expect(await trackedFindings()).toEqual([]);
});

/* ///// Project configs ///// */

test('a tsconfig.json outside the paths expected.ts names is a finding, tracked or not', async () => {
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'tsconfig.json'), '{}');
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'docs', 'jsconfig.json'), '{}');
  answerGit(['src/tsconfig.json'], ['docs/jsconfig.json']);

  expect(await trackedFindings()).toEqual([
    carrying('"src/tsconfig.json" is a TypeScript project config outside the paths scripts/expected.ts names'),
    carrying('"docs/jsconfig.json" is a TypeScript project config outside the paths scripts/expected.ts names'),
  ]);
});

test('the project configs expected.ts names and scripts/tsconfig.json yield no finding', async () => {
  answerGit(['tsconfig.json', 'scripts/tsconfig.json']);

  expect(await trackedFindings()).toEqual([]);
});

/* ///// Keys the gate refuses in a tracked JSON file ///// */

/** A backslash, spelled so no formatter decodes the escape it starts. */
const BACKSLASH = String.fromCharCode(92);

interface KeyCase {
  readonly label: string;
  /** Every file the case writes below the working directory, by path. */
  readonly files: Readonly<Record<string, string>>;
  /** The paths the index lists. */
  readonly tracked: readonly string[];
  /** The paths the untracked listing names. */
  readonly untracked?: readonly string[];
  /** A fragment of each finding, in order, or none when the tree passes. */
  readonly refused: readonly string[];
}

const KEYS: readonly KeyCase[] = [
  {
    label: 'a package.json repeating a top-level key',
    files: { 'package.json': '{ "patchedDependencies": {}, "name": "a", "patchedDependencies": { "x@1.0.0": "p" } }' },
    tracked: ['package.json'],
    refused: [
      '"package.json" carries a patchedDependencies key',
      '"package.json" repeats "patchedDependencies" within one object, and Bun reads the first',
    ],
  },
  {
    label: 'a nested package.json repeating a key inside an object',
    files: { 'tools/sub/package.json': '{ "scripts": { "a": "x", "a": "y" } }' },
    tracked: ['tools/sub/package.json'],
    refused: ['"tools/sub/package.json" repeats "a" within one object'],
  },
  {
    label: 'a key repeated under an escaped spelling',
    files: {
      'package.json': `{ "patchedDependencie${BACKSLASH}u0073": {}, "patchedDependencies": {} }`,
    },
    tracked: ['package.json'],
    refused: [
      '"package.json" carries a patchedDependencies key',
      '"package.json" repeats "patchedDependencies" within one object',
    ],
  },
  {
    label: 'a tsconfig.json repeating compilerOptions.paths',
    files: { 'tsconfig.json': '{ "compilerOptions": { "paths": {}, "paths": { "x": ["./x.ts"] } } }' },
    tracked: ['tsconfig.json'],
    refused: ['"tsconfig.json" repeats "paths" within one object'],
  },
  {
    label: 'a base a tsconfig.json extends repeating a key',
    files: {
      'tsconfig.json': '{ "extends": "./tsconfig.base" }',
      'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "baseUrl": "./src" } }',
    },
    tracked: ['tsconfig.json', 'tsconfig.base.json'],
    refused: ['"tsconfig.json", through "tsconfig.base.json", repeats "baseUrl" within one object'],
  },
  {
    label: 'a package.json that does not parse as plain JSON',
    files: { 'package.json': '{ "name": "a", }' },
    tracked: ['package.json'],
    refused: ['"package.json" does not parse as plain JSON, so which keys it holds is unknown'],
  },
  {
    label: 'a package.json carrying patchedDependencies beside a value nested deeper than jq reads',
    files: {
      'package.json': `{ "deep": ${'['.repeat(300)}${']'.repeat(300)}, "patchedDependencies": { "x@1.0.0": "patches/x.patch" } }`,
    },
    tracked: ['package.json'],
    refused: [
      '"package.json" carries a patchedDependencies key, and bun install applies each patch it names over the package bun.lock pins, so a tool a row runs can change while its pin stays the same. Remove it',
    ],
  },
  {
    label: 'a nested package.json carrying patchedDependencies, in another case',
    files: { 'tools/sub/Package.JSON': '{ "patchedDependencies": {} }' },
    tracked: ['tools/sub/Package.JSON'],
    refused: ['"tools/sub/Package.JSON" carries a patchedDependencies key'],
  },
  {
    label: 'patchedDependencies below the top of a package.json, or in a tsconfig.json',
    files: {
      'package.json': '{ "config": { "patchedDependencies": {} } }',
      'tsconfig.json': '{ "patchedDependencies": {} }',
    },
    tracked: ['package.json', 'tsconfig.json'],
    refused: [],
  },
  {
    label: 'one key in two objects, and a repeat inside a string',
    files: {
      'package.json': `{ "scripts": { "a": "x" }, "config": { "a": "${BACKSLASH}"b${BACKSLASH}": 1, ${BACKSLASH}"b${BACKSLASH}": 2" } }`,
    },
    tracked: ['package.json'],
    refused: [],
  },
  {
    label: 'a package.json on disk that the index does not hold',
    files: { 'package.json': '{ "a": 1, "a": 2 }' },
    tracked: [],
    untracked: ['package.json'],
    refused: [],
  },
  {
    label: 'an extends naming a package, which the shared commits job refuses',
    files: { 'tsconfig.json': '{ "extends": "@tsconfig/strictest" }' },
    tracked: ['tsconfig.json'],
    refused: [],
  },
];

test.each([...KEYS])('$label', async ({ files, tracked, untracked, refused }: KeyCase) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  answerGit(tracked, untracked);

  expect(await trackedFindings()).toEqual(refused.map((fragment) => carrying(fragment)));
});

test.each([
  ['index', 'ls-files -z', 'tracked files'],
  ['untracked', UNTRACKED, 'untracked files'],
])('a failed %s listing is a finding', async (_label: string, args: string, what: string) => {
  answerGit([]);
  standIns.answer('git', { exitCode: 128 }, args);

  expect(await trackedFindings()).toEqual([carrying(`git could not list the ${what} the gate refuses: it exited 128`)]);
});

test('a missing git is a finding', async () => {
  process.env['PATH'] = besideDir('-empty');

  expect(await trackedFindings()).toEqual([carrying('git could not name the work tree it reads: it exited 127')]);
});

test("the preflight's git starts with its two config switches and nothing from the gate's environment", async () => {
  answerGit([]);
  process.env['GIT_DIR'] = join(cwd, 'elsewhere');
  process.env['git_index_file'] = join(cwd, 'index');
  process.env['GIT_CONFIG_PARAMETERS'] = "'core.fsmonitor=x'";
  process.env['GATE_DECOY'] = 'decoy';

  await trackedFindings();

  const calls = standIns.calls().filter((call) => call.name === 'git');
  expect(calls.length).toBeGreaterThan(0);
  for (const { env } of calls) {
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GATE_DECOY']) {
      expect(spellings(env, name)).toEqual([]);
    }
  }
});

/* ///// Tracked files read as text ///// */

/** Writes `text` at `path` below the working directory and answers git's index listing with it. */
function trackFile(path: string, text: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
  answerGit([path]);
}

/* ///// Workflow names and shells ///// */

// actionlint and zizmor read a workflow by its lowercase .yml name alone.
test.each(['.github/workflows/ci.yaml', '.github/workflows/CI.YML', '.github/workflows/ci.Yml'])(
  'a tracked workflow %p outside .github/workflows/<name>.yml is a finding',
  async (path: string) => {
    answerGit([path, '.github/workflows/cd.yml']);

    expect(await trackedFindings()).toEqual([carrying(`${JSON.stringify(path)} is a workflow outside`)]);
  },
);

/** A workflow whose one job runs one step, with `defaults` and `step` spliced in as written. */
function workflow(defaults: string, step: string): string {
  return `on: push\n${defaults}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n${step}`;
}

interface ShellCase {
  readonly label: string;
  readonly text: string;
  readonly where: string;
}

// actionlint hands ShellCheck a bash or sh script alone, so each of these runs
// a script no linter reads.
const REFUSED_SHELLS: readonly ShellCase[] = [
  {
    label: 'a step naming bash by its path',
    text: workflow('', '        shell: /bin/bash -e {0}\n'),
    where: 'jobs.a.steps[0].shell to "/bin/bash -e {0}"',
  },
  {
    label: 'a step naming python',
    text: workflow('', '        shell: python\n'),
    where: 'jobs.a.steps[0].shell to "python"',
  },
  {
    label: 'a step naming bash in another case',
    text: workflow('', '        shell: Bash\n'),
    where: 'jobs.a.steps[0].shell to "Bash"',
  },
  {
    label: 'a step naming pwsh with arguments',
    text: workflow('', '        shell: pwsh -command ". \'{0}\'"\n'),
    where: 'jobs.a.steps[0].shell to "pwsh -command',
  },
  {
    label: 'the workflow default naming cmd',
    text: workflow('defaults:\n  run:\n    shell: cmd\n', ''),
    where: 'defaults.run.shell to "cmd"',
  },
  {
    label: "a job's default naming an expression",
    text: 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: ${{ matrix.shell }}\n    steps:\n      - run: echo hi\n',
    where: 'jobs.a.defaults.run.shell to "${{ matrix.shell }}"',
  },
];

test.each([...REFUSED_SHELLS])('$label is a finding naming where', async ({ text, where }: ShellCase) => {
  trackFile('.github/workflows/ci.yml', text);

  expect(await trackedFindings()).toEqual([carrying(`".github/workflows/ci.yml" sets ${where}`)]);
});

test.each(['bash', 'sh', 'pwsh'])('a step and both defaults naming %p yield no finding', async (shell: string) => {
  trackFile(
    '.github/workflows/ci.yml',
    `on: push\ndefaults:\n  run:\n    shell: ${shell}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: ${shell}\n    steps:\n      - run: echo hi\n        shell: ${shell}\n`,
  );

  expect(await trackedFindings()).toEqual([]);
});

test('a tracked workflow the gate cannot read as YAML is a finding', async () => {
  trackFile('.github/workflows/ci.yml', 'jobs: [unclosed\n');

  expect(await trackedFindings()).toEqual([
    carrying('".github/workflows/ci.yml" does not parse as the gate reads YAML'),
  ]);
});

test('a shell outside the workflows directory, or in an untracked workflow, yields no finding', async () => {
  mkdirSync(join(cwd, '.github', 'actions', 'probe'), { recursive: true });
  writeFileSync(join(cwd, '.github', 'actions', 'probe', 'action.yml'), 'runs:\n  steps:\n    - shell: python\n');
  mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(cwd, '.github', 'workflows', 'ci.yml'), workflow('', '        shell: python\n'));
  answerGit(['.github/actions/probe/action.yml'], ['.github/workflows/ci.yml']);

  expect(await trackedFindings()).toEqual([]);
});

/* ///// Inline zizmor waivers ///// */

interface WaiverCase {
  readonly label: string;
  readonly path: string;
  readonly text: string;
  readonly tracked: boolean;
  readonly refused: boolean;
}

const WAIVERS: readonly WaiverCase[] = [
  {
    label: 'a waiver in a tracked workflow',
    path: '.github/workflows/ci.yml',
    text: 'jobs: {} # zizmor: ignore[unpinned-uses]\n',
    tracked: true,
    refused: true,
  },
  {
    label: 'a waiver in the tracked dependabot.yml',
    path: '.github/dependabot.yml',
    text: 'version: 2 # zizmor: ignore[dependabot-cooldown]\n',
    tracked: true,
    refused: true,
  },
  {
    label: 'a waiver in another case and spacing in a composite action',
    path: '.github/actions/probe/action.yml',
    text: 'runs: {} # ZIZMOR : IGNORE [template-injection]\n',
    tracked: true,
    refused: true,
  },
  {
    label: 'the words outside .github',
    path: 'docs/notes.md',
    text: 'A `zizmor: ignore[x]` comment is refused.\n',
    tracked: true,
    refused: false,
  },
  {
    label: 'a waiver in an untracked workflow',
    path: '.github/workflows/ci.yml',
    text: 'jobs: {} # zizmor: ignore[unpinned-uses]\n',
    tracked: false,
    refused: false,
  },
];

test.each([...WAIVERS])('$label', async ({ path, text, tracked, refused }: WaiverCase) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
  answerGit(tracked ? [path] : [], tracked ? [] : [path]);

  expect(await trackedFindings()).toEqual(
    refused ? [carrying(`${JSON.stringify(path)} carries a zizmor ignore comment`)] : [],
  );
});

/* ///// Personal files ///// */

test.each(['lefthook-local.yml', '.lefthook-local'])(
  'a tracked personal file %p is a finding, and one on disk alone is not',
  async (path: string) => {
    answerGit([path]);
    const tracked = await trackedFindings();
    standIns.clear();
    answerGit([], [path]);

    expect(tracked).toEqual([carrying(`${JSON.stringify(path)} is a local lefthook config`)]);
    expect(tracked[0]).toContain('Remove it from the index with git rm --cached');
    expect(await trackedFindings()).toEqual([]);
  },
);
