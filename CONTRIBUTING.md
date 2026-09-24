# Contributing

## Setup

```sh
bun install
```

Install before the first commit. That installs the dependencies and the git hooks, which a fresh clone
lacks until it runs. The commit hooks run the same tools the gate runs, on the files you stage, and check
every commit message before it is recorded. The push hook runs the gate's quick form over the whole tree
and refuses the push when it fails.

Every hook job resolves its tool with `bunx --bun --no-install`, which fetches nothing. When the checkout's
package is installed, it always runs, at the version `bun.lock` pins. When it is missing, bunx runs a tool
of the same name from `PATH`, from a parent directory's `node_modules/.bin` or from its own cache under the
temporary directory (`bunx-<uid>-<package>@latest`), and exits 1 only when none exists. CI's `gate` job,
which installs from the lockfile, is the control for that case. `--bun` runs the tool under Bun, never under a `node` found on `PATH`, and the `format`, `format:check`, `lint`, `lint:fix` and
`prepare` scripts start theirs the same way. The `dev`, `start`, `cf-typegen` and `test` scripts start
wrangler and vitest through `bun run`, which hands each to the first `node` on `PATH`, or, on a Windows
machine at its defaults, to a `node.exe` at the checkout's root ahead of it. The hook script that
`lefthook install` writes fails open. When it finds no lefthook binary, as with `node_modules` gone, it
prints `Can't find lefthook in PATH` and exits 0. The commit or push then goes through unchecked. CI's
`commits` and `gate` jobs are the control.

[docs/dev.md](docs/dev.md#prerequisites) names what to install, and its first-run steps go from a fresh
clone to a green gate.

## The gate

```sh
bun run check
```

One command, and it is the whole gate. `bun run check:quick` is the same gate without its test row, and the
push hook runs it. `bun run check:rows` prints the rows and runs nothing. Some rows share a name with a
`package.json` script that runs the same tool by hand, and the script is not the row. The row names each
config, hands Prettier, taplo, actionlint and zizmor the tracked files, and runs every package under the
gate's own Bun. The `cf-typegen:check` and `test` scripts start theirs under `node` through `bun run`.
Reproduce a red row with the gate itself. CI's `gate` job runs the same gate on Linux, Windows and macOS, so
a green run on your machine is a green run there. Run it before you push. A new check is a row in
`scripts/check.ts`, never a step in a workflow.

CI and the push hook run the gate by its file, `bun scripts/check.ts`, so no `node_modules/.bin` sits ahead of
`PATH` before the gate refuses a tracked `node_modules` path. `bun run check` puts it there first, so on a pull
request branch that commits `node_modules/.bin/bun`, that `bun` runs before the gate does. Bun also runs a
`bunfig.toml` preload before the gate's first line, whichever way the gate starts, CI's direct call included. It
runs one before each commit hook's tool and in the scripts that start under `bunx --bun` too. The gate's
refusals keep such a branch from merging, and nothing in the gate can stop its first run on your machine.
`eslint.config.ts` and `commitlint.config.js` are code too: the `lint` row and the commit hook run them. The gate
holds both whole, so a change to either changes its copy under `scripts/` in the same commit. Read a branch's
diff before running anything from it. Install a branch you have not read with
`bun install --frozen-lockfile --ignore-scripts`, which runs no package's install script.

No row resolves a tool from the machine's `PATH`. Every package runs from its absolute path under
`node_modules/`, every other tool resolves through `mise which`, and Bun is the process running the gate. The
programs the gate expects on `PATH` are the prerequisites [docs/dev.md#prerequisites](docs/dev.md#prerequisites)
names. Each one starts from an absolute `PATH` entry outside the checkout alone, and a program found there
through a link back into the checkout is passed over. The gate never reads the working directory for a program,
and on Windows it tries `PATHEXT`'s extensions in their order. Every process the gate starts gets that same
narrowed `PATH`, so a program it starts by name never resolves inside the checkout. The gate clears
`SHELLCHECK_OPTS` for every process it starts, since it reaches ShellCheck through actionlint.

A process still running at its deadline is killed with every process it started. A process that exits while one
it started still holds its output fails its row, which says so. That process runs on, since nothing the gate can
reach ends a process whose parent is gone, so end it yourself.

Every tool that searches for its own config runs with that config named: ESLint with `--config eslint.config.ts`,
Prettier with `--config .prettierrc` and `--no-editorconfig`, taplo with `--config .taplo.toml`, zizmor with
`--config .github/zizmor.yml`, tsc with `--project`, and the commit hook's commitlint with
`--config commitlint.config.js`.

Every row that walks the tree says how many files it checked, and fails when that is none. The `format:check`,
`taplo`, `actionlint` and `zizmor` rows hand their tool the tracked files, so a new file counts once `git add`
names it, and `.gitignore` never hides a tracked one. The `taplo` row checks that taplo reports each file it was
handed, and the `actionlint` and `zizmor` rows that their tool reports every tracked workflow.

Before any row, the gate refuses to run beside what Bun reads before the gate's first line:

- a tracked env file Bun loads (`.env`, `.env.local`, and the `development`, `production` and `test` pairs), at
  any depth;
- a tracked `.npmrc` at any depth, which names the registry `bun install` fetches from;
- a tracked `node_modules`, or a tracked path under one, at any depth;
- a `bunfig.toml` holding anything but `[install] minimumReleaseAge`, since Bun runs a `preload` it names and
  applies a `[define]` table;
- a `scripts/tsconfig.json` that differs from the copy in `scripts/startup.ts`, and any other `tsconfig.json`,
  `jsconfig.json`, `package.json` or `node_modules` under `scripts/`, since Bun resolves the gate's imports through
  them;
- any other `tsconfig.json` or `jsconfig.json` that `scripts/expected.ts` does not hold, one that differs from its
  copy there, and `paths` or `baseUrl` in any of them or in a file its `extends` chain reads. Bun applies both to
  every import below the config, `node_modules` code included, so either can send a package a commit hook's tool
  imports to repository code. A project aliases through `package.json` `imports` (`#` names) instead. `extends`
  names a file relative to the config, inside the checkout, and never a package;
- a `patchedDependencies` entry in `package.json` for a package the gate's scripts import, and a `package.json`
  that does not parse;
- a key repeated within one object of any JSON file the gate reads, since Bun reads the first where a JSON parser
  reads the last.

It also refuses a config a tool would read in place of the one the gate names, and a change to what a row skips or
waives, so that change is always a change to the gate. A config that changes what a row reports is refused on
disk, tracked or not, so the gate on your machine agrees with CI:

- a `.prettierrc` that differs from the copy in `scripts/startup.ts`, any other Prettier config file anywhere in the
  tree, a `package.yaml`, and a `prettier` key in any tracked `package.json`, since Prettier loads a config written
  as code and any plugin a config names;
- an `eslint.config.ts` that differs from the copy in `scripts/expected.ts`, and any other `eslint.config.*`
  anywhere, since ESLint runs the one nearest each file it lints when no config is named;
- a `commitlint.config.js` that differs from the copy in `scripts/startup.ts`, any other `.commitlintrc*` or
  `commitlint.config.*` anywhere, and a `commitlint` or `cosmiconfig` key in any tracked `package.json`;
- a `.prettierignore` whose patterns differ from the shared ones in `scripts/startup.ts` and this repository's own
  in `scripts/expected.ts`. Every Prettier run passes `--ignore-path .prettierignore`, so `.gitignore` never
  narrows Prettier;
- a `.taplo.toml` that differs from the copy in `scripts/startup.ts`, and any other `.taplo.toml` or `taplo.toml`;
- a `.github/zizmor.yml` that differs from the copy in `scripts/expected.ts`, any other `zizmor.yml` or
  `zizmor.yaml`, and a tracked file under `.github` carrying a `zizmor: ignore[...]` comment. A waiver is an entry
  in `.github/zizmor.yml`, scoped to the file, line and column of the finding it waives;
- a `.github/actionlint.yaml` or `.github/actionlint.yml`, which can silence any actionlint finding;
- a lefthook config beside `lefthook.yml` (`lefthook.*` or `.lefthook.*`), which lefthook reads when
  `lefthook.yml` is missing, and a tracked `lefthook-local.*` or `.lefthook-local.*`, which lefthook merges over
  `lefthook.yml`. `.gitignore` lists the local ones for your own use;
- a `.config` directory at the root, which mise, lefthook and commitlint's cosmiconfig each read;
- a tracked workflow whose path is not `.github/workflows/<name>.yml` exactly, and a tracked path under a `.git`,
  `.sl`, `.svn`, `.hg` or `.jj` directory, since the `actionlint`, `zizmor` or `format:check` row would count it
  and never check it;
- a root file named like a program the gate, its hooks or an install start: `bun`, `bunx`, `gh`, `git`, `mise` or
  `node`, with any extension, beside `bun.lock` and the two mise files.

Each name is compared through Unicode case folding, broader than any filesystem's, so a spelling that a
case-insensitive filesystem opens as a refused name is refused too. A template such as `.env.local.template`
passes, and so does your own untracked env file, `.npmrc` or `lefthook-local.yml`. The gate loads nothing from
`node_modules/` until these checks pass, so a planted package never runs ahead of its refusal.
`scripts/run.ts`, `scripts/tools.ts` and `scripts/startup.ts` are the same in every `zachthedev` repository
that runs this gate, and `scripts/expected.ts` holds what is this repository's own.

The `tools` row reads `mise.toml` and `mise.lock` against the expectations in `scripts/tools.ts`, and installs
from the lockfile only after that read passes. `mise.toml` holds `[tools]`, `[tool_config]` and `[settings]`
alone, and the last two equal the values in `scripts/tools.ts` exactly, because mise runs a `[hooks]`, `[env]` or
`[vars]` table on install. Every key of `mise.lock` is one `scripts/tools.ts` names. The row refuses every other file
mise reads as config or a lockfile in the root, such as `mise.local.toml`, `.tool-versions` or `.miserc.toml`,
because mise merges each one, and a lockfile beside it, over `mise.lock`. It refuses a link at the root or under
`.config`, `.mise` or `mise`. Every mise command the gate starts carries an
environment built from a short list: the temporary directory, the Unix home, a proxy, the Windows folders the
system reports, and the gate's own mise settings. No other variable reaches mise, so a personal mise setting
never changes the gate. `mise.lock` pins `linux-x64`, `macos-arm64` and `windows-x64`, and a contributor on another
platform relocks in a pull request.

The gate is a function of the tree: it runs offline and means the same thing against a commit from a
year ago. One row is not, by choice. In `bun run check`, zizmor runs online when `gh auth token` answers,
so its advisory, impostor-commit and version-comment audits can read GitHub, and that answer reaches
zizmor's process alone. The gate takes every GitHub token variable its tools read out of the rows'
environment, so no row inherits one. zizmor runs offline otherwise: in CI, where no step hands the gate a
token; in `bun run check:quick`, so the hook needs no network and no token; and under
`ZIZMOR_OFFLINE=true`. The zizmor row prints which way it ran on every run.

The `cf-typegen:check` row refuses a `worker-configuration.d.ts` git does not track, since `git diff` passes
over an untracked file. When wrangler fails, the row puts the tracked copy back before it goes red, so a failed
run leaves no deletion in the tree.

Two environment variables change what the `cf-typegen:check` row generates, and neither is set by
default: `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` copies the whole shell environment into `Env`, and
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` makes wrangler ignore the `--env-file` flag. Either turns a
green row red and neither turns a red one green. Do not set either when running the gate.

The saturation tests in `tests/refusals.test.ts` can fail with `Test timed out` on a heavily loaded
machine. They are the tests under `RefusalCounter guards` that drive the tally to its write ceiling,
`WRITES_MAX` in `src/refusals.ts`, one call at a time. Under heavy load those calls outlast `testTimeout`
in `vitest.config.mts`. Unloaded, they finish well inside it. A timeout on the saturation tests alone,
under load, is not a regression. Re-run the gate with the machine unloaded.

Checks that run in CI and not in the gate, each with the reason it sits outside:

- `commits` lints the pull request's commit range and its title. Neither exists before the pull
  request does.
- `Secret scan` runs trufflehog over the pull request's base and head commits with the official action,
  which no working machine has.
- `workflows` runs actionlint and zizmor online over `.github/workflows` from the shared workflow, so
  zizmor's advisory, impostor-commit and version-comment audits read GitHub with the job's token on every
  pull request, whatever the contributor's machine holds. It is the one job that hands zizmor a token.
- `dependency-review` compares the dependency manifests against the pull request's base. An advisory is a
  function of the world rather than of the tree, so the same commit passes today and fails tomorrow with
  nothing changed; that is not a gate row. A pull request is where blocking is right, because the fix is a
  version bump and the author is there to make it. [Dependencies](#dependencies) says what it covers and
  how a finding is cleared.
- `codeql` is GitHub's analysis and runs on GitHub.

`commits`, `workflows`, `dependency-review` and `codeql` are the reusable workflows in
[zachthedev/.github](https://github.com/zachthedev/.github), pinned by commit in `ci.yml` and `codeql.yml`.

## Commit messages

Every commit follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). commitlint
checks the message in the commit hook and again in CI, over the pull request's commits and its title.

```text
type(scope): subject

body
```

The type is one of those `@commitlint/config-conventional` accepts, listed under `type-enum` in what
`bunx --bun --no-install commitlint --config commitlint.config.js --print-config` prints. Release notes
come from the type, so pick the one that says what the change does to a user rather than how it was made. A tooling or configuration
change takes a type `release-please-config.json` hides, `chore` or `ci`, never `fix` or `feat`, because a
published type opens a release pull request ([Releases](#releases)).

A revert is written `revert(<scope>): <what is undone, in fresh words>`, with a `Refs: <sha>` footer
naming each reverted commit. The scope and length rules below apply to it as to any commit. A subject in
fresh words fits them, and a copied header often does not. commitlint skips git's `Revert "..."` subject
unchecked. release-please cannot parse it, so that revert never reaches the changelog.

`changelog-sections` in `release-please-config.json` hides a type from the changelog, not from the
history. Every version heading after 1.0.0 links GitHub's compare view from the previous tag. That view
and `git log <previous tag>..<tag>` list every change in a release, hidden types included.

The scope is optional. A change that belongs to no single area names none. `.github/commit-scopes.json`
lists each scope and what it covers, and commitlint accepts no other. Omit the scope rather than invent
one. A new area earns a scope in that file, in the change that adds the area.

The header and every body line stay within 72 characters. A squash merge of a one-commit pull request
lands that commit's subject and body. A longer pull request lands under its title, with its commits as
bullets in the body. release-please reads the title's type alone, so the title takes the type of the pull
request's most user-facing commit. The title also carries `!` when any of its commits breaks something
users see, because a commit's own `!` does not survive the squash. GitHub appends ` (#NNN)` to either
subject. CI lints the title with that suffix and each commit as written. Keep the title within 65, and a
one-commit pull request's subject equal to its title, so the title's lint covers the subject that lands.

A squash that landed under the wrong type is corrected in the merged pull request's description, before
the release pull request merges. release-please runs on the next push to `main` and reads an
override block there in place of the landed message. Each header carries its ` (#NNN)`. A blank line
separates two headers:

```text
BEGIN_COMMIT_OVERRIDE
fix(scope): subject (#NNN)

chore(scope): subject (#NNN)
END_COMMIT_OVERRIDE
```

The body carries what the diff cannot show: what was wrong, what the change does now, and what was
deliberately not done. Change narrative belongs here and never in a code comment, which describes the code
as it is. A change that breaks something users see carries `!` after the type or scope, as in `feat!:`,
and explains the break in the body. A break only contributors see, such as a renamed gate row, carries
neither `!` nor a `BREAKING CHANGE:` footer, because either one cuts a major release whatever the type.

## Where code goes

- `src/` is the worker. `index.ts` is the request handler, `audit.ts` the D1 audit trail, `refusals.ts`
  the Durable Object that counts refusals per token, and `pushNtfy.ts` the notification relay. A new
  concern is a new module beside them, imported from `index.ts`.
- `scripts/` is tooling that runs under Bun on a contributor's machine and in CI: the gate and the deploy.
- `tests/` is the vitest suite, in two projects: `workers` runs under the Cloudflare vitest plugin against
  miniflare's bindings, and `node` (`*.node.test.ts`) runs under Node for a test that reads the repository
  itself, such as `wrangler.jsonc` through wrangler's own parser. `tests/helpers/` holds the shared mocks.
- `migrations/` is the D1 schema, one numbered file per change, applied by every deploy.
- `docs/` is the human documentation the README indexes.

## Tests

- A test never reaches the Cloudflare API, a DNS record or an ntfy server. `fetch` is stubbed and the
  bindings are miniflare's. A test that needs the SDK uses the mocks in `tests/helpers/mocks.ts`, which
  stand in for the SDK's paginated list endpoints as the worker consumes them.
- A test states what the code is supposed to do, derived from the requirement, never copied from what the
  code printed. A test that fails first is doing its job.
- Table-driven cases are the default where several inputs share one assertion.
- The gate's own tests, `scripts/*.test.ts`, run under `bun test` in the `scripts:test` row, because they call
  Bun's APIs. They start no real gh, git or mise: each case hands the code a stand-in, by its path or first on
  `PATH`.
- A test that reads a file in the repository belongs in the `node` project and reads it through the tool
  that owns it, never by regex over the text.

## Code

- Every function signature carries explicit parameter and return types. ESLint enforces the return type;
  the rest is convention.
- Validate at the boundary and trust the inside. Query parameters, headers and API responses are checked
  where they arrive; internal calls take typed values.
- A comment explains why the code is shaped as it is, pointing at something outside the file that is still
  true. What was wrong before and what a change fixed goes in the commit message.
- Every process a script starts carries a deadline and no shell, so a tool that hangs is a red row and an
  argument is never a shell word.
- Nothing prints a resource ID, a token or an access key. Logs redact the query string and error messages
  quote inputs encoded and cut short.

## Dependencies

Every dependency is pinned to an exact version in `package.json`, tools included, so Renovate moves each
through a pull request and nothing moves through lock file maintenance alone. Renovate runs self-hosted
under the `zachthedev-updater` app from `.github/renovate.json`, with a three-day cooldown on every new
release. `bunfig.toml` carries that same cooldown for `bun install` itself, and it is committed because
the updater's lock file maintenance and CI run in containers with no other configuration, so the file is
the one cooldown those runs observe.

Renovate picks its commit type by what a bump does to a user: a runtime dependency lands as `fix` and
ships, a development dependency, a wrangler bump and an action bump land as `chore` or `ci` and do not.
Unhiding one of those types in `release-please-config.json` would put its commits back in the changelog,
so each would cut a release and deploy.

Two compilers are installed on purpose. `bun run typecheck` runs the native compiler from the
`@typescript/native` alias, called by path because `typescript` also ships a `tsc`. `typescript` itself
stays on the major typescript-eslint's `typescript` peer range admits, because typescript-eslint needs
that compiler's API; `.github/renovate.json` holds the major back and says what lifts the hold.

The advisory legs:

- The `dependency-review` check in `ci.yml` blocks a pull request on what it adds against its base, and a
  release pull request on what the release adds against the last tag, at high severity. Under Bun it sees
  the exactly pinned direct packages in `package.json` and the actions in the workflows, and not
  `bun.lock`'s transitives.
- The `audit` workflow runs `bun audit --audit-level=high` over the whole of `bun.lock`, transitives
  included, once a day as a report. It never blocks a merge or a deploy: uddns is a deployed service, so
  blocking would not remove the vulnerable code from production, and every unrelated fix would queue behind
  the block. A red run is work to pick up, and [docs/deploy.md](docs/deploy.md#operating-it) says what it
  means for the running worker. It fails closed: when it cannot reach the advisory endpoint it stays red
  until the outage clears.
- Dependabot alerts stay on, security updates off; Renovate opens the fix for a direct dependency, and a
  transitive is fixed by hand as below.

Clearing a finding, in order:

1. Re-resolve. A finding is usually a stale lock file entry for a package whose parent range already
   spans the patched floor. `bun audit fix` upgrades the vulnerable packages to the lowest safe version
   that still satisfies every dependent's range, and rewrites `package.json` only where an exact pin has to
   move. Commit `bun.lock`.
2. If the finding stands, the parent pins an exact version below the patched floor, and an `overrides`
   entry in `package.json` is the fallback. `package.json` carries no `overrides` block today, and that is
   the state to return to: on every dependency bump, delete the override, re-resolve, and keep it deleted
   when the audit stays clean. Never `bun update <package>` on a transitive; Bun reads the name as a new
   direct dependency.
3. If no fix is published, or the vulnerable path is unreachable from this worker, waive it: add the GHSA
   id to `allow-ghsas` on the `dependency-review` job in `ci.yml` with a comment beside it naming the
   advisory, what it affects here, why shipping is safer than not shipping, and what removes the
   exception, and in the same commit add `--ignore <GHSA-id>` to the `audit` script in `package.json` so
   the daily report stays readable. `package.json` takes no comments, so the workflow carries the record
   and the flag points at it by ID. A flag with no record is an unreviewed suppression. A waiver is never
   for making a red check green.

## Releases

[release-please](https://github.com/googleapis/release-please) runs under the `zachthedev-releaser` app
on every push to `main`. Once a releasable change lands, it opens one pull request titled
`chore(main): release x.y.z` and keeps it up to date. Merging it tags the merge commit and creates the
GitHub Release as a draft, every time; the `publish` job flips the draft public under the `release`
environment's reviewer, and the deploy runs against that revision.
[docs/deploy.md](docs/deploy.md#releasing-deploys) says how the deploy follows.

release-please owns the version in `package.json`, `.release-please-manifest.json` and `CHANGELOG.md`.
Nobody edits any of the three by hand.

What makes a change releasable is `changelog-sections` in `release-please-config.json`. release-please
renders the changelog body first and opens no release pull request when it comes out empty, so a hidden
type releases nothing and a visible one gives a patch, `feat` a minor. `!` or a `BREAKING CHANGE:` footer
gives a major on any type, a hidden one included. Hiding decides releasability, not presentation. The
commit types the changelog hides are that file's record. [Commit messages](#commit-messages) says why a
change takes one.

The version started at 1.0.0 rather than 0.x, deliberately. The worker's interface is its URL contract:
the query parameters a device sends and the JSON it gets back. That contract was settled at v1.0.0 and
still holds, so the number states stability rather than defaulting to it. Being at 1.x is also what gives
`feat!` its meaning: below 1.0.0, release-please treats a breaking change as a minor bump, so the marker
cannot signal a break at all.

Publishing is a human step. release-please creates the tag and a draft release; the `publish` job in
`cd.yml` waits for the `release` environment's reviewer and then flips the draft public, and the deploy
follows the flip. A draft that is never approved ships nothing, and a failed release is the next version.

## What never happens

- `wrangler.jsonc` never carries a resource ID or a route. wrangler reuses the KV namespace and D1 database
  the deployed worker holds under the binding names, and creates them where no such worker exists. An ID
  committed there would pin every fork to one account, and `tests/wrangler-config.node.test.ts` refuses
  one. The custom domain arrives from the deploying machine for the same reason.
- A test never reaches the Cloudflare API, a DNS record or an ntfy server ([Tests](#tests)).
- Nobody hand-edits a file release-please owns ([Releases](#releases)).
- A commit never carries a scope outside `.github/commit-scopes.json`, and a tooling change never takes a
  type that cuts a release ([Commit messages](#commit-messages)).
- No workflow lists a check as a step. CI calls `bun scripts/check.ts`, and a check that cannot run locally sits
  in `ci.yml` with a comment saying why ([The gate](#the-gate)).
- No document restates a list another file owns. A command, a path or a label is named; a list, a table or
  a procedure has one home and every other file links to it. `check:rows` prints the gate's rows,
  `.github/commit-scopes.json` holds the scopes, `release-please-config.json` holds the changelog types, and
  the deploy job's `env:` block holds the deployment values.
- `package.json` never carries an `overrides` block or an `--ignore` flag without its record
  ([Dependencies](#dependencies)).
