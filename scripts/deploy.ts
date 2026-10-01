import { jsTool } from './run';

/**
 * Single deploy path for local machines and CI.
 *
 * Applies the D1 migrations, deploys, and syncs the optional ACCESS_KEY
 * worker secret when the environment carries one. wrangler reads the
 * committed wrangler.jsonc directly: the KV and D1 bindings carry no IDs, so
 * it reuses the resources the deployed Worker holds under those binding names
 * and creates them where no such Worker exists.
 *
 * Migrations run first so new code never meets an old schema. `migrations
 * apply` resolves the database by name and creates nothing, so an account
 * with no database yet runs `wrangler d1 create d1-uddns-audit-prod` once
 * before its first deploy.
 *
 * CUSTOM_DOMAIN is per deployment and never committed. Set, it is attached as
 * a custom domain; unset, the Worker keeps its workers.dev URL.
 */

/** A DNS hostname of two or more labels, which is the only shape `--domain` takes. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Checked before the first wrangler call so a bad value deploys nothing:
// wrangler's parser takes a value such as `--help` as a flag and exits 0, which
// would turn the deploy into a help print that reads as a success.
const customDomain = process.env['CUSTOM_DOMAIN'];
const hasCustomDomain = customDomain !== undefined && customDomain !== '';
if (hasCustomDomain && !HOSTNAME.test(customDomain)) {
  console.error(`CUSTOM_DOMAIN is not a hostname: ${JSON.stringify(customDomain)}`);
  process.exit(1);
}

// Every wrangler start takes --no-install, so bunx never fetches whatever
// wrangler the registry serves and runs it with the account's credentials.
// Without the checkout's install, bunx still runs a copy from a parent
// directory, PATH or its own cache, none of them the version bun.lock pins, so
// the deploy refuses first unless node_modules/.bin holds wrangler as a
// regular file. jsTool is the gate's check and message. Its command carries
// --bun, which these starts do not take, so only the check is used. Deviates
// from the handbook: no start takes --bun, so wrangler runs under the first
// node on PATH, as the dev and start scripts run it. The deploy job in cd.yml
// installs the version .node-version names ahead of the runner's own. wrangler
// deploy under Bun is unmeasured, and only a deploy measures it.
try {
  jsTool('wrangler');
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

/**
 * This process's environment without ACCESS_KEY, in any case of its name.
 * Every start is handed it, so the key stays out of the environment each
 * start is handed, and secret put reads the key on stdin. A local deploy's
 * wrangler also reads .env.local itself, which holds the key.
 */
const startEnv: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ACCESS_KEY'),
);

/**
 * Runs `bun x --no-install wrangler` with `args` and waits for it.
 *
 * @remarks
 * Each start runs the Bun that runs this script, `process.execPath`, so
 * neither PATH nor the working directory chooses it. Windows searches the
 * working directory ahead of PATH for a bare name, which would run a `bun.exe`
 * there with the account's credentials. The child takes {@link startEnv} and
 * this process's working directory, writes to this process's stdout and
 * stderr, and reads `stdin`, this process's own unless a value is given. A
 * nonzero exit throws, so no later step runs and the deploy exits 1.
 * windowsHide keeps a console program started from a process with no console
 * from opening a window.
 *
 * @param args - wrangler's arguments, each passed as one argument
 * @param stdin - What wrangler reads on stdin
 * @throws When wrangler exits other than 0
 */
async function wrangler(args: readonly string[], stdin: 'inherit' | Response = 'inherit'): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'x', '--no-install', 'wrangler', ...args],
    env: startEnv,
    stdin,
    stdout: 'inherit',
    stderr: 'inherit',
    windowsHide: true,
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed with exit code ${String(exitCode)}`);
  }
}

console.log('Applying D1 migrations…');
await wrangler(['d1', 'migrations', 'apply', 'AUDIT_DB', '--remote']);

if (hasCustomDomain) {
  console.log(`Deploying with custom domain ${customDomain}…`);
  await wrangler(['deploy', '--domain', customDomain]);
} else {
  console.log('Deploying to the workers.dev URL…');
  await wrangler(['deploy']);
}

// The value reaches wrangler on stdin, never as an argument, so it stays out
// of the process list and the shell history.
const accessKey = process.env['ACCESS_KEY'];
if (accessKey !== undefined && accessKey !== '') {
  console.log('Syncing ACCESS_KEY worker secret…');
  await wrangler(['secret', 'put', 'ACCESS_KEY'], new Response(accessKey));
} else {
  console.log('ACCESS_KEY not in environment; skipping secret sync.');
}
