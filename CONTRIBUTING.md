# Contributing

## Setup

```sh
bun install
```

Install before committing. That installs the dependencies and the git hooks, and every hook resolves its
tool from the installed packages and fails closed without them: `bunx --no-install` exits 1 rather than
fetching one, so the version that runs is always the one `package.json` pins. The commit hooks run the
same tools the gate runs, on the files you stage, and check every commit message before it is recorded.
The push hook runs the gate's quick form over the whole tree and refuses the push when it fails.

[docs/dev.md](docs/dev.md#prerequisites) names what to install, and its first-run steps go from a fresh
clone to a green gate.

## The gate

```sh
bun run check
```

One command, and it is the whole gate. `bun run check:quick` is the same gate without its test row, and is
what the push hook runs. `bun run check:rows` prints the rows and runs nothing. A row that is a
`package.json` script runs alone as `bun run <name>`; the rows command shows which. CI runs `bun run check`
on Linux, Windows and macOS in the `gate` job, so a green run on your machine is a green run there. Run
it before you push. A new check is a row in `scripts/check.ts`, never a step in a workflow.

The gate is a function of the tree: it runs offline and means the same thing against a commit from a
year ago. One row is not, by choice. In `bun run check`, zizmor runs online when a GitHub token is at hand
(`GH_TOKEN`, else `gh auth token`), so its advisory and stale-ref audits can read GitHub, and that token
reaches zizmor's process alone. `bun run check:quick` runs it offline, so the hook needs no network and no
token, and `ZIZMOR_OFFLINE=true` forces offline for the full gate.

Two environment variables change what the `cf-typegen:check` row generates, and neither is set by
default: `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` copies the whole shell environment into `Env`, and
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` makes wrangler ignore the `--env-file` flag. Either turns a
green row red and neither turns a red one green. Do not set either when running the gate.

Checks that run in CI and not in the gate, each with the reason it sits outside:

- `Commit Messages` lints the pull request's commit range and its title. Neither exists before the pull
  request does.
- `Secret scan` runs trufflehog over the pull request's base and head commits with the official action,
  which no working machine has.
- `Audit dependencies` runs `bun audit` over `bun.lock`. An advisory is a function of the world rather than
  of the tree, so the same commit passes today and fails tomorrow with nothing changed; that is not a gate
  row. A pull request is where blocking is right, because the fix is a version bump and the author is there
  to make it. [Dependencies](#dependencies) says what the audit covers and how a finding is cleared.
- CodeQL is GitHub's analysis and runs on GitHub.

## Commit messages

Every commit follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). commitlint
checks the message in the commit hook and again in CI, over the pull request's commits and its title.

```text
type(scope): subject

body
```

The type is one of those `@commitlint/config-conventional` accepts: `feat`, `fix`, `docs`, `style`,
`refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`. Release notes come from the type, so pick
the one that says what the change does to a user rather than how it was made. A tooling or configuration
change takes a type `release-please-config.json` hides, `chore` or `ci`, never `fix`, `feat` or `build`,
because a published type opens a release pull request ([Releases](#releases)).

The scope is optional. A change that belongs to no single area names none. `.github/commit-scopes.json`
lists each scope and what it covers, and commitlint accepts no other. Omit the scope rather than invent
one. A new area earns a scope in that file, in the change that adds the area.

The header and every body line stay within 72 characters. A squash merge lands the pull request title
as the commit subject with ` (#NNN)` appended, and CI lints that composed subject, so keep the title
itself within 65.

The body carries what the diff cannot show: what was wrong, what the change does now, and what was
deliberately not done. Change narrative belongs here and never in a code comment, which describes the code
as it is. A breaking change carries `!` after the type or scope, as in `feat!:`, and explains the break in
the body.

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

Two compilers are installed on purpose. `bun run typecheck` runs the native TypeScript 7 compiler from
the `@typescript/native` alias, called by path because `typescript` also ships a `tsc`. `typescript` stays
on 6.x for typescript-eslint, which needs the 6.x compiler API. Once typescript-eslint's `typescript` peer
range admits 7, move `typescript` to 7.x and drop the alias.

The advisory legs:

- `Audit dependencies` in `ci.yml` runs `bun audit --audit-level=high` over the whole of `bun.lock`,
  transitives included, on every pull request and push to `main`, and blocks. It fails closed: when it
  cannot reach the advisory endpoint it stays red until the outage clears, so somebody else's registry
  incident is a blocked merge here. That is chosen rather than overlooked. A finding prints JSON keyed by
  package name, while an unreachable endpoint prints nothing to stdout and errors to stderr, so empty
  stdout with a non-zero exit identifies an outage exactly and a wrapper could fail open on that one
  case. Anyone reweighing this starts there.
- The `audit` workflow runs the same command once a day as a report. It never blocks a deploy: uddns is a
  deployed service, so blocking would not remove the vulnerable code from production, and every unrelated
  fix would queue behind the block. Between an advisory landing and a fix, the worker runs vulnerable code,
  and the daily run is the only thing that says so. A red run is work to pick up.
- Dependabot alerts stay on, security updates off; Renovate opens the fix.

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
3. If no fix is published, or the vulnerable path is unreachable from this worker, waive it: add
   `--ignore <GHSA-id>` to the `audit` script in `package.json`, and in the same commit a comment beside the
   `Audit dependencies` job in `ci.yml` naming the advisory, what it affects here, why shipping is safer
   than not shipping, and what removes the exception. `package.json` takes no comments, so the workflow
   carries the record and the flag points at it by ID. A flag with no record is an unreviewed suppression.
   A waiver is never for making a red check green.

## Releases

[release-please](https://github.com/googleapis/release-please) runs under the `zachthedev-releaser` app
on every push to `main`. Once a releasable change lands, it opens one pull request titled
`chore(main): release x.y.z` and keeps it up to date. Merging it is the release: the merge commit is
tagged, the GitHub Release is published, and the deploy runs against that revision.
[docs/deploy.md](docs/deploy.md#releasing-deploys) says how the deploy follows.

release-please owns the version in `package.json`, `.release-please-manifest.json` and `CHANGELOG.md`.
Nobody edits any of the three by hand.

What makes a change releasable is `changelog-sections` in `release-please-config.json`. release-please
renders the changelog body first and opens no release pull request when it comes out empty, so a hidden
type releases nothing and a visible one gives a patch, `feat` a minor, and `!` or a `BREAKING CHANGE:`
footer a major. Hiding decides releasability, not presentation. The commit types the changelog hides,
and the reason each is hidden, are that file's record.

The version started at 1.0.0 rather than 0.x, deliberately. The worker's interface is its URL contract:
the query parameters a device sends and the JSON it gets back. That contract was settled at v1.0.0 and
still holds, so the number states stability rather than defaulting to it. Being at 1.x is also what gives
`feat!` its meaning: below 1.0.0, release-please treats a breaking change as a minor bump, so the marker
cannot signal a break at all.

Publishing is release-please's: the GitHub Release is published as the tag is created, and the deploy
runs from it.

## What never happens

- `wrangler.jsonc` never carries a resource ID or a route. wrangler reuses the KV namespace and D1 database
  the deployed worker holds under the binding names, and creates them where no such worker exists. An ID
  committed there would pin every fork to one account, and `tests/wrangler-config.node.test.ts` refuses
  one. The custom domain arrives from the deploying machine for the same reason.
- A test never reaches the Cloudflare API, a DNS record or an ntfy server ([Tests](#tests)).
- Nobody hand-edits a file release-please owns ([Releases](#releases)).
- A commit never carries a scope outside `.github/commit-scopes.json`, and a tooling change never takes a
  type that cuts a release ([Commit messages](#commit-messages)).
- No workflow lists a check as a step. CI calls `bun run check`, and a check that cannot run locally sits
  in `ci.yml` with a comment saying why ([The gate](#the-gate)).
- No document restates a list another file owns. A command, a path or a label is named; a list, a table or
  a procedure has one home and every other file links to it. `check:rows` prints the gate's rows,
  `.github/commit-scopes.json` holds the scopes, `release-please-config.json` holds the changelog types, and
  the deploy job's `env:` block holds the deployment values.
- `package.json` never carries an `overrides` block or an `--ignore` flag without its record
  ([Dependencies](#dependencies)).
