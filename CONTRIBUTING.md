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
bun run check
```

One command, and it is the whole gate. `bun run check:rows` prints its rows. CI runs the same command
on Linux, Windows and macOS in the `gate` job, so a green run on your machine is a green run there. Run
it before you push. The push hook runs `bun run check:quick`, the gate without its test row, because of
the Windows temp path issue below. `bun run test:watch` reruns the suite as you edit.

The gate's own tools, actionlint, ShellCheck, taplo and zizmor, come from [mise](https://mise.jdx.dev)
at the versions `mise.toml` pins. Install mise once and run `mise trust` in the checkout; the gate's
first run downloads the four tools from `mise.lock`, and every run after that is offline. `mise.lock`
pins Linux x64, macOS arm64 and Windows x64, the platforms CI runs, and mise refuses any other.
`bun install` installs everything else, including the git hooks.

`bun run check` runs zizmor online when `gh auth token` succeeds, handing that token to zizmor so its
advisory and stale-ref audits can read GitHub. `bun run check:quick` runs it offline, and
`ZIZMOR_OFFLINE=true` makes `bun run check` do the same.

A few checks run only in CI. `AGENTS.md` lists them and says why each one sits outside the gate.

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
the type, so pick the one that says what the change does to a user rather than how it was made. Tooling
and configuration changes take a type `release-please-config.json` hides, never `fix` or `feat`, because
a published type opens a release pull request.

The scope is optional. A change that belongs to no single area names none. `.github/commit-scopes.json`
lists each scope and what it covers, and commitlint accepts no other. Omit the scope rather than invent
one. A new area earns a scope in that file, in the change that adds the area.

The header and every body line stay within 72 characters. A squash merge lands the pull request title
as the commit subject with ` (#NNN)` appended, and CI lints that composed subject, so keep the title
itself within 65.

A breaking change carries `!` after the type or scope, as in `feat!:`, and explains the break in the
body.

## Pull requests

Branch from the default branch, keep the pull request to one change, and let the gate be the reviewer's
first reader. The pull request template's checklist is the rest.
