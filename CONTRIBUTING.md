# Contributing

## Setup

```sh
bun install
```

That installs the dependencies and the git hooks. The commit hooks run the same tools the gate runs, on
the files you stage, and check every commit message before it is recorded. The push hook runs
`bun run check` over the whole tree and refuses the push when it fails.

## The gate

```sh
bun run check:all
```

One command, and it is the whole gate. CI runs the same checks, split across the `Gate` job for
`bun run check` and the `Test & Coverage` job for `bun run test:coverage`, so a green run on your
machine is a green run there. Run it before you push. The push hook runs the `bun run check` half on its
own. The tests are the half it leaves to you and to CI, because of the Windows temp path issue below: a
hook that cannot pass on a maintainer's machine gets bypassed, and a bypassed hook guards nothing.
`bun run test:watch` reruns the suite as you edit.

A few checks run only in CI. `CLAUDE.md` lists them and says why each one sits outside the gate.

On Windows, the Durable Object and D1 tests run in workerd, which keeps SQLite files under the temp
directory. A long temp path pushes them past MAX_PATH, and every such test fails with `internal error`
and nothing more. Point `TEMP` at a short path for the run.

## Commit messages

Every commit follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). commitlint
checks the message in the commit hook and again in CI, over the pull request's commits and its title.

```text
type(scope): subject

body
```

The type is one of those `@commitlint/config-conventional` accepts: `feat`, `fix`, `docs`,
`style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`. The specification itself fixes
only `feat` and `fix`; the rest are the Angular convention that preset encodes. Release notes come from
the type, so pick the one that says what the change does to a user rather than how it was made.

The scope is optional. A change that belongs to no single area names none. When present it is one of
these, and the list below is checked against the one commitlint enforces:

<!-- commit-scopes:start -->

| Scope      | Covers                                                                             |
| ---------- | ---------------------------------------------------------------------------------- |
| `audit`    | The D1 audit trail: what is recorded and how batches are written                   |
| `deps`     | Dependency updates, which Renovate opens under this scope                          |
| `deps-dev` | Development-only dependency updates. Historical: Renovate files everything as deps |
| `history`  | The history endpoint that reads the audit trail back out                           |
| `main`     | release-please's own release commits. Not for hand-written changes                 |
| `refusals` | The Durable Object that counts hostnames a token reaches for past its authority    |
| `release`  | Release tooling and the release workflow                                           |
| `security` | Authentication, secret handling and CI hardening                                   |

<!-- commit-scopes:end -->

To add a scope, add it to `.github/commit-scopes.json` and to this table. A test holds the two
together.

The header and every body line stay within 72 characters. A squash merge lands the pull request title
as the commit subject with ` (#NNN)` appended, and CI lints that composed subject, so keep the title
itself within 65.

A breaking change carries `!` after the type or scope, as in `feat!:`, and explains the break in the
body.

## Pull requests

Branch from the default branch, keep the pull request to one change, and let the gate be the reviewer's
first reader. The pull request template's checklist is the rest.
