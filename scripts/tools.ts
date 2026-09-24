/**
 * The tools mise installs for the gate: what mise.toml and mise.lock must say
 * about each one, checked before anything installs from them.
 *
 * @remarks
 * In locked mode mise fetches the url a lockfile entry records and compares
 * the checksum it records. mise refuses a version the lockfile does not name
 * and a platform it does not cover. It accepts an entry with no checksum, a
 * rewritten backend or another url, and when a HEAD on the url fails it
 * installs from the entry's url_api instead, an asset named by a bare id. Those
 * sit in a generated file that a bump rewrites wholesale, so every artifact's
 * exact url, each tool's version form, the api prefix and the provenance live
 * here, in source, and the lockfile is held to them byte for byte. No url
 * parser reads either address, so no parser can read one differently from
 * mise.
 *
 * This file imports zod from node_modules, so the gate loads it only once
 * the checks before its rows pass.
 */

import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from 'bun:ffi';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, type Finished, fold, plain, PROXY_NAMES, quote, run } from './run';
import { directoryEntries, isTable, LOCK, PINS, quoteValue, sameValue } from './startup';

/** The command that rewrites {@link LOCK} after an edit to {@link PINS}. */
const RELOCK = 'mise lock';

/** What every release artifact url in {@link LOCK} starts with. */
const RELEASE_ROOT = 'https://github.com/';

/** What every release api reference in {@link LOCK} starts with. */
const API_ROOT = 'https://api.github.com/repos/';

/** The provenance {@link LOCK} records for a release carrying an attestation. */
const ATTESTED = 'github-attestations';

/** Three dot-separated runs of ASCII digits, the form every tool here releases under. */
const DOTTED_TRIPLE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * The `url_replacements` map {@link PINS} carries and every install pins
 * through `MISE_URL_REPLACEMENTS`.
 *
 * @remarks
 * It sends every release api reference to a host that does not resolve, so
 * mise's fallback to a lockfile entry's url_api fails rather than installing
 * whatever release that id names. The environment copy is the one that holds:
 * a committed config file read after {@link PINS} can replace the map there.
 */
export const URL_REPLACEMENTS: Readonly<Record<string, string>> = {
  'regex:^https://api\\.github\\.com/repos/[^/]+/[^/]+/releases/assets/.*$': 'https://url-api-refused.invalid/',
};

/** The platforms {@link LOCK} pins, which are the platforms the ci matrix runs. */
const LOCKFILE_PLATFORMS: readonly string[] = ['linux-x64', 'macos-arm64', 'windows-x64'];

/** The `[tool_config]` table {@link PINS} holds, compared whole. */
const EXPECTED_TOOL_CONFIG = { locked: true } as const;

/**
 * The `[settings]` table {@link PINS} holds, compared whole.
 *
 * @remarks
 * A key added, dropped or changed in the file is a finding, so a setting that
 * turns a check off cannot arrive in a diff that reads as data. `mise.toml`
 * says what each key does.
 */
const EXPECTED_SETTINGS = {
  locked: true,
  lockfile: true,
  lockfile_platforms: LOCKFILE_PLATFORMS,
  url_replacements: URL_REPLACEMENTS,
  locked_verify_provenance: true,
  provenance_api_failures_fatal: true,
  github_attestations: true,
  aqua: { github_attestations: true },
} as const;

/** The tables {@link PINS} may hold. mise runs `[hooks]`, `[env]` and `[vars]` on install, so none of them is one. */
const PIN_SECTIONS: readonly string[] = ['tools', 'tool_config', 'settings'];

/** The `lockfile_version` {@link LOCK} records. */
const LOCKFILE_VERSION = 1;

/** The keys a tool entry in {@link LOCK} may carry, beside one quoted `platforms.<name>` table per platform. */
const ENTRY_KEYS: readonly string[] = ['version', 'backend', 'specifiers', 'options'];

/** The keys one platform table in {@link LOCK} may carry. */
const PLATFORM_KEYS: readonly string[] = ['checksum', 'url', 'url_api', 'provenance'];

/** The keys a tool's table may carry, in {@link PINS} and in a {@link LOCK} entry's `options`. */
const TOOL_OPTION_KEYS: readonly string[] = ['version', 'version_prefix'];

/**
 * The variables a mise child takes from the gate's own environment, where
 * set: the temporary directory, the Unix home directory, and the proxy a
 * machine can need to reach GitHub.
 *
 * @remarks
 * No other name reaches mise, and no `MISE_` or `XDG_` name at all. Bun
 * loads a `.env` file into the gate's environment before the gate runs, and
 * a `MISE_` path or an `XDG_` directory there would point mise at a config or
 * a data directory inside the checkout. A file only adds a variable the
 * environment does not already set, so each name below carries the machine's
 * own value wherever the machine sets it.
 */
const MISE_INHERITED: Readonly<Record<'posix' | 'windows', readonly string[]>> = {
  posix: ['HOME', 'TMPDIR', ...PROXY_NAMES],
  windows: ['TEMP', 'TMP', ...PROXY_NAMES],
};

/** A Windows known folder's id, laid out as the GUID structure the Shell reads. */
function folderId(data1: number, data2: number, data3: number, data4: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data1, true);
  view.setUint16(4, data2, true);
  view.setUint16(6, data3, true);
  bytes.set(data4, 8);
  return bytes;
}

/**
 * A Windows known folder's path, read from the Shell rather than the
 * environment, so no variable anyone sets can move it.
 *
 * @throws When the Shell reports no path for the folder
 */
function knownFolder(id: Uint8Array): string {
  const shell32 = dlopen('shell32.dll', {
    SHGetKnownFolderPath: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const kernel32 = dlopen('kernel32.dll', { lstrlenW: { args: [FFIType.ptr], returns: FFIType.i32 } });
  const ole32 = dlopen('ole32.dll', { CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void } });
  try {
    const out = new BigUint64Array(1);
    const status = shell32.symbols.SHGetKnownFolderPath(ptr(id), 0, null, ptr(out));
    const address = Number(out[0]) as Pointer;
    if (status !== 0 || address === 0) {
      throw new Error(`SHGetKnownFolderPath returned ${String(status)}`);
    }
    const length = kernel32.symbols.lstrlenW(address);
    const path = new TextDecoder('utf-16le').decode(toArrayBuffer(address, 0, length * 2));
    ole32.symbols.CoTaskMemFree(address);
    return path;
  } finally {
    shell32.close();
    kernel32.close();
    ole32.close();
  }
}

/**
 * The whole environment of every mise command the gate starts.
 *
 * @remarks
 * On Windows, mise needs the system root to reach the network and the local
 * application data folder for its data directory, and both come from the
 * Shell's known folders. Everything else is {@link MISE_INHERITED} and the
 * values below.
 *
 * The four config pins keep mise to {@link PINS} and {@link LOCK}: no other
 * config filename, no `.tool-versions`, and no per-environment file, whether
 * an environment comes from `MISE_ENV`, a `.miserc.toml` or the platform. The
 * global and system config paths name {@link PINS} too, so no config outside
 * the checkout reaches the install either, and `MISE_NO_HOOKS` stops a hook
 * that reached it anyway. Trust covers the checkout, the directory
 * jdx/mise-action trusts in CI, because the tools row asserts {@link PINS}
 * whole before any mise command runs. {@link lockfileFindings} refuses the
 * other files in the tree as well, because a mise command outside the gate
 * carries none of this.
 */
export function miseEnvironment(): Record<string, string> {
  const root = process.cwd();
  const windows = process.platform === 'win32';
  const inherited: Record<string, string> = {};
  for (const name of MISE_INHERITED[windows ? 'windows' : 'posix']) {
    const value = process.env[name];
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  if (windows) {
    inherited['SYSTEMROOT'] = knownFolder(
      folderId(0xf38bf404, 0x1d43, 0x42f2, [0x93, 0x05, 0x67, 0xde, 0x0b, 0x28, 0xfc, 0x23]),
    );
    inherited['LOCALAPPDATA'] = knownFolder(
      folderId(0xf1b32785, 0x6fba, 0x4fcf, [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91]),
    );
  }
  return {
    ...inherited,
    MISE_OVERRIDE_CONFIG_FILENAMES: PINS,
    MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES: 'none',
    MISE_ENV: '',
    MISE_AUTO_ENV: 'false',
    MISE_URL_REPLACEMENTS: JSON.stringify(URL_REPLACEMENTS),
    MISE_GLOBAL_CONFIG_FILE: join(root, PINS),
    MISE_SYSTEM_CONFIG_FILE: join(root, PINS),
    MISE_NO_HOOKS: '1',
    MISE_TRUSTED_CONFIG_PATHS: root,
  };
}

/**
 * A tool {@link PINS} names, and the GitHub release its artifacts come from.
 */
export interface Tool {
  /** The key {@link PINS} spells the tool under. */
  readonly key: string;
  /** The binary the gate runs once mise installs it. */
  readonly binary: string;
  /** The account owning the repository the release belongs to. */
  readonly owner: string;
  /** The repository the release belongs to. */
  readonly repository: string;
  /** What the release tag carries ahead of the version. */
  readonly tagPrefix: string;
  /**
   * The form every release version of the tool takes, anchored at both ends.
   * A version is substituted into the artifact url, so a version outside this
   * form is refused before any url is built from it.
   */
  readonly versionPattern: RegExp;
  /**
   * The artifact's file name per lockfile platform, with `{version}` standing
   * for the pinned version. Every platform `lockfile_platforms` names has one,
   * and no other.
   */
  readonly assets: Readonly<Record<string, string>>;
  /** The argument that makes the binary print its version. */
  readonly versionFlag: string;
  /** Whether the release carries an attestation, so {@link LOCK} must record {@link ATTESTED}. */
  readonly attested: boolean;
}

/**
 * Every tool the gate runs, with the release each one's artifacts come from.
 *
 * @remarks
 * A bare registry key in {@link PINS} names no owner, so this table is the one
 * place an aqua tool's account and asset names are written outside the
 * generated file. An artifact that moves to another account, or an asset an
 * upstream renames, takes an edit here, in the same diff as the lockfile it
 * explains.
 */
export const TOOLS: readonly Tool[] = [
  {
    key: 'actionlint',
    binary: 'actionlint',
    owner: 'rhysd',
    repository: 'actionlint',
    tagPrefix: 'v',
    versionPattern: DOTTED_TRIPLE,
    assets: {
      'linux-x64': 'actionlint_{version}_linux_amd64.tar.gz',
      'macos-arm64': 'actionlint_{version}_darwin_arm64.tar.gz',
      'windows-x64': 'actionlint_{version}_windows_amd64.zip',
    },
    versionFlag: '-version',
    attested: true,
  },
  {
    key: 'shellcheck',
    binary: 'shellcheck',
    owner: 'koalaman',
    repository: 'shellcheck',
    tagPrefix: 'v',
    versionPattern: DOTTED_TRIPLE,
    assets: {
      'linux-x64': 'shellcheck-v{version}.linux.x86_64.tar.xz',
      'macos-arm64': 'shellcheck-v{version}.darwin.aarch64.tar.xz',
      'windows-x64': 'shellcheck-v{version}.zip',
    },
    versionFlag: '--version',
    attested: false,
  },
  {
    key: 'taplo',
    binary: 'taplo',
    owner: 'tamasfe',
    repository: 'taplo',
    tagPrefix: '',
    versionPattern: DOTTED_TRIPLE,
    assets: {
      'linux-x64': 'taplo-linux-x86_64.gz',
      'macos-arm64': 'taplo-darwin-aarch64.gz',
      'windows-x64': 'taplo-windows-x86_64.zip',
    },
    versionFlag: '--version',
    attested: false,
  },
  {
    key: 'zizmor',
    binary: 'zizmor',
    owner: 'zizmorcore',
    repository: 'zizmor',
    tagPrefix: 'v',
    versionPattern: DOTTED_TRIPLE,
    assets: {
      'linux-x64': 'zizmor-x86_64-unknown-linux-gnu.tar.gz',
      'macos-arm64': 'zizmor-aarch64-apple-darwin.tar.gz',
      'windows-x64': 'zizmor-x86_64-pc-windows-msvc.zip',
    },
    versionFlag: '--version',
    attested: true,
  },
];

/* ///// The two files, as parsed ///// */

const PlatformSchema = z.object({
  checksum: z.string().optional(),
  url: z.string().optional(),
  url_api: z.string().optional(),
  provenance: z.string().optional(),
});

/**
 * Whether mise reads `name`, an entry in the repository root, as a config
 * file, a config directory or a lockfile, other than {@link PINS} and
 * {@link LOCK}.
 *
 * @remarks
 * The names are mise's own discovery list, compared through {@link fold}
 * because Windows and macOS open a file under another spelling: `.tool-versions`,
 * `.miserc.toml`, the `mise` and `.mise` directories, and every
 * `[.]mise[.<name>].toml` or `.lock` beside the two pinned files, which
 * covers the local and the per-environment files.
 */
function isOtherMiseFile(name: string): boolean {
  const folded = fold(name);
  if (folded === PINS || folded === LOCK) {
    return false;
  }
  return (
    folded === '.tool-versions' ||
    folded === '.miserc.toml' ||
    folded === 'mise' ||
    folded === '.mise' ||
    /^\.?mise(\..+)?\.(toml|lock)$/.test(folded)
  );
}

/** Every symbolic link or junction under `path`, which is a directory the walk entered, as paths from the root. */
async function linksUnder(path: string): Promise<string[]> {
  const links: string[] = [];
  for (const entry of await directoryEntries(path)) {
    const inner = `${path}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      links.push(inner);
    } else if (entry.isDirectory()) {
      links.push(...(await linksUnder(inner)));
    }
  }
  return links;
}

/**
 * Every file in the repository root the gate refuses to run beside, as
 * findings: a mise config or lock file other than {@link PINS} and
 * {@link LOCK}, and a symbolic link or junction at the root or under the
 * directories mise reads.
 *
 * @remarks
 * mise merges every config file it discovers, and each one's sibling
 * lockfile, highest precedence first, so a committed `mise.local.toml` with a
 * `mise.local.lock` of its own sends `mise install --locked` to whatever url
 * that lockfile records while {@link LOCK} stays untouched. mise discovers
 * config from the working directory upward, so the root and its `.config`
 * directory are every place a file in the tree can reach it. mise follows a
 * link to whatever it names, where a name scan never looks, so the root and
 * the `.config`, `.mise` and `mise` directories hold none.
 */
async function rootFindings(): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir('.', { withFileTypes: true })) {
    const name = entry.name;
    const folded = fold(name);
    if (entry.isSymbolicLink()) {
      found.push(`${quote(name)} is a link, and mise follows a link where a name scan never looks`);
    } else if (folded === '.config' || folded === '.mise' || folded === 'mise') {
      for (const link of await linksUnder(name)) {
        found.push(`${quote(link)} is a link, and mise follows a link where a name scan never looks`);
      }
    }
    if (isOtherMiseFile(name)) {
      found.push(`mise reads ${quote(name)} beside ${PINS} and ${LOCK}, and the gate installs from those two alone`);
    }
    if (folded === '.config') {
      for (const inner of await directoryEntries(name)) {
        if (fold(inner.name).startsWith('mise')) {
          found.push(
            `mise reads ${quote(`${name}/${inner.name}`)} beside ${PINS} and ${LOCK}, and the gate installs from those two alone`,
          );
        }
      }
    }
  }
  if (found.length > 0) {
    found.push('Remove each file and link named above.');
  }
  return found;
}

/** Whether `text` is `prefix` followed by one or more ASCII digits. */
function isAssetReference(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) {
    return false;
  }
  const id = text.slice(prefix.length);
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    // '0' is 48 and '9' is 57.
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return id.length > 0;
}

/**
 * The version a tool's value in {@link PINS} or a {@link LOCK} entry's
 * `options` names, or the findings against it.
 *
 * @remarks
 * A tool's value is its version, or a table of `version` and a
 * `version_prefix` equal to the tag prefix. mise reads further keys on such a
 * table, a postinstall command among them, so no other key passes.
 *
 * @param where - The file and table the value sits in, for the findings
 */
function toolVersion(tool: Tool, value: unknown, where: string): { version?: string; found: string[] } {
  if (typeof value === 'string') {
    return { version: value, found: [] };
  }
  if (!isTable(value)) {
    return { found: [`${where} for ${tool.key} is ${quoteValue(value)}, and it is a version or a table`] };
  }
  const found: string[] = [];
  for (const key of Object.keys(value)) {
    if (!TOOL_OPTION_KEYS.includes(key)) {
      found.push(`${where} for ${tool.key} carries ${quote(key)}, and it carries version and version_prefix alone`);
    }
  }
  const prefix = value['version_prefix'];
  if (prefix !== undefined && prefix !== tool.tagPrefix) {
    found.push(
      `${where} for ${tool.key} carries version_prefix ${quoteValue(prefix)}, and ${tool.key}'s tags carry ${JSON.stringify(tool.tagPrefix)}`,
    );
  }
  const version = value['version'];
  if (typeof version !== 'string') {
    found.push(`${where} for ${tool.key} carries version ${quoteValue(version)}, and it is a string`);
    return { found };
  }
  return { version, found };
}

/**
 * What one platform entry must say, or the findings against it.
 *
 * @param asset - The artifact's file name for this platform, from {@link TOOLS}
 */
function findingsForPlatform(tool: Tool, version: string, platform: string, asset: string, entry: unknown): string[] {
  const label = `${tool.key} ${platform}`;
  if (!isTable(entry)) {
    return [`${label} is not a platform table in ${LOCK}`];
  }
  const found: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!PLATFORM_KEYS.includes(key)) {
      found.push(`${label} carries ${quote(key)} in ${LOCK}, and a platform table carries ${PLATFORM_KEYS.join(', ')}`);
    }
  }
  const parsed = PlatformSchema.safeParse(entry);
  if (!parsed.success) {
    return [...found, `${label} holds a value that is not a string in ${LOCK}`];
  }
  const { checksum, url, url_api: urlApi, provenance } = parsed.data;

  if (checksum === undefined) {
    found.push(`${label} carries no checksum in ${LOCK}`);
  } else if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
    found.push(`${label} carries checksum ${quote(checksum)}, and a sha256 digest is 64 hex digits`);
  }

  // Equality, byte for byte, with the address built from the constants: no
  // parser reads the recorded text, so none can resolve it somewhere mise
  // does not, and a path GitHub answers with 404 cannot trigger the url_api
  // fallback.
  const artifact = `${RELEASE_ROOT}${tool.owner}/${tool.repository}/releases/download/${tool.tagPrefix}${version}/${asset.replaceAll('{version}', version)}`;
  if (url === undefined) {
    found.push(`${label} carries no url in ${LOCK}`);
  } else if (url !== artifact) {
    found.push(`${label} url is ${quote(url)}, and the release artifact is ${artifact}`);
  }

  // GitHub answers an asset id under another repository's path with 404, so
  // the prefix binds the repository. Nothing offline binds the id to the
  // version, so the install's URL_REPLACEMENTS stops mise reading it at all.
  const apiPrefix = `${API_ROOT}${tool.owner}/${tool.repository}/releases/assets/`;
  if (urlApi === undefined) {
    found.push(`${label} carries no url_api in ${LOCK}`);
  } else if (!isAssetReference(urlApi, apiPrefix)) {
    found.push(`${label} url_api is ${quote(urlApi)}, and a release asset reference is ${apiPrefix}<id>`);
  }

  if (tool.attested && provenance !== ATTESTED) {
    found.push(
      `${label} records provenance ${provenance === undefined ? 'none' : quote(provenance)}, and ${tool.owner}/${tool.repository} attests its releases, so ${LOCK} must record ${ATTESTED}`,
    );
  }
  return found;
}

/* ///// mise.toml and mise.lock ///// */

/**
 * The version {@link PINS} pins for every tool, and the findings against the
 * file: a table beyond [tools], [tool_config] and [settings], either of the
 * last two differing from its constant, and a tool entry that is not a
 * version.
 */
function pinsFindings(pins: unknown): { versions: Map<string, string>; found: string[] } {
  const versions = new Map<string, string>();
  if (!isTable(pins)) {
    return { versions, found: [`${PINS} is not a table`] };
  }
  const found: string[] = [];
  for (const key of Object.keys(pins)) {
    if (!PIN_SECTIONS.includes(key)) {
      found.push(
        `${PINS} carries ${quote(key)}, and it holds [tools], [tool_config] and [settings] alone. mise runs a table such as [hooks], [env] or [vars] on install`,
      );
    }
  }
  if (!sameValue(pins['tool_config'], EXPECTED_TOOL_CONFIG)) {
    found.push(
      `${PINS} [tool_config] is ${quoteValue(pins['tool_config'])}, and it must be exactly ${JSON.stringify(EXPECTED_TOOL_CONFIG)}`,
    );
  }
  if (!sameValue(pins['settings'], EXPECTED_SETTINGS)) {
    found.push(
      `${PINS} [settings] is ${quoteValue(pins['settings'])}, and it must be exactly ${JSON.stringify(EXPECTED_SETTINGS)}, the settings scripts/tools.ts holds`,
    );
  }
  const tools = pins['tools'];
  if (!isTable(tools)) {
    return { versions, found: [...found, `${PINS} carries no [tools] table`] };
  }
  for (const key of Object.keys(tools)) {
    if (!TOOLS.some((tool) => tool.key === key)) {
      found.push(`${PINS} pins ${quote(key)}, and scripts/tools.ts holds no expectation for it`);
    }
  }
  for (const tool of TOOLS) {
    if (!Object.hasOwn(tools, tool.key)) {
      found.push(`scripts/tools.ts expects ${tool.key}, and ${PINS} does not pin it`);
      continue;
    }
    const pinned = toolVersion(tool, tools[tool.key], `${PINS} [tools]`);
    found.push(...pinned.found);
    if (pinned.version !== undefined) {
      versions.set(tool.key, pinned.version);
    }
  }
  return { versions, found };
}

/**
 * Reads the repository root, {@link PINS} and {@link LOCK} and returns every
 * file the root must not hold and every way the two files disagree with
 * {@link TOOLS}, {@link EXPECTED_TOOL_CONFIG} and {@link EXPECTED_SETTINGS},
 * or an empty list.
 *
 * @remarks
 * Nothing here starts a process, so a lockfile left behind by a bump is
 * reported by name on a machine with no mise at all. Every key of both files
 * is allow-listed, at every level of the lockfile, so a key mise reads and
 * this file does not name is a finding rather than a silent pass.
 */
export async function lockfileFindings(): Promise<string[]> {
  const found = await rootFindings();
  for (const file of [PINS, LOCK]) {
    if (!(await Bun.file(file).exists())) {
      found.push(`${file} is missing from the root, and the gate installs from it`);
    }
  }
  if (found.some((finding) => finding.endsWith('the gate installs from it'))) {
    return found;
  }
  const pins = pinsFindings(Bun.TOML.parse(await Bun.file(PINS).text()));
  found.push(...pins.found);
  const lock: unknown = Bun.TOML.parse(await Bun.file(LOCK).text());
  if (!isTable(lock)) {
    return [...found, `${LOCK} is not a table`];
  }
  for (const key of Object.keys(lock)) {
    if (key !== 'lockfile_version' && key !== 'tools') {
      found.push(`${LOCK} carries ${quote(key)}, and it carries lockfile_version and tools alone`);
    }
  }
  if (lock['lockfile_version'] !== LOCKFILE_VERSION) {
    found.push(
      `${LOCK} records lockfile_version ${quoteValue(lock['lockfile_version'])}, and scripts/tools.ts reads version ${String(LOCKFILE_VERSION)}`,
    );
  }
  const tools = lock['tools'];
  if (!isTable(tools)) {
    return [...found, `${LOCK} carries no tools table. Write it again with: ${RELOCK}`];
  }
  for (const key of Object.keys(tools)) {
    if (!TOOLS.some((tool) => tool.key === key)) {
      found.push(`${LOCK} records ${quote(key)}, and scripts/tools.ts holds no expectation for it`);
    }
  }

  for (const tool of TOOLS) {
    for (const platform of Object.keys(tool.assets)) {
      if (!LOCKFILE_PLATFORMS.includes(platform)) {
        found.push(
          `scripts/tools.ts names a ${platform} asset for ${tool.key}, and LOCKFILE_PLATFORMS does not name it`,
        );
      }
    }
    const version = pins.versions.get(tool.key);
    if (version === undefined) {
      continue;
    }
    // The pin is substituted into every url built below, so a slash, a dot
    // segment or a query in it walks the address out of the release while
    // the lockfile's url still equals it byte for byte. No url is built from a
    // version outside the tool's form.
    const pinFits = tool.versionPattern.test(version);
    if (!pinFits) {
      found.push(
        `${PINS} pins ${tool.key} ${quote(version)}, outside the form ${tool.key} releases take: ${tool.versionPattern.source}`,
      );
    }
    const entries = tools[tool.key];
    if (!Array.isArray(entries) || entries.length !== 1) {
      found.push(
        `${LOCK} records ${Array.isArray(entries) ? String(entries.length) : 'no'} entries for ${tool.key}, and one is expected. Write it again with: ${RELOCK}`,
      );
      continue;
    }
    const entry: unknown = entries[0];
    if (!isTable(entry)) {
      found.push(`${LOCK} records an entry for ${tool.key} that is not a table`);
      continue;
    }
    // mise reads a nested [tools.<key>.platforms.<name>] table too, which
    // parses to a plain `platforms` key. mise lock writes the quoted spelling
    // alone, so the nested one is refused whole.
    for (const key of Object.keys(entry)) {
      if (key === 'platforms') {
        found.push(
          `${LOCK} records a nested platforms table for ${tool.key}, and mise lock writes the quoted "platforms.<name>" spelling. Write it again with: ${RELOCK}`,
        );
      } else if (!ENTRY_KEYS.includes(key) && !key.startsWith('platforms.')) {
        found.push(
          `${LOCK} records ${quote(key)} for ${tool.key}, and an entry carries ${ENTRY_KEYS.join(', ')} and its platforms`,
        );
      }
    }
    const recordedVersion = entry['version'];
    if (typeof recordedVersion !== 'string' || !tool.versionPattern.test(recordedVersion)) {
      found.push(
        `${LOCK} records ${tool.key} ${quoteValue(recordedVersion)}, outside the form ${tool.key} releases take: ${tool.versionPattern.source}`,
      );
    }
    if (recordedVersion !== version) {
      found.push(
        `${PINS} pins ${tool.key} ${quote(version)}, and ${LOCK} records ${quoteValue(recordedVersion)}. Write it again with: ${RELOCK}`,
      );
    }
    const coordinate = `aqua:${tool.owner}/${tool.repository}`;
    if (entry['backend'] !== coordinate) {
      found.push(
        `${LOCK} records backend ${quoteValue(entry['backend'])} for ${tool.key}, and the tool comes from ${coordinate}`,
      );
    }
    if (Object.hasOwn(entry, 'specifiers') && !sameValue(entry['specifiers'], [version])) {
      found.push(
        `${LOCK} records specifiers ${quoteValue(entry['specifiers'])} for ${tool.key}, and ${PINS} asks for ${JSON.stringify([version])}`,
      );
    }
    if (Object.hasOwn(entry, 'options')) {
      const options = toolVersion(tool, entry['options'], `${LOCK} options`);
      found.push(...options.found);
      if (options.version !== undefined && options.version !== version) {
        found.push(
          `${LOCK} options for ${tool.key} carry version ${quote(options.version)}, and ${PINS} pins ${quote(version)}`,
        );
      }
    }
    // Every platform table the entry carries is asserted, not only the ones
    // LOCKFILE_PLATFORMS names. A table for another platform is what a
    // contributor on that platform installs from under --locked, and one the
    // file does not name is refused rather than read past.
    const recorded = Object.keys(entry)
      .filter((key) => key.startsWith('platforms.'))
      .map((key) => key.slice('platforms.'.length));
    for (const platform of LOCKFILE_PLATFORMS) {
      if (!recorded.includes(platform)) {
        found.push(`${LOCK} records no ${quote(platform)} entry for ${tool.key}. Write it again with: ${RELOCK}`);
      }
    }
    for (const platform of recorded) {
      if (!LOCKFILE_PLATFORMS.includes(platform)) {
        found.push(
          `${LOCK} records a ${quote(platform)} entry for ${tool.key}, and LOCKFILE_PLATFORMS in scripts/tools.ts does not name it`,
        );
        continue;
      }
      const asset = Object.hasOwn(tool.assets, platform) ? tool.assets[platform] : undefined;
      if (asset === undefined) {
        found.push(
          `scripts/tools.ts names no ${quote(platform)} asset for ${tool.key}, and ${LOCK} records that platform`,
        );
        continue;
      }
      if (pinFits) {
        found.push(...findingsForPlatform(tool, version, platform, asset, entry[`platforms.${platform}`]));
      }
    }
  }
  return found;
}

/* ///// The install and the binaries ///// */

/**
 * Runs one mise command, after {@link lockfileFindings} comes back empty, in
 * {@link miseEnvironment} and nothing else.
 *
 * @remarks
 * This is the one place the gate starts mise. mise evaluates a config's
 * `[env]` and `[vars]` templates whenever it loads the file, `mise which`
 * included, so every command asserts the two files first, and a single row
 * run that skips the tools row never reaches mise over an unchecked file.
 *
 * @throws When {@link lockfileFindings} reports anything, with the findings
 */
async function mise(args: readonly string[]): Promise<Finished> {
  const found = await lockfileFindings();
  if (found.length > 0) {
    throw new Error(found.join('\n'));
  }
  return run(['mise', ...args], miseEnvironment(), { inherit: false });
}

/**
 * Installs every pinned tool from the lockfile, which is a no-op once they are
 * present.
 *
 * @remarks
 * `--locked` refuses an entry with no url for this platform rather than
 * resolving one. The install is handed no token: a locked install of a tool
 * mise's registry routes, as every tool in {@link TOOLS} is, makes no
 * api.github.com request and reads attestation bundles from
 * mise-versions.jdx.dev. A `github:` tool reads its attestation from the API.
 *
 * @throws When the files fail their assertions or the install fails
 */
export async function install(): Promise<void> {
  const finished = await mise(['install', '--locked']);
  if (finished.exitCode !== 0) {
    throw new Error(`mise install --locked ${describe(finished)}`);
  }
}

/**
 * The path of every pinned binary, resolved through `mise which` and checked
 * against the pinned version.
 *
 * @returns The binary path per {@link PINS} key
 * @throws When the files fail their assertions, or a binary is missing or
 * reports a version other than the pin
 */
export async function resolve(): Promise<ReadonlyMap<string, string>> {
  const pins = pinsFindings(Bun.TOML.parse(await Bun.file(PINS).text()));
  const resolved = new Map<string, string>();
  for (const tool of TOOLS) {
    const version = pins.versions.get(tool.key);
    if (version === undefined) {
      throw new Error(`${PINS} pins no version of ${tool.key}`);
    }
    const located = await mise(['which', tool.binary]);
    const path = plain(located.stdout).trim();
    if (located.exitCode !== 0) {
      throw new Error(`mise which ${tool.binary} ${describe(located)}`);
    }
    if (path.length === 0) {
      throw new Error(`mise which ${tool.binary} found nothing. Install it with: mise install`);
    }
    const printed = await run([path, tool.versionFlag]);
    if (printed.exitCode !== 0) {
      throw new Error(`${path} ${tool.versionFlag} ${describe(printed)}`);
    }
    const reported = /\d+\.\d+\.\d+/.exec(plain(`${printed.stdout}\n${printed.stderr}`))?.[0] ?? '';
    if (reported !== version) {
      throw new Error(
        `${path} reports ${tool.key} ${reported}, and ${PINS} pins ${quote(version)}. Install it with: mise install`,
      );
    }
    resolved.set(tool.key, path);
  }
  return resolved;
}
