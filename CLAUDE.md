# uddns

Cloudflare Worker providing DDNS updates for UniFi OS devices, with per-caller
ntfy notifications, multi-zone tokens, a D1 audit trail, and a JSON API.
Originally derived from willswire/unifi-ddns; now an independent project.

Toolchain: bun (package manager and script runner), wrangler, vitest with
the Cloudflare Vitest plugin, ESLint + prettier, lefthook hooks.

- Install: `bun install`
- Verify everything: `bun run check:all`. It is the whole gate, and every workflow calls a script rather
  than listing its steps. `check` runs, roughly cheapest first, the placeholder scan, `typecheck`, `cf-typegen:check`,
  `format:check` and `lint`. `check:all` adds the tests. A new check goes here, not into a workflow.
- Documentation deviation, stated deliberately: no test binds a gate table to the gate's own step list,
  because the repository publishes no such table. `CONTRIBUTING.md` names commands and never legs.
  `tests/commit-scopes.node.test.ts` then asserts that every `bun run <script>` the guide names is
  defined in `package.json`. A list that exists once cannot disagree with itself. Removing the
  duplication is what defeats the drift, rather than a check that polices a second copy.
- The gate is hermetic: a function of the tree and nothing else. That is what lets it run offline and mean
  the same thing against a commit from a year ago. A check whose result can change while the tree stands
  still is not hermetic and does not belong in it. Hermeticity is the property at stake rather than
  reproducibility, which is about output bytes; an advisory check does not change the bytes, it changes
  whether the run completes. Named exceptions sit in the types leg: wrangler reads
  `CLOUDFLARE_INCLUDE_PROCESS_ENV` and `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` from the environment, and
  either one set away from its default changes what it generates. `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`
  copies the whole shell environment into `Env`. `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` makes
  wrangler ignore the explicit `--env-file` flag, which the name does not say, so the template's secrets
  drop out of `Env`. Both run in one direction: either turns a green `cf-typegen:check` red, and neither
  can turn a red one green, because they add or remove secret-shaped members while a stale file differs
  by a binding. Neither is set by default. Do not set either when running the gate. The git half of that
  leg passes `--no-ext-diff`, so a `diff.external` seeded through `GIT_CONFIG_COUNT` cannot answer for it.
  Three loader-injection variables can hide a failure, and they are documented rather than refused:
  `BUN_OPTIONS=--preload=<file>` runs code inside every leg bun runs,
  `NODE_OPTIONS=--require=<file>` does the same inside wrangler, prettier and eslint, and `JITI_ALIAS`
  swaps what `eslint.config.ts` imports. Each needs a file on disk and the intent to use it, and the
  environment that carries them also carries `PATH`. A gate that refused them would produce a message
  rather than safety, and would refuse the harmless `NODE_OPTIONS=--max-old-space-size` with them.
- `bun run audit` is exactly the kind of check that is not hermetic, so it runs on pull requests and on
  pushes to main through `ci.yml`, daily through `dependency-audit.yml`, and never on the deploy path.
  Blocking a deploy would not remove the vulnerable code: uddns is a deployed service, so production keeps
  running an older or identical tree, and every unrelated fix queues behind the block. A pull request is
  the opposite case, because the fix is a version bump and the author is there to make it.
- The cost of that, which is the half most easily skipped: between an advisory landing and a fix, the
  Worker runs vulnerable code, and the daily job is the only thing that says so. Somebody has to read it.
  A scheduled job nobody reads is worse than none, because it manufactures the appearance of coverage. A
  red `Dependency Audit` run is work to pick up, not a notification to dismiss.
- Waiving an advisory the team has consciously accepted: add `--ignore <GHSA-id>` to the `audit` script in
  `package.json`, and in the same commit add a row to the advisory waivers table in
  docs/dependency-overrides.md giving the advisory URL, what it affects here, why shipping is safer than
  not shipping, and what removes the exception. `package.json` takes no comments, so the record lives in
  the doc and the flag points at it by ID. A flag with no row is the shape this rule exists to prevent: a
  gate one person can suppress in ten seconds is not a gate, and the written record is what stands in for
  the reviewer a solo maintainer does not have. It is also how the audit comes to block only on what a
  change introduces, because a pre-existing advisory stops blocking once its row exists.
- Accepted behavior: `bun audit` fails closed. When it cannot reach the advisory endpoint the pull
  request gate fails, and stays failed until the outage clears, so somebody else's registry incident
  becomes a blocked merge here. That is chosen rather than overlooked. The road not taken, measured
  rather than guessed: a finding prints JSON keyed by package name, while an unreachable endpoint prints
  nothing to stdout and errors to stderr, so empty stdout with a non-zero exit identifies an outage
  exactly and a wrapper could fail open on that one case. Anyone reweighing this starts there rather
  than measuring it again.
- Known exposure, because nothing reports it: the scheduled workflows depend on Renovate staying alive.
  GitHub disables a `schedule:` trigger in a public repository after 60 days with no repository activity,
  and Renovate's branch pushes are that activity. If Renovate stops, `dependency-updates.yml` and
  `dependency-audit.yml` go quiet together and are then disabled, with no notification. The thing that
  would report the failure is the thing that failed, so check Renovate is still opening pull requests.
- CI splits the gate so the tests run once per pull request: the `Gate` job runs `check` and the
  `Test & Coverage` job runs `test:coverage`. `deploy.yml` and `release-please.yml` run `check:all`, because
  a manual deploy takes any ref, and a tag and a GitHub Release cannot be withdrawn once published.
- The lefthook `pre-push` hook runs `check`, the same script as the `Gate` job, and refuses the push when
  it fails. `lefthook.yml` says why the tests stay out of it.
- Checks that run in CI and not in the gate, each with the reason it sits outside. A working machine
  cannot run these. The secret scan needs the trufflehog action and the pull request's base and head
  commits. The coverage comment needs `pull-requests: write` against an open pull request. The
  `Commit Messages` job lints the pull request's own commit range and its title, neither of which exists
  before the pull request does. A working machine could run these. The trufflehog digest assertion needs
  docker and ghcr.io and guards a pin Renovate moves in `ci.yml` itself. The deploy dry run
  (`bun scripts/deploy.ts --dry-run`: about four seconds, offline, and it writes the gitignored
  `wrangler.deploy.jsonc` and leaves it there) is a gate candidate still outside the gate. The audit is
  none of these. It sits outside the gate by scope rather than as an exception, the same way a scheduled
  dependency update does.
- Commit messages follow Conventional Commits, and commitlint enforces that: the lefthook `commit-msg`
  hook lints each message as it is recorded, and the `Commit Messages` job in `ci.yml` lints
  a pull request's base..head range and then the composed squash subject `<title> (#<number>)`, which is
  what lands on main under a squash merge, so a pull request title is effectively capped at 65
  characters. The rules are in `commitlint.config.js`: config-conventional's types, scopes from
  `.github/commit-scopes.json`, header and body lines at 72. That JSON file is the only copy of the scope
  vocabulary, an array of `{ scope, covers }` entries. `CONTRIBUTING.md` points at it by path rather than
  restating it, and `tests/commit-scopes.node.test.ts` binds the JSON to the rule commitlint loads, checks
  every entry carries a scope and what it covers, and fails any document that lists the scopes again.
  Adding a scope is one edit to the JSON.
- Generated types: `bun run cf-typegen` passes `--env-file .dev.vars.template`, so the committed
  `worker-configuration.d.ts` carries the template's secret names rather than whichever ones a contributor
  keeps in their own gitignored `.dev.vars`. `cf-typegen:check` deletes the file, regenerates the whole of
  it, and then runs `git diff --exit-code` against it, so it compares bytes against the index rather than
  trusting the file's own header. wrangler carries the runtime half forward from an existing file
  whenever its `// Runtime types generated with workerd@` line matches. A regeneration over the existing
  file therefore re-reads the file under test, which the deletion prevents. wrangler's `--check` flag
  trusts the file's header lines, which the file's author controls, and never reads the body, so it is
  not used. A failure means the staged or committed file is stale: stage the regenerated one and run
  again. If wrangler itself fails, the file is absent until `git checkout -- worker-configuration.d.ts`
  restores it.
- Deploy (local or CI): `bun run deploy` (see scripts/deploy.ts)
- First-time setup on a clone or fork: `bun run setup`
- TypeScript: `bun run typecheck` runs the native 7.x compiler from the `@typescript/native` alias, called
  by path because `typescript` also ships a `tsc`. `typescript` stays on 6.x for typescript-eslint, which
  needs the 6.x compiler API. Once typescript-eslint's `typescript` peer range admits 7, move
  `typescript` to 7.x and drop the alias.
- Dependency overrides: `package.json` carries no `overrides` block, and that is the state to return to.
  A `bun audit` failure is usually a stale lockfile, so re-resolve before pinning anything
  (see docs/dependency-overrides.md).

Cloudflare resource naming: `<type>-<project>-<purpose>-<env>`, e.g.
`kv-uddns-cache-prod`, `kv-uddns-cache-dev`, `d1-uddns-audit-prod`. Binding
names in code stay short (`DDNS_KV`, `AUDIT_DB`). The D1 name comes from
wrangler.jsonc and follows the convention automatically; KV namespaces
created by `bun run setup` get wrangler's default titles, and the
convention-named titles are applied by renaming in the dashboard (titles are
cosmetic; IDs and bindings are what matter). The production worker is named
`uddns` and is served at the custom domain `ddns.quist.network`.
