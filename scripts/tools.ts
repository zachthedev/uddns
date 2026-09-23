/**
 * The tools mise installs for the gate: what mise.toml and mise.lock must say
 * about each one, checked before anything installs from them.
 *
 * @remarks
 * In locked mode mise fetches the url a lockfile entry records and compares
 * the checksum it records. mise refuses a version the lockfile does not name
 * and a platform it does not cover, and accepts an entry with no checksum, a
 * rewritten backend or a swapped url host. Those three sit in a generated
 * file that a bump rewrites wholesale, so the owner, host and provenance each
 * tool is expected to come from live here, in source, and the lockfile is
 * held to them. A rewrite of the lockfile then disagrees with a file a
 * reviewer reads.
 */

import { describe, run } from './run';

/** The file pinning a version for every tool mise installs. */
export const PINS = 'mise.toml';

/** The file holding a checksum, a url and a backend per platform for every pinned tool. */
export const LOCK = 'mise.lock';

/** The command that rewrites {@link LOCK} after an edit to {@link PINS}. */
const RELOCK = 'mise lock';

/** The host every release artifact {@link LOCK} records is served from. */
const RELEASE_HOST = 'github.com';

/** The host every release api reference {@link LOCK} records is served from. */
const API_HOST = 'api.github.com';

/** The provenance {@link LOCK} records for a release carrying an attestation. */
const ATTESTED = 'github-attestations';

/** The deadline for one mise command that reads or resolves. */
const READ_TIMEOUT_MS = 60_000;

/** The deadline for the install, which downloads every tool on a fresh machine. */
const INSTALL_TIMEOUT_MS = 600_000;

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
 * place an aqua tool's account is written outside the generated file. An
 * artifact that moves to another account takes an edit here, in the same diff
 * as the lockfile it explains.
 */
export const TOOLS: readonly Tool[] = [
  {
    key: 'actionlint',
    binary: 'actionlint',
    owner: 'rhysd',
    repository: 'actionlint',
    tagPrefix: 'v',
    versionFlag: '-version',
    attested: true,
  },
  {
    key: 'shellcheck',
    binary: 'shellcheck',
    owner: 'koalaman',
    repository: 'shellcheck',
    tagPrefix: 'v',
    versionFlag: '--version',
    attested: false,
  },
  {
    key: 'taplo',
    binary: 'taplo',
    owner: 'tamasfe',
    repository: 'taplo',
    tagPrefix: '',
    versionFlag: '--version',
    attested: false,
  },
  {
    key: 'zizmor',
    binary: 'zizmor',
    owner: 'zizmorcore',
    repository: 'zizmor',
    tagPrefix: 'v',
    versionFlag: '--version',
    attested: true,
  },
];

/* ///// The two files, as parsed ///// */

/** A TOML table, as `Bun.TOML.parse` returns one. */
type Table = Readonly<Record<string, unknown>>;

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** What {@link PINS} must carry, or the reason it does not. */
interface Pins {
  readonly tools: Readonly<Record<string, string>>;
  readonly platforms: readonly string[];
}

async function readPins(): Promise<{ ok: true; value: Pins } | { ok: false; reason: string }> {
  const parsed: unknown = Bun.TOML.parse(await Bun.file(PINS).text());
  const need = `${PINS} must carry [tools] and [settings] lockfile_platforms`;
  if (!isTable(parsed) || !isTable(parsed['tools']) || !isTable(parsed['settings'])) {
    return { ok: false, reason: need };
  }
  const tools: Record<string, string> = {};
  for (const [key, version] of Object.entries(parsed['tools'])) {
    if (typeof version !== 'string') {
      return { ok: false, reason: `${PINS} pins ${key} to something other than a version string` };
    }
    tools[key] = version;
  }
  const platforms: unknown = parsed['settings']['lockfile_platforms'];
  if (!isStringArray(platforms) || platforms.length === 0) {
    return { ok: false, reason: need };
  }
  return { ok: true, value: { tools, platforms } };
}

/** One address {@link LOCK} records, split into the parts a rule reads. */
interface Address {
  readonly host: string;
  readonly path: string;
}

/**
 * `text` as a plain https url, or the reason it is not.
 *
 * @remarks
 * A url parser normalizes what a text match would read literally, so the rules
 * read the parsed host and path and refuse anything a release url never
 * carries: credentials, a port, a query, a fragment, or a percent escape in
 * the path, which is where a traversal hides.
 */
function address(text: string): { ok: true; value: Address } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: 'is not a url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'is not https' };
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return { ok: false, reason: 'carries credentials or a port' };
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, reason: 'carries a query or a fragment' };
  }
  if (parsed.pathname.includes('%')) {
    return { ok: false, reason: 'carries a percent escape in its path' };
  }
  return { ok: true, value: { host: parsed.hostname, path: parsed.pathname } };
}

/** The string at `key` in `table`, or undefined when absent or not a string. */
function text(table: Table, key: string): string | undefined {
  const value: unknown = table[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * What one platform entry must say, or the findings against it.
 */
function findingsForPlatform(tool: Tool, version: string, platform: string, entry: unknown): string[] {
  const label = `${tool.key} ${platform}`;
  if (!isTable(entry)) {
    return [`${label} is not a platform table in ${LOCK}`];
  }
  const found: string[] = [];
  const checksum = text(entry, 'checksum');
  const url = text(entry, 'url');
  const urlApi = text(entry, 'url_api');
  const provenance = text(entry, 'provenance');

  if (checksum === undefined) {
    found.push(`${label} carries no checksum in ${LOCK}`);
  } else if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
    found.push(`${label} carries checksum ${checksum}, and a sha256 digest is 64 hex digits`);
  }

  const releasePrefix = `/${tool.owner}/${tool.repository}/releases/download/${tool.tagPrefix}${version}/`;
  if (url === undefined) {
    found.push(`${label} carries no url in ${LOCK}`);
  } else {
    const release = address(url);
    if (!release.ok) {
      found.push(`${label} url ${release.reason}: ${url}`);
    } else if (release.value.host !== RELEASE_HOST) {
      found.push(`${label} url host is ${release.value.host}, and every artifact comes from ${RELEASE_HOST}`);
    } else if (!release.value.path.startsWith(releasePrefix)) {
      found.push(`${label} url path is ${release.value.path}, and this release sits under ${releasePrefix}`);
    }
  }

  const apiPrefix = `/repos/${tool.owner}/${tool.repository}/releases/`;
  if (urlApi === undefined) {
    found.push(`${label} carries no url_api in ${LOCK}`);
  } else {
    const api = address(urlApi);
    if (!api.ok) {
      found.push(`${label} url_api ${api.reason}: ${urlApi}`);
    } else if (api.value.host !== API_HOST) {
      found.push(`${label} url_api host is ${api.value.host}, and every release api reference is ${API_HOST}`);
    } else if (!api.value.path.startsWith(apiPrefix)) {
      found.push(`${label} url_api path is ${api.value.path}, and this repository's releases sit under ${apiPrefix}`);
    }
  }

  if (tool.attested && provenance !== ATTESTED) {
    found.push(
      `${label} records provenance ${provenance ?? 'none'}, and ${tool.owner}/${tool.repository} attests its releases, so ${LOCK} must record ${ATTESTED}`,
    );
  }
  return found;
}

/**
 * Reads {@link PINS} and {@link LOCK} and returns every way they disagree with
 * {@link TOOLS}, or an empty list.
 *
 * @remarks
 * Nothing here starts a process, so a lockfile left behind by a bump is
 * reported by name on a machine with no mise at all.
 */
export async function lockfileFindings(): Promise<string[]> {
  const pins = await readPins();
  if (!pins.ok) {
    return [pins.reason];
  }
  const lock: unknown = Bun.TOML.parse(await Bun.file(LOCK).text());
  if (!isTable(lock) || !isTable(lock['tools'])) {
    return [`${LOCK} is not a lockfile: it carries no [tools] table`];
  }
  const locked: Table = lock['tools'];

  const found: string[] = [];
  const pinned = Object.keys(pins.value.tools).sort();
  const expected = TOOLS.map((tool) => tool.key).sort();
  for (const key of pinned) {
    if (!expected.includes(key)) {
      found.push(`${PINS} pins ${key}, and scripts/tools.ts holds no expectation for it`);
    }
  }
  for (const key of expected) {
    if (!pinned.includes(key)) {
      found.push(`scripts/tools.ts expects ${key}, and ${PINS} does not pin it`);
    }
  }

  for (const tool of TOOLS) {
    const version = pins.value.tools[tool.key];
    if (version === undefined) {
      continue;
    }
    const entries: unknown = locked[tool.key];
    if (!Array.isArray(entries) || entries.length !== 1 || !isTable(entries[0])) {
      const count = Array.isArray(entries) ? entries.length : 0;
      found.push(
        `${LOCK} records ${String(count)} entries for ${tool.key}, and one is expected. Write it again with: ${RELOCK}`,
      );
      continue;
    }
    const entry: Table = entries[0];
    if (entry['version'] !== version) {
      found.push(
        `${PINS} pins ${tool.key} ${version}, and ${LOCK} records ${String(entry['version'])}. Write it again with: ${RELOCK}`,
      );
    }
    const coordinate = `aqua:${tool.owner}/${tool.repository}`;
    if (entry['backend'] !== coordinate) {
      found.push(
        `${LOCK} records backend ${String(entry['backend'])} for ${tool.key}, and the tool comes from ${coordinate}`,
      );
    }
    // Every platform table the entry carries is asserted, not only the ones
    // lockfile_platforms names. A table for another platform is what a
    // contributor on that platform installs from under --locked, and one the
    // file does not name is refused rather than read past.
    const recorded = Object.keys(entry)
      .filter((key) => key.startsWith('platforms.'))
      .map((key) => key.slice('platforms.'.length));
    // mise reads a nested [tools.<key>.platforms.<name>] table too, which
    // parses to a plain `platforms` key the filter above never sees. mise lock
    // writes the quoted spelling alone, so the nested one is refused whole.
    if ('platforms' in entry) {
      found.push(
        `${LOCK} records a nested platforms table for ${tool.key}, and mise lock writes the quoted "platforms.<name>" spelling. Write it again with: ${RELOCK}`,
      );
    }
    for (const platform of pins.value.platforms) {
      if (!recorded.includes(platform)) {
        found.push(`${LOCK} records no ${platform} entry for ${tool.key}. Write it again with: ${RELOCK}`);
      }
    }
    for (const platform of recorded) {
      if (!pins.value.platforms.includes(platform)) {
        found.push(
          `${LOCK} records a ${platform} entry for ${tool.key}, and lockfile_platforms in ${PINS} does not name it`,
        );
        continue;
      }
      found.push(...findingsForPlatform(tool, version, platform, entry[`platforms.${platform}`]));
    }
  }
  return found;
}

/* ///// The install and the binaries ///// */

/**
 * Installs every pinned tool from the lockfile, which is a no-op once they are
 * present.
 *
 * @remarks
 * This runs only after {@link lockfileFindings} came back empty, held by the
 * row order in scripts/check.ts. `--locked` refuses an entry with no url for
 * this platform rather than resolving one.
 */
export function install(): void {
  const finished = run(['mise', 'install', '--locked'], INSTALL_TIMEOUT_MS);
  if (finished.exitCode !== 0) {
    throw new Error(`mise install --locked ${describe(finished)}`);
  }
}

/**
 * The path of every pinned binary, resolved through `mise which` and checked
 * against the pinned version.
 *
 * @returns The binary path per {@link PINS} key
 * @throws When a binary is missing or reports a version other than the pin
 */
export async function resolve(): Promise<ReadonlyMap<string, string>> {
  const pins = await readPins();
  if (!pins.ok) {
    throw new Error(pins.reason);
  }
  const resolved = new Map<string, string>();
  for (const tool of TOOLS) {
    const version = pins.value.tools[tool.key];
    if (version === undefined) {
      throw new Error(`${PINS} does not pin ${tool.key}`);
    }
    const located = run(['mise', 'which', tool.binary], READ_TIMEOUT_MS);
    const path = located.stdout.trim();
    if (located.exitCode !== 0 || path.length === 0) {
      throw new Error(`mise which ${tool.binary} found nothing. Install it with: mise install`);
    }
    const printed = run([path, tool.versionFlag], READ_TIMEOUT_MS);
    const reported = /\d+\.\d+\.\d+/.exec(`${printed.stdout}\n${printed.stderr}`)?.[0] ?? '';
    if (printed.exitCode !== 0 || reported !== version) {
      throw new Error(
        `${path} reports ${tool.key} ${reported}, and ${PINS} pins ${version}. Install it with: mise install`,
      );
    }
    resolved.set(tool.key, path);
  }
  return resolved;
}
