/**
 * The GitHub tokens the gate's tools could read: taken out of every row's
 * environment, with gh's own answer kept for zizmor alone.
 *
 * @remarks
 * gh, zizmor and mise each read a GitHub token from the environment, and a
 * row's processes inherit the gate's. Every name they read is therefore taken
 * out of the gate's environment when this module loads, before any row starts
 * a process. gh's own two are kept aside for `gh auth token` alone, so gh
 * answers as it would from the contributor's shell, and the gate hands that
 * answer to zizmor alone. A locked mise install makes no api.github.com
 * request, so no row has a use for mise's. CI's gate step carries none of
 * them, so there zizmor runs offline. This module imports run.ts alone, so it
 * loads before the gate's preflight like every module check.ts imports.
 */

import { run } from './run';

/** Every name gh, zizmor and mise read a GitHub token from. */
export const TOKEN_NAMES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'ZIZMOR_GITHUB_TOKEN',
  'MISE_GITHUB_TOKEN',
  'MISE_GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_API_TOKEN',
];

/** The deadline for `gh auth token`, past which the gate reads gh as holding no token. */
export const GH_TIMEOUT_MS = 5_000;

/**
 * Takes every {@link TOKEN_NAMES} name out of `environment`, in every spelling,
 * and returns gh's own two as `environment` held them.
 *
 * @remarks
 * Windows reads a name without regard to case, so a second spelling of a
 * name would reach a tool as that name. Every spelling goes, on every
 * platform, so the rule reads the same wherever the gate runs.
 */
export function takeTokens(
  environment: Record<string, string | undefined>,
): Readonly<Record<string, string | undefined>> {
  const kept = { GH_TOKEN: environment['GH_TOKEN'], GITHUB_TOKEN: environment['GITHUB_TOKEN'] };
  for (const name of Object.keys(environment)) {
    if (TOKEN_NAMES.includes(name.toUpperCase())) {
      Reflect.deleteProperty(environment, name);
    }
  }
  return kept;
}

/** gh's own two names, as the gate's environment held them when this module loaded. */
export const GH_ENVIRONMENT: Readonly<Record<string, string | undefined>> = takeTokens(process.env);

/**
 * The token `gh auth token` answers with, for zizmor's online audits, or none.
 * A gh that is missing, fails, prints nothing or outlives `timeoutMs` reads as
 * no token.
 *
 * @remarks
 * No token means zizmor runs offline, so a gh that hangs waiting on its
 * keyring costs the row its online audits and nothing else. Bun kills gh at
 * the deadline, and a killed gh exits non-zero.
 *
 * @param gh - The gh to ask, found as run() finds any program. The gate passes
 * `gh`. A test passes the path of a stand-in, so it can never reach a real gh
 * @param environment - gh's own token names, handed to gh alone
 * @param timeoutMs - How long gh may take to answer
 */
export async function githubToken(
  gh: string,
  environment: Readonly<Record<string, string | undefined>> = GH_ENVIRONMENT,
  timeoutMs: number = GH_TIMEOUT_MS,
): Promise<string | undefined> {
  const printed = await run([gh, 'auth', 'token'], environment, { timeoutMs });
  const found = printed.stdout.trim();
  return printed.exitCode === 0 && found.length > 0 ? found : undefined;
}
