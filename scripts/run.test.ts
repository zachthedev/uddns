import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, sep } from 'node:path';
import { resolveProgram, run } from './run';
import { isolate, launcherName, spellings, StandIns, WINDOWS } from './stand-ins';
import { trackedFindings } from './startup';

// Every stand-in start is a Bun process, and a loaded machine starts one in
// seconds, so a case gets longer than the runner's five-second default.
setDefaultTimeout(30_000);

const DEADLINE_MS = 30_000;

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

/* ///// The spawn environment ///// */

test('a name run() is not asked to change reaches the child unchanged', async () => {
  process.env['GATE_PASS'] = 'through';

  await run([standIns.path('tool')], DEADLINE_MS);

  expect(standIns.calls()[0]?.env['GATE_PASS']).toBe('through');
});

test('a name run() sets reaches the child at its value', async () => {
  await run([standIns.path('tool')], DEADLINE_MS, { GATE_SET: 'set' });

  expect(standIns.calls()[0]?.env['GATE_SET']).toBe('set');
});

test('a name run() sets replaces every inherited spelling of it', async () => {
  process.env['gate_case'] = 'inherited';
  process.env['Gate_Case'] = 'inherited';

  await run([standIns.path('tool')], DEADLINE_MS, { GATE_CASE: 'set' });

  const env = standIns.calls()[0]?.env ?? {};
  expect(spellings(env, 'GATE_CASE')).toEqual(['GATE_CASE']);
  expect(env['GATE_CASE']).toBe('set');
});

test('a name passed as undefined is absent from the child in every spelling', async () => {
  process.env['gate_gone'] = 'inherited';
  process.env['GATE_GONE'] = 'inherited';

  await run([standIns.path('tool')], DEADLINE_MS, { GATE_GONE: undefined });

  expect(spellings(standIns.calls()[0]?.env ?? {}, 'GATE_GONE')).toEqual([]);
});

test('a process started with inherit false receives the variables given and none of the gate environment', async () => {
  process.env['GATE_PASS'] = 'through';

  await run([standIns.path('tool')], DEADLINE_MS, { GATE_SET: 'set' }, { inherit: false });

  const env = standIns.calls()[0]?.env ?? {};
  expect(env['GATE_SET']).toBe('set');
  expect(spellings(env, 'GATE_PASS')).toEqual([]);
});

/* ///// How a process ends ///// */

test('the exit code and stdout come back as the process left them', async () => {
  standIns.answer('tool', { stdout: 'printed', exitCode: 3 });

  const finished = await run([standIns.path('tool')], DEADLINE_MS);

  expect(finished).toMatchObject({ exitCode: 3, stdout: 'printed', timedOut: false });
});

test('a program no PATH entry holds exits 127, saying which and that the working directory is never searched', async () => {
  const finished = await run(['gate-absent-program'], DEADLINE_MS);

  expect(finished.exitCode).toBe(127);
  expect(finished.stderr).toContain('gate-absent-program');
  expect(finished.stderr).toContain('working directory is never searched');
  expect(started()).toEqual([]);
});

test('a process that outlives its deadline is killed, with timedOut and exit -1', async () => {
  const sleepMs = 3_000;
  standIns.answer('tool', { sleepMs });
  // run() kills the launcher's tree with the taskkill PATH names on every
  // Windows machine. The stand-in runs under the launcher's cmd.exe there.
  if (WINDOWS) {
    process.env['PATH'] = [standIns.dir, join(process.env['SYSTEMROOT'] ?? '', 'System32')].join(delimiter);
  }
  const begun = performance.now();

  const finished = await run([standIns.path('tool')], 300);
  const waited = performance.now() - begun;
  // A stand-in the kill missed finishes before the case ends.
  await Bun.sleep(sleepMs);

  expect(finished.timedOut).toBe(true);
  expect(finished.exitCode).toBe(-1);
  expect(waited).toBeLessThan(sleepMs);
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
    Bun.spawnSync({ cmd: [name, 'probe'], cwd, env: { ...process.env }, timeout: DEADLINE_MS });
    expect(started()).toEqual([`planted-${name}`]);
    standIns.clear();

    await run([name, 'probe'], DEADLINE_MS);

    expect(started()).toEqual([name]);
  },
);

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

/** The arguments of each git start the case recorded. */
function gitArgs(): (readonly string[])[] {
  return standIns
    .calls()
    .filter((call) => call.name === 'git')
    .map((call) => call.args);
}

test.each([...BUN_ENV_NAMES])('a tracked %p is a finding that names it', async (name: string) => {
  standIns.answer('git', { stdout: `${name}\0` });

  expect(await trackedFindings()).toEqual([
    expect.stringContaining(`${JSON.stringify(name)} is an env file Bun loads`) as string,
  ]);
});

test('a tracked env file in another case is a finding that names it as spelled', async () => {
  standIns.answer('git', { stdout: '.Env.Production.Local\0' });

  expect(await trackedFindings()).toEqual([
    expect.stringContaining('".Env.Production.Local" is an env file Bun loads') as string,
  ]);
});

test('git lists the tracked files, then the untracked ones outside node_modules and the worktrees, NUL-separated', async () => {
  standIns.answer('git', { stdout: '' });

  await trackedFindings();

  expect(gitArgs()).toEqual([
    ['ls-files', '-z'],
    ['ls-files', '-z', '--others', '--exclude=node_modules', '--exclude=/.claude/worktrees/'],
  ]);
});

test('one tracked path under node_modules is a finding that names it', async () => {
  standIns.answer('git', { stdout: 'node_modules/.bin/bun\0' });

  expect(await trackedFindings()).toEqual([
    expect.stringContaining('"node_modules/.bin/bun" is tracked as or under a node_modules directory') as string,
  ]);
});

test('many tracked paths under node_modules, in any case, are one finding naming five and counting the rest', async () => {
  const paths = [
    'Node_Modules/zod/index.js',
    ...[1, 2, 3, 4, 5, 6].map((index) => `node_modules/p${String(index)}.js`),
  ];
  standIns.answer('git', { stdout: paths.map((path) => `${path}\0`).join('') });

  const found = await trackedFindings();

  expect(found).toHaveLength(1);
  const shown = paths.slice(0, 5).map((path) => JSON.stringify(path));
  expect(found[0]).toStartWith(`${shown.join(', ')} and 2 more are tracked as or under a node_modules directory`);
});

test('an index holding neither yields no finding', async () => {
  writeFileSync(join(cwd, '.env'), '');
  standIns.answer('git', { stdout: '' });

  expect(await trackedFindings()).toEqual([]);
});

test('a failed git read is a finding for each listing', async () => {
  standIns.answer('git', { stdout: '', exitCode: 128 });

  expect(await trackedFindings()).toEqual([
    expect.stringContaining('git could not list the tracked files the gate refuses: it exited 128') as string,
    expect.stringContaining('git could not list the untracked files the gate refuses: it exited 128') as string,
  ]);
});

test('a missing git is a finding for each listing', async () => {
  process.env['PATH'] = besideDir('-empty');

  expect(await trackedFindings()).toEqual([
    expect.stringContaining('git could not list the tracked files the gate refuses: it exited 127') as string,
    expect.stringContaining('git could not list the untracked files the gate refuses: it exited 127') as string,
  ]);
});

test("git starts with its two config switches and nothing from the gate's environment", async () => {
  standIns.answer('git', { stdout: '' });
  process.env['GIT_DIR'] = join(cwd, 'elsewhere');
  process.env['git_index_file'] = join(cwd, 'index');
  process.env['GIT_CONFIG_PARAMETERS'] = "'core.fsmonitor=x'";
  process.env['GATE_DECOY'] = 'decoy';

  await trackedFindings();

  const env = standIns.calls()[0]?.env ?? {};
  expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
  expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
  for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GATE_DECOY']) {
    expect(spellings(env, name)).toEqual([]);
  }
});
