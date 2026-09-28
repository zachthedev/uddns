import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolate, spellings, StandIns, WINDOWS } from './stand-ins';
import { LOCK, PINS, startupFindings } from './startup';
import { install, lockfileFindings, miseEnvironment, resolve, type Tool, TOOLS, URL_REPLACEMENTS } from './tools';

// Every stand-in start is a Bun process, and a loaded machine starts one in
// seconds, so a case gets longer than the runner's five-second default.
setDefaultTimeout(30_000);

/* ///// The committed files, read once ///// */

// Every case starts from the files the repository commits and changes one
// thing, so the suite tracks the real pins rather than a copy of them.
const ROOT = join(import.meta.dir, '..');
const PINS_TEXT = readFileSync(join(ROOT, PINS), 'utf8').replaceAll('\r\n', '\n');
const LOCK_TEXT = readFileSync(join(ROOT, LOCK), 'utf8').replaceAll('\r\n', '\n');

type Table = Record<string, unknown>;

/** `value` as a TOML table, or a fixture error when the committed file has another shape. */
function table(value: unknown): Table {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fixture: expected a TOML table');
  }
  return value as Table;
}

/** `value` as a string, or a fixture error. */
function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('fixture: expected a TOML string');
  }
  return value;
}

const PINS_PARSED = table(Bun.TOML.parse(PINS_TEXT));
const LOCK_PARSED = table(Bun.TOML.parse(LOCK_TEXT));
const SETTINGS = table(PINS_PARSED['settings']);
const PLATFORMS: readonly string[] = (SETTINGS['lockfile_platforms'] as unknown[]).map(text);

/** The first tool matching `attested`, from the shared table. */
function pick(attested: boolean): Tool {
  const tool = TOOLS.find((candidate) => candidate.attested === attested);
  if (tool === undefined) {
    throw new Error(`fixture: TOOLS holds no tool with attested ${String(attested)}`);
  }
  return tool;
}

/** An attested tool and an unattested one, and two of the pinned platforms. */
const ATTESTED = pick(true);
const PLAIN = pick(false);
const P = PLATFORMS[0] ?? '';
const Q = PLATFORMS[1] ?? '';

/** The pinned version of `tool`. */
function pinned(tool: Tool): string {
  return text(table(PINS_PARSED['tools'])[tool.key]);
}

/** The committed lock entry for `tool`. */
function lockEntry(tool: Tool): Table {
  const entries = table(LOCK_PARSED['tools'])[tool.key];
  if (!Array.isArray(entries)) {
    throw new Error(`fixture: ${LOCK} holds no entry list for ${tool.key}`);
  }
  return table(entries[0]);
}

/** The committed lock table for `tool` on `platform`. */
function platformEntry(tool: Tool, platform: string): Table {
  return table(lockEntry(tool)[`platforms.${platform}`]);
}

/* ///// Text edits, each checked to apply ///// */

/** `source` with its one occurrence of `from` replaced, or a fixture error. */
function replaceOnce(source: string, from: string, to: string): string {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`fixture: ${JSON.stringify(from)} occurs ${String(count)} times`);
  }
  return source.replace(from, () => to);
}

/** `source` with the table under `header` passed through `edit`, up to the next table header. */
function editTable(source: string, header: string, edit: (segment: string) => string): string {
  const start = source.indexOf(`${header}\n`);
  if (start < 0) {
    throw new Error(`fixture: no table ${header}`);
  }
  const next = source.indexOf('\n[', start + header.length);
  const end = next < 0 ? source.length : next + 1;
  return source.slice(0, start) + edit(source.slice(start, end)) + source.slice(end);
}

function entryHeader(tool: Tool): string {
  return `[[tools.${tool.key}]]`;
}

function platformHeader(tool: Tool, platform: string): string {
  return `[tools.${tool.key}."platforms.${platform}"]`;
}

/** The lock with `field` in `tool`'s `platform` table set to `value`, or removed when `value` is undefined. */
function setField(tool: Tool, platform: string, field: string, value: string | undefined, source = LOCK_TEXT): string {
  return editTable(source, platformHeader(tool, platform), (segment: string) => {
    const line = new RegExp(`^${field} = .*\\n`, 'm');
    if (!line.test(segment)) {
      throw new Error(`fixture: ${platformHeader(tool, platform)} has no ${field}`);
    }
    return segment.replace(line, () => (value === undefined ? '' : `${field} = ${JSON.stringify(value)}\n`));
  });
}

/** The lock with `tool`'s `field` in its entry table set to `value`. */
function setEntryField(tool: Tool, field: string, value: string): string {
  return editTable(LOCK_TEXT, entryHeader(tool), (segment: string) =>
    replaceOnce(
      segment,
      `${field} = ${JSON.stringify(text(lockEntry(tool)[field]))}\n`,
      `${field} = ${JSON.stringify(value)}\n`,
    ),
  );
}

/** The lock with a copy of `tool`'s `P` table added under `platform`. */
function addPlatformTable(tool: Tool, platform: string, source = LOCK_TEXT): string {
  const entry = platformEntry(tool, P);
  const lines = Object.entries(entry).map(([key, value]) => `${key} = ${JSON.stringify(text(value))}`);
  return `${source}\n${platformHeader(tool, platform)}\n${lines.join('\n')}\n`;
}

/** The pins with `lockfile_platforms` set to `platforms`. */
function withPlatforms(platforms: readonly string[]): string {
  return PINS_TEXT.replace(/^lockfile_platforms = .*$/m, () => `lockfile_platforms = ${JSON.stringify(platforms)}`);
}

/** The pins with the `url_replacements` line replaced by `line`. */
function withRule(line: string): string {
  if (!/^url_replacements = .*$/m.test(PINS_TEXT)) {
    throw new Error(`fixture: ${PINS} has no url_replacements line`);
  }
  return PINS_TEXT.replace(/^url_replacements = .*$/m, () => line);
}

/** The pins with `line` added to [tools]. */
function withPinLine(line: string): string {
  return replaceOnce(PINS_TEXT, '[tools]\n', `[tools]\n${line}\n`);
}

/** The pins with `tool` pinned to `version`. */
function withPin(tool: Tool, version: string): string {
  return replaceOnce(PINS_TEXT, `${tool.key} = "${pinned(tool)}"\n`, `${tool.key} = ${JSON.stringify(version)}\n`);
}

/* ///// The fixture ///// */

let home: string;
let cwd: string;
/** Directories outside the working directory the case made, removed after it. */
let outside: string[] = [];

beforeAll(() => {
  home = process.cwd();
});

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gate-tools-'));
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(home);
  rmSync(cwd, { recursive: true, force: true });
  for (const path of outside) {
    rmSync(path, { recursive: true, force: true });
  }
  outside = [];
});

/** Writes the two files into the working directory, each unless undefined. */
function writeFiles(pins: string | undefined = PINS_TEXT, lock: string | undefined = LOCK_TEXT): void {
  if (pins !== undefined) {
    writeFileSync(PINS, pins);
  }
  if (lock !== undefined) {
    writeFileSync(LOCK, lock);
  }
}

/** Plants `entry` at the working directory: a directory when it ends in `/`, an empty file otherwise. */
function plantEntry(entry: string): void {
  if (entry.endsWith('/')) {
    mkdirSync(entry, { recursive: true });
    return;
  }
  if (dirname(entry) !== '.') {
    mkdirSync(dirname(entry), { recursive: true });
  }
  writeFileSync(entry, '');
}

/**
 * The findings for the working directory. A throw comes back as a finding
 * naming it, so a case that throws fails on its assertion.
 */
async function findings(): Promise<string[]> {
  try {
    return await lockfileFindings();
  } catch (error: unknown) {
    return [`threw: ${String(error)}`];
  }
}

/**
 * The preflight's findings for the working directory, where a root `.config`
 * is refused. The preflight reads the gate's own `scripts` directory, so the
 * case gets an empty one. A throw comes back as a finding naming it, so a case
 * that throws fails on its assertion.
 */
async function preflightFindings(): Promise<string[]> {
  mkdirSync('scripts', { recursive: true });
  try {
    return await startupFindings();
  } catch (error: unknown) {
    return [`threw: ${String(error)}`];
  }
}

/** An asymmetric matcher for a finding carrying `fragment`. */
function carrying(fragment: string): string {
  return expect.stringContaining(fragment) as string;
}

/**
 * `value` as a finding quotes it. Every value a case quotes is printable
 * ASCII, where the rule's escaping and plain JSON agree.
 */
function quoted(value: string): string {
  return JSON.stringify(value);
}

/** The line that closes every list of refused files and links. */
const CLOSING = 'Remove each file and link named above.';

test('the committed mise.toml and mise.lock yield no finding', async () => {
  writeFiles();

  expect(await findings()).toEqual([]);
});

/* ///// The refused-file list ///// */

const REFUSED_MISE: readonly string[] = [
  'mise.local.toml',
  '.mise.toml',
  '.mise.local.toml',
  'mise.ci.toml',
  'mise.ci.local.toml',
  '.mise.ci.toml',
  'mise.local.lock',
  'mise.ci.lock',
  'mise.windows.lock',
  '.miserc.toml',
  '.tool-versions',
  'mise/',
  '.mise/',
  '.config/mise/',
  '.config/mise.toml',
  '.config/mise.lock',
  '.config/miserc.toml',
  'MISE.LOCAL.TOML',
  '.Tool-Versions',
];

test.each([...REFUSED_MISE])('%p is refused as a file mise reads', async (entry: string) => {
  writeFiles();
  plantEntry(entry);

  const named = entry.endsWith('/') ? entry.slice(0, -1) : entry;
  expect(await findings()).toEqual([carrying(`mise reads ${quoted(named)} beside ${PINS} and ${LOCK}`), CLOSING]);
});

const ALLOWED: readonly string[] = [
  'bun.lock',
  'bunfig.toml',
  'gh-notes.md',
  'github.txt',
  'mise-notes.md',
  '.gitignore',
  '.github/',
  'node_modules/',
  'gh/',
];

test.each([...ALLOWED])('%p is not refused as a file mise reads', async (entry: string) => {
  writeFiles();
  plantEntry(entry);

  expect(await findings()).toEqual([]);
});

test.each([PINS, LOCK])('the pinned file %p is allowed spelled in upper case', async (name: string) => {
  writeFiles();
  const upper = name.toUpperCase();
  // The exclusive create fails where the filesystem opens either spelling,
  // and there the pinned file itself takes the upper-case name.
  try {
    writeFileSync(upper, '', { flag: 'wx' });
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
    renameSync(name, upper);
  }
  expect(readdirSync('.')).toContain(upper);

  expect(await findings()).toEqual([]);
});

test("every entry at this repository's root, mirrored empty, yields no finding", async () => {
  writeFiles();
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.name !== PINS && entry.name !== LOCK) {
      plantEntry(entry.isDirectory() ? `${entry.name}/` : entry.name);
    }
  }

  expect(await findings()).toEqual([]);
});

test('a .config that is a file rather than a directory yields no finding', async () => {
  writeFiles();
  plantEntry('.config');

  expect(await findings()).toEqual([]);
});

test.each(['.config/', '.config/other.toml', '.CONFIG/', '.Config'])(
  'a root .config planted as %p is refused before any row',
  async (entry: string) => {
    writeFiles();
    plantEntry(entry);
    const name = entry.split('/')[0] ?? entry;

    expect(await preflightFindings()).toEqual(
      expect.arrayContaining([carrying(`${quoted(name)} is at the root, and mise, lefthook`)]) as string[],
    );
  },
);

test('a .config below the root is not refused as the root one', async () => {
  writeFiles();
  plantEntry('docs/.config/other.toml');

  expect((await preflightFindings()).filter((finding) => finding.includes('is at the root'))).toEqual([]);
});

/** Links `link`, below the working directory, to a directory outside it. */
function linkOut(link: string): void {
  const target = mkdtempSync(join(tmpdir(), 'gate-link-target-'));
  outside.push(target);
  symlinkSync(target, link, WINDOWS ? 'junction' : 'dir');
}

test.each(['alias', '.config/inner', '.mise/inner', 'mise/inner', '.config/deep/inner'])(
  'a link at %p is refused',
  async (path: string) => {
    writeFiles();
    if (dirname(path) !== '.') {
      mkdirSync(dirname(path), { recursive: true });
    }
    linkOut(path);

    const found = await findings();

    expect(found).toContain(CLOSING);
    expect(found).toEqual(expect.arrayContaining([carrying(`${quoted(path)} is a link`)]) as string[]);
  },
);

test.if(!WINDOWS)('a control character in a refused name prints as an escape', async () => {
  writeFiles();
  plantEntry('mise.\u0007.toml');

  const found = (await findings()).join('\n');

  expect(found).toContain('mise.\\u0007.toml');
  expect(found).not.toContain('\u0007');
});

test.each(['', LOCK, PINS])('a missing file is a finding naming it (%p present alone)', async (present: string) => {
  if (present === PINS) {
    writeFileSync(PINS, PINS_TEXT);
  } else if (present === LOCK) {
    writeFileSync(LOCK, LOCK_TEXT);
  }

  const expected = [PINS, LOCK]
    .filter((file) => file !== present)
    .map((file) => carrying(`${file} is missing from the root`));
  expect(await findings()).toEqual(expected);
});
/* ///// The lockfile rules ///// */

interface LockCase {
  readonly label: string;
  readonly pins?: () => string;
  readonly lock?: () => string;
  /** A fragment each expected finding carries, or empty when the files must pass. */
  readonly refused: readonly string[];
  /** Fragments no finding may carry. */
  readonly absent?: readonly string[];
}

const T = ATTESTED;
const ARTIFACT_URL = text(platformEntry(T, P)['url']);
const URL_API = text(platformEntry(T, P)['url_api']);
const API_PREFIX = URL_API.slice(0, URL_API.lastIndexOf('/') + 1);
const API_ID = URL_API.slice(API_PREFIX.length);
const CHECKSUM = text(platformEntry(T, P)['checksum']);
const VERSION = pinned(T);
const SETTINGS_REFUSED = `${PINS} [settings] is`;
const [RULE_PATTERN = '', RULE_TARGET = ''] = Object.entries(URL_REPLACEMENTS)[0] ?? [];

/** A case that sets `T`'s url on `P` to `url` and expects it refused by name. */
function urlCase(label: string, url: string): LockCase {
  return {
    label: `url: ${label} is refused`,
    lock: () => setField(T, P, 'url', url),
    refused: [`${T.key} ${P} url is ${quoted(url)}`],
  };
}

/** A case that sets `T`'s url_api on `P` to `urlApi` and expects it refused by name. */
function apiCase(label: string, urlApi: string): LockCase {
  return {
    label: `url_api: ${label} is refused`,
    lock: () => setField(T, P, 'url_api', urlApi),
    refused: [`${T.key} ${P} url_api is ${quoted(urlApi)}`],
  };
}

/** The pins with `T`'s line replaced by `line`. */
function withToolLine(line: string): string {
  return replaceOnce(PINS_TEXT, `${T.key} = "${VERSION}"\n`, `${line}\n`);
}

/** The lock with `line` added to `T`'s entry table. */
function withEntryLine(line: string): string {
  return editTable(LOCK_TEXT, entryHeader(T), (segment: string) => `${segment}${line}\n`);
}

/** The lock with `line` added to `T`'s `P` table. */
function withPlatformLine(line: string): string {
  return editTable(LOCK_TEXT, platformHeader(T, P), (segment: string) => `${segment}${line}\n`);
}

/** The lock with `T`'s `P` table removed. */
function withoutPlatformTable(): string {
  return editTable(LOCK_TEXT, platformHeader(T, P), () => '');
}

const LOCK_CASES: readonly LockCase[] = [
  urlCase('a host in another case', ARTIFACT_URL.replace('https://github.com/', 'https://GitHub.com/')),
  urlCase('a port', ARTIFACT_URL.replace('https://github.com/', 'https://github.com:443/')),
  urlCase('userinfo', ARTIFACT_URL.replace('https://github.com/', 'https://user@github.com/')),
  urlCase('a trailing dot on the host', ARTIFACT_URL.replace('https://github.com/', 'https://github.com./')),
  urlCase('a query', `${ARTIFACT_URL}?x=1`),
  urlCase('a fragment', `${ARTIFACT_URL}#x`),
  urlCase('a dot segment', ARTIFACT_URL.replace('/releases/download/', '/releases/x/../download/')),
  urlCase('percent-encoded dots', ARTIFACT_URL.replace('/releases/download/', '/releases/%2e%2e/releases/download/')),
  urlCase('a missing asset', ARTIFACT_URL.slice(0, ARTIFACT_URL.lastIndexOf('/') + 1)),
  urlCase('an extra segment', `${ARTIFACT_URL}/x`),
  urlCase(
    'another release',
    ARTIFACT_URL.replace(`/download/${T.tagPrefix}${VERSION}/`, `/download/${T.tagPrefix}0.0.1/`),
  ),
  urlCase("another platform's asset", text(platformEntry(T, Q)['url'])),
  {
    label: 'url: a missing url is refused',
    lock: () => setField(T, P, 'url', undefined),
    refused: [`${T.key} ${P} carries no url in ${LOCK}`],
  },
  apiCase('an empty id', API_PREFIX),
  apiCase('fullwidth digits', `${API_PREFIX}\uFF13\uFF18\uFF14`),
  apiCase('a trailing newline', `${URL_API}\n`),
  apiCase('a signed id', `${API_PREFIX}+${API_ID}`),
  apiCase('a sibling repository', URL_API.replace(`/${T.repository}/releases/`, `/${T.repository}-fork/releases/`)),
  apiCase('a traversal', URL_API.replace('/releases/assets/', '/releases/assets/../assets/')),
  apiCase('a host in another case', URL_API.replace('api.github.com', 'API.github.com')),
  {
    label: 'url_api: a missing url_api is refused',
    lock: () => setField(T, P, 'url_api', undefined),
    refused: [`${T.key} ${P} carries no url_api in ${LOCK}`],
  },
  {
    label: 'url_api: the prefix and another run of digits passes',
    lock: () => setField(T, P, 'url_api', `${API_PREFIX}1`),
    refused: [],
  },
  {
    label: 'pin: a version carrying a path is refused, and no url is built from it',
    pins: () => withPin(T, `${VERSION}/../x`),
    refused: [`${PINS} pins ${T.key} ${quoted(`${VERSION}/../x`)}, outside the form`],
    absent: [' url is '],
  },
  {
    label: 'pin: a version with a v prefix is refused',
    pins: () => withPin(T, `v${VERSION}`),
    refused: [`${PINS} pins ${T.key} ${quoted(`v${VERSION}`)}, outside the form`],
  },
  {
    label: 'pin: a version of two parts is refused',
    pins: () => withPin(T, '1.7'),
    refused: [`${PINS} pins ${T.key} ${quoted('1.7')}, outside the form`],
  },
  {
    label: 'pin: a lock version outside the form is refused',
    lock: () => setEntryField(T, 'version', `${VERSION}-rc1`),
    refused: [`${LOCK} records ${T.key} ${quoted(`${VERSION}-rc1`)}, outside the form`],
  },
  {
    label: 'pin: a pin the lock does not record is refused',
    pins: () => withPin(T, '0.0.1'),
    refused: [`${PINS} pins ${T.key} ${quoted('0.0.1')}, and ${LOCK} records ${quoted(VERSION)}`],
  },
  ...['jq', 'constructor', 'toString', '__proto__'].map((key: string): LockCase => ({
    label: `pin: a tool named ${key} is refused`,
    pins: () => withPinLine(`${key} = "1.0.0"`),
    refused: [`${PINS} pins ${quoted(key)}, and scripts/tools.ts holds no expectation for it`],
  })),
  {
    label: 'pin: a tool scripts/tools.ts expects and mise.toml lacks is refused',
    pins: () => replaceOnce(PINS_TEXT, `${PLAIN.key} = "${pinned(PLAIN)}"\n`, ''),
    refused: [`scripts/tools.ts expects ${PLAIN.key}, and ${PINS} does not pin it`],
  },
  {
    label: 'pin: a tool table of version and the tag prefix passes',
    pins: () => withToolLine(`${T.key} = { version = "${VERSION}", version_prefix = "${T.tagPrefix}" }`),
    refused: [],
  },
  {
    label: 'pin: a tool table with another version_prefix is refused',
    pins: () => withToolLine(`${T.key} = { version = "${VERSION}", version_prefix = "x" }`),
    refused: [`${PINS} [tools] for ${T.key} carries version_prefix ${quoted('x')}`],
  },
  {
    label: 'pin: a tool table with another key is refused',
    pins: () => withToolLine(`${T.key} = { version = "${VERSION}", postinstall = "echo" }`),
    refused: [
      `${PINS} [tools] for ${T.key} carries ${quoted('postinstall')}, and it carries version and version_prefix alone`,
    ],
  },
  {
    label: 'pin: a tool table whose version is not a string is refused',
    pins: () => withToolLine(`${T.key} = { version = 1 }`),
    refused: [`${PINS} [tools] for ${T.key} carries version ${quoted('1')}, and it is a string`],
  },
  {
    label: 'pin: a tool pinned to a number is refused',
    pins: () => withToolLine(`${T.key} = 1`),
    refused: [`${PINS} [tools] for ${T.key} is ${quoted('1')}, and it is a version or a table`],
  },
  ...['env', 'vars', 'hooks', 'tasks', '__proto__'].map((table: string): LockCase => ({
    label: `pins: a [${table}] table is refused`,
    pins: () => `${PINS_TEXT}\n[${table}]\nx = "y"\n`,
    refused: [`${PINS} carries ${quoted(table)}, and it holds [tools], [tool_config] and [settings] alone`],
  })),
  {
    label: 'pins: [tool_config] with another value is refused',
    pins: () =>
      editTable(PINS_TEXT, '[tool_config]', (segment: string) =>
        replaceOnce(segment, 'locked = true\n', 'locked = false\n'),
      ),
    refused: [`${PINS} [tool_config] is`],
  },
  {
    label: 'pins: [tool_config] with another key is refused',
    pins: () => replaceOnce(PINS_TEXT, '[tool_config]\n', '[tool_config]\nmode = "x"\n'),
    refused: [`${PINS} [tool_config] is`],
  },
  {
    label: 'settings: an added setting is refused',
    pins: () => replaceOnce(PINS_TEXT, '[settings]\n', '[settings]\nexperimental = true\n'),
    refused: [SETTINGS_REFUSED],
  },
  {
    label: 'settings: a changed setting is refused',
    pins: () => replaceOnce(PINS_TEXT, '\nlockfile = true\n', '\nlockfile = false\n'),
    refused: [SETTINGS_REFUSED],
  },
  {
    label: 'settings: an added [settings] subtable is refused',
    pins: () => `${PINS_TEXT}\n[settings.env]\nx = "y"\n`,
    refused: [SETTINGS_REFUSED],
  },
  {
    label: 'settings: an added [settings.aqua] key is refused',
    pins: () => `${PINS_TEXT}extra = true\n`,
    refused: [SETTINGS_REFUSED],
  },
  {
    label: 'settings: another platform in lockfile_platforms is refused',
    pins: () => withPlatforms([...PLATFORMS, 'linux-arm64']),
    refused: [SETTINGS_REFUSED],
  },
  {
    label: 'rule: an absent url_replacements is refused',
    pins: () => withRule(''),
    refused: [SETTINGS_REFUSED],
  },
  {
    label: 'rule: another target is refused',
    pins: () => withRule(`url_replacements = { ${JSON.stringify(RULE_PATTERN)} = "https://elsewhere.invalid/" }`),
    refused: [SETTINGS_REFUSED],
  },
  {
    label: 'rule: a narrower pattern is refused',
    pins: () =>
      withRule(
        `url_replacements = { ${JSON.stringify(RULE_PATTERN.replace('[^/]+/[^/]+', `${T.owner}/[^/]+`))} = ${JSON.stringify(RULE_TARGET)} }`,
      ),
    refused: [SETTINGS_REFUSED],
  },
  ...['https://github.com/', '__proto__'].map((key: string): LockCase => ({
    label: `rule: an extra entry ${key} is refused`,
    pins: () =>
      withRule(
        `url_replacements = { ${JSON.stringify(RULE_PATTERN)} = ${JSON.stringify(RULE_TARGET)}, ${JSON.stringify(key)} = "https://mirror.invalid/" }`,
      ),
    refused: [SETTINGS_REFUSED],
  })),
  {
    label: 'rule: the rule spelled as TOML literal strings passes',
    pins: () => withRule(`url_replacements = { '${RULE_PATTERN}' = '${RULE_TARGET}' }`),
    refused: [],
  },
  {
    label: 'rule: the rule spelled as a [settings.url_replacements] table passes',
    pins: () =>
      `${withRule('')}\n[settings.url_replacements]\n${JSON.stringify(RULE_PATTERN)} = ${JSON.stringify(RULE_TARGET)}\n`,
    refused: [],
  },
  {
    label: 'lock: another top-level key is refused',
    lock: () => replaceOnce(LOCK_TEXT, 'lockfile_version = 1\n', 'lockfile_version = 1\nextra = "x"\n'),
    refused: [`${LOCK} carries ${quoted('extra')}, and it carries lockfile_version and tools alone`],
  },
  {
    label: 'lock: another lockfile_version is refused',
    lock: () => replaceOnce(LOCK_TEXT, 'lockfile_version = 1\n', 'lockfile_version = 2\n'),
    refused: [`${LOCK} records lockfile_version ${quoted('2')}`],
  },
  ...['jq', '__proto__'].map((key: string): LockCase => ({
    label: `lock: an entry for ${key} is refused`,
    lock: () => `${LOCK_TEXT}\n[[tools.${key}]]\nversion = "1.0.0"\nbackend = "aqua:x/y"\n`,
    refused: [`${LOCK} records ${quoted(key)}, and scripts/tools.ts holds no expectation for it`],
  })),
  ...['install_env', '__proto__'].map((key: string): LockCase => ({
    label: `lock: an entry key ${key} is refused`,
    lock: () => withEntryLine(`${key} = "x"`),
    refused: [`${LOCK} records ${quoted(key)} for ${T.key}, and an entry carries`],
  })),
  {
    label: 'lock: specifiers other than the pin are refused',
    lock: () => replaceOnce(LOCK_TEXT, `specifiers = ["${VERSION}"]`, 'specifiers = ["1.0.0"]'),
    refused: [`${LOCK} records specifiers ${quoted(JSON.stringify(['1.0.0']))} for ${T.key}`],
  },
  {
    label: 'lock: options carrying another version are refused',
    lock: () => withEntryLine('options = { version = "0.0.1" }'),
    refused: [`${LOCK} options for ${T.key} carry version ${quoted('0.0.1')}, and ${PINS} pins ${quoted(VERSION)}`],
  },
  {
    label: 'lock: options carrying another key are refused',
    lock: () => withEntryLine(`options = { version = "${VERSION}", postinstall = "echo" }`),
    refused: [`${LOCK} options for ${T.key} carries ${quoted('postinstall')}`],
  },
  {
    label: 'lock: two entries for a tool are refused',
    lock: () => {
      const start = LOCK_TEXT.indexOf(`${entryHeader(T)}\n`);
      const end = LOCK_TEXT.indexOf('\n[', start + 1) + 1;
      return `${LOCK_TEXT}\n${LOCK_TEXT.slice(start, end)}`;
    },
    refused: [`${LOCK} records 2 entries for ${T.key}`],
  },
  {
    label: 'lock: no entry for a tool is refused',
    lock: () =>
      LOCK_TEXT.split(/\n(?=\[)/)
        .filter((section) => !section.startsWith(`[[tools.${T.key}]]`) && !section.startsWith(`[tools.${T.key}.`))
        .join('\n'),
    refused: [`${LOCK} records no entries for ${T.key}`],
  },
  {
    label: 'lock: a nested platforms table is refused',
    lock: () => withEntryLine(`platforms = { ${JSON.stringify(P)} = { checksum = ${JSON.stringify(CHECKSUM)} } }`),
    refused: [`${LOCK} records a nested platforms table for ${T.key}`],
  },
  {
    label: 'lock: a platform table missing is refused',
    lock: withoutPlatformTable,
    refused: [`${LOCK} records no ${quoted(P)} entry for ${T.key}`],
  },
  ...['linux-arm64', 'toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__'].map(
    (platform: string): LockCase => ({
      label: `lock: a platform table for ${platform} is refused, and nothing throws`,
      lock: () => addPlatformTable(T, platform),
      refused: [`${LOCK} records a ${quoted(platform)} entry for ${T.key}, and LOCKFILE_PLATFORMS`],
    }),
  ),
  {
    label: 'lock: another key in a platform table is refused',
    lock: () => withPlatformLine('size = "1"'),
    refused: [`${T.key} ${P} carries ${quoted('size')} in ${LOCK}, and a platform table carries`],
  },
  {
    label: 'lock: a value that is not a string in a platform table is refused',
    lock: () =>
      editTable(LOCK_TEXT, platformHeader(T, P), (segment: string) =>
        segment.replace(/^checksum = .*\n/m, () => 'checksum = 1\n'),
      ),
    refused: [`${T.key} ${P} holds a value that is not a string`],
  },
  {
    label: 'backend: a rewritten backend is refused',
    lock: () => setEntryField(T, 'backend', `github:${T.owner}/${T.repository}`),
    refused: [`${LOCK} records backend ${quoted(`github:${T.owner}/${T.repository}`)} for ${T.key}`],
  },
  {
    label: 'provenance: an attested tool with none is refused',
    lock: () => setField(T, P, 'provenance', undefined),
    refused: [`${T.key} ${P} records provenance none`],
  },
  {
    label: 'provenance: an attested tool with another is refused',
    lock: () => setField(T, P, 'provenance', 'slsa'),
    refused: [`${T.key} ${P} records provenance ${quoted('slsa')}`],
  },
  {
    label: 'provenance: an unattested tool with none passes',
    lock: () => {
      // The fixture holds only when the committed entry carries no provenance.
      if ('provenance' in platformEntry(PLAIN, P)) {
        throw new Error(`fixture: ${PLAIN.key} ${P} carries provenance`);
      }
      return LOCK_TEXT;
    },
    refused: [],
  },
  {
    label: 'checksum: a missing checksum is refused',
    lock: () => setField(T, P, 'checksum', undefined),
    refused: [`${T.key} ${P} carries no checksum`],
  },
  {
    label: 'checksum: a short checksum is refused',
    lock: () => setField(T, P, 'checksum', 'sha256:abc'),
    refused: [`${T.key} ${P} carries checksum ${quoted('sha256:abc')}`],
  },
  {
    label: 'checksum: upper-case hex is refused',
    lock: () => setField(T, P, 'checksum', `sha256:${CHECKSUM.slice('sha256:'.length).toUpperCase()}`),
    refused: [`${T.key} ${P} carries checksum`],
  },
  {
    label: 'checksum: an escape sequence is refused and printed as the six characters \\u001b',
    lock: () => setField(T, P, 'checksum', `${CHECKSUM}\u001b[2K`),
    refused: [`${T.key} ${P} carries checksum ${quoted(`${CHECKSUM}\u001b[2K`)}`, '\\u001b[2K'],
    absent: ['\u001b'],
  },
  {
    label: 'checksum: a bidi control is refused and printed escaped',
    lock: () => setField(T, P, 'checksum', `${CHECKSUM}\u202E`),
    refused: [`${T.key} ${P} carries checksum`, '\\u202e'],
    absent: ['\u202E'],
  },
];

test.each([...LOCK_CASES])('$label', async ({ pins, lock, refused, absent }: LockCase) => {
  writeFiles(pins?.(), lock?.());

  const found = await findings();

  if (refused.length === 0) {
    expect(found).toEqual([]);
  }
  for (const fragment of refused) {
    expect(found).toEqual(expect.arrayContaining([carrying(fragment)]) as string[]);
  }
  for (const fragment of absent ?? []) {
    expect(found.filter((finding) => finding.includes(fragment))).toEqual([]);
  }
});

/* ///// What mise is started with ///// */

// The environment mise gets, written out here rather than read from the
// module: the pins, and the global and system config both at the checkout's
// mise.toml, hooks off, and the checkout trusted.
function expectedPins(root: string): Readonly<Record<string, string>> {
  return {
    MISE_OVERRIDE_CONFIG_FILENAMES: 'mise.toml',
    MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: 'none',
    MISE_ENV: '',
    MISE_AUTO_ENV: 'false',
    MISE_GLOBAL_CONFIG_FILE: join(root, 'mise.toml'),
    MISE_SYSTEM_CONFIG_FILE: join(root, 'mise.toml'),
    MISE_NO_HOOKS: '1',
    MISE_TRUSTED_CONFIG_PATHS: root,
  };
}

// Names that point mise at another config, data or environment when they
// reach it, set in the gate's own environment by each case below.
const DECOYS: Readonly<Record<string, string>> = {
  MISE_CONFIG_FILE: 'decoy.toml',
  MISE_DEFAULT_CONFIG_FILENAME: 'decoy.toml',
  MISE_ENV_CONF_D: 'decoy.d',
  MISE_DATA_DIR: 'decoy-data',
  MISE_CONFIG_DIR: 'decoy-config',
  mise_env: 'ci',
  Mise_Override_Config_Filenames: 'decoy.toml',
  XDG_CONFIG_HOME: 'decoy-xdg',
  GATE_DECOY: 'decoy',
};

/** Asserts `env` carries every pin once at its value, MISE_URL_REPLACEMENTS as mise.toml holds it, and no decoy. */
function expectMiseEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(expectedPins(process.cwd()))) {
    expect(spellings(env, name)).toEqual([name]);
    expect(env[name]).toBe(value);
  }
  expect(spellings(env, 'MISE_URL_REPLACEMENTS')).toEqual(['MISE_URL_REPLACEMENTS']);
  expect(JSON.parse(env['MISE_URL_REPLACEMENTS'] ?? 'null')).toEqual(SETTINGS['url_replacements']);
  for (const name of ['MISE_CONFIG_FILE', 'MISE_DEFAULT_CONFIG_FILENAME', 'MISE_ENV_CONF_D', 'MISE_DATA_DIR']) {
    expect(spellings(env, name)).toEqual([]);
  }
  for (const name of ['MISE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'GATE_DECOY']) {
    expect(spellings(env, name)).toEqual([]);
  }
}

let standIns: StandIns;
let restore: (() => void) | undefined;

beforeAll(() => {
  standIns = new StandIns(['mise', ...TOOLS.map((tool) => tool.binary)]);
});

afterAll(() => {
  standIns.remove();
});

beforeEach(() => {
  restore = isolate(standIns);
  standIns.clear();
  for (const [name, value] of Object.entries(DECOYS)) {
    process.env[name] = value;
  }
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

test('the mise environment holds every pin and nothing from the gate environment beyond its allow-list', () => {
  const env = miseEnvironment();

  expectMiseEnvironment(env);
  expect(spellings(env, 'PATH')).toEqual([]);
});

test.if(WINDOWS)(
  'the mise environment reads the system root and local app data from the Shell, not the environment',
  () => {
    process.env['SYSTEMROOT'] = join(cwd, 'decoy-root');
    process.env['LOCALAPPDATA'] = join(cwd, 'decoy-appdata');

    const env = miseEnvironment();

    expect(env['SYSTEMROOT']).not.toBe(process.env['SYSTEMROOT']);
    expect(env['LOCALAPPDATA']).not.toBe(process.env['LOCALAPPDATA']);
    expect(statSync(join(env['SYSTEMROOT'] ?? '', 'System32')).isDirectory()).toBe(true);
    expect(statSync(env['LOCALAPPDATA'] ?? '').isDirectory()).toBe(true);
  },
);

test('the mise environment carries the temporary directory and the proxy the gate has', () => {
  const temp = WINDOWS ? 'TEMP' : 'TMPDIR';
  process.env[temp] = join(cwd, 'temp');
  process.env['HTTPS_PROXY'] = 'http://127.0.0.1:9';

  const env = miseEnvironment();

  expect(env[temp]).toBe(join(cwd, 'temp'));
  expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:9');
});

test('install starts mise install --locked in the mise environment and nothing else', async () => {
  writeFiles();

  await install();

  const calls = standIns.calls();
  expect(calls.map((call) => [call.name, ...call.args])).toEqual([['mise', 'install', '--locked']]);
  expectMiseEnvironment(calls[0]?.env ?? {});
});

test('a failed install throws with what mise printed', async () => {
  writeFiles();
  standIns.answer('mise', { stdout: 'no such version', exitCode: 1 });

  const outcome = await install().then(
    () => 'installed',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(outcome).toMatch(/mise install --locked exited 1 saying: no such version/);
});

/** Answers `mise which <binary>` with each tool's stand-in, which prints its version as `reported` gives it. */
function answerTools(reported: (tool: Tool) => string): void {
  for (const tool of TOOLS) {
    standIns.answer('mise', { stdout: `${standIns.path(tool.binary)}\n` }, `which ${tool.binary}`);
    standIns.answer(tool.binary, { stdout: `${tool.binary} ${reported(tool)}\n` });
  }
}

test('resolve asks mise for every binary in the mise environment, and returns what mise names', async () => {
  writeFiles();
  answerTools(pinned);

  const resolved = await resolve();

  expect([...resolved.entries()]).toEqual(TOOLS.map((tool) => [tool.key, standIns.path(tool.binary)]));
  const which = standIns.calls().filter((call) => call.name === 'mise');
  expect(which.map((call) => call.args)).toEqual(TOOLS.map((tool) => ['which', tool.binary]));
  for (const call of which) {
    expectMiseEnvironment(call.env);
  }
});

test('resolve refuses a binary reporting a version other than its pin', async () => {
  writeFiles();
  answerTools((tool: Tool) => (tool === PLAIN ? '0.0.1' : pinned(tool)));

  const outcome = await resolve().then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(outcome).toContain(`reports ${PLAIN.key} 0.0.1, and ${PINS} pins ${quoted(pinned(PLAIN))}`);
});

test('resolve reports a mise which that fails by its exit, and one that names nothing as missing', async () => {
  writeFiles();
  answerTools(pinned);
  standIns.answer('mise', { stdout: 'mise crashed\n', exitCode: 2 }, `which ${PLAIN.binary}`);

  const failed = await resolve().then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  standIns.answer('mise', { stdout: '\n' }, `which ${PLAIN.binary}`);
  const empty = await resolve().then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(failed).toContain(`mise which ${PLAIN.binary} exited 2 saying: mise crashed`);
  expect(failed).not.toContain('found nothing');
  expect(empty).toContain(`mise which ${PLAIN.binary} found nothing`);
});

test('resolve reports a version flag that fails by its exit, not as a version mismatch', async () => {
  writeFiles();
  answerTools(pinned);
  standIns.answer(PLAIN.binary, { stdout: `${PLAIN.binary} ${pinned(PLAIN)}\n`, exitCode: 3 });

  const outcome = await resolve().then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(outcome).toContain(`${PLAIN.versionFlag} exited 3 saying:`);
  expect(outcome).not.toContain('Install it with');
});

test('resolve reads a version printed in color', async () => {
  writeFiles();
  answerTools((tool: Tool) => `${String.fromCharCode(0x1b)}[1m${pinned(tool)}${String.fromCharCode(0x1b)}[0m`);

  expect((await resolve()).size).toBe(TOOLS.length);
});
