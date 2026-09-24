# Development

How to get from a fresh clone to a green gate and a running worker. [CONTRIBUTING.md](../CONTRIBUTING.md)
carries the conventions; this file carries the machine.

## Prerequisites

- [Bun](https://bun.sh), at the version `packageManager` in `package.json` names. Bun is the package
  manager, the script runner and the runtime for `scripts/`.
- [mise](https://mise.jdx.dev), any current release. It installs the tools the gate runs that no package
  in `bun.lock` ships. `mise.toml` names each tool, its version and the platforms `mise.lock` pins, which
  are the platforms CI runs; mise refuses any other. Keep no other mise file in the checkout, not even an
  untracked one: mise reads every config and lockfile it finds, `mise.local.toml`, `.mise.toml`,
  `.tool-versions` and `.config/mise/` among them, so the gate's `tools` row refuses any mise file but
  those two.
- [GitHub CLI](https://cli.github.com), optional. When `gh auth token` answers, `bun run check` runs
  zizmor online and hands that answer to zizmor alone, so its advisory, impostor-commit and
  version-comment audits can read GitHub.

Every other tool, wrangler included, arrives through `bun install` at the version `package.json` pins.

## First run

```sh
bun install
mise trust
bun run check
```

`bun install` installs the dependencies and the git hooks. `mise trust` lets mise read this checkout's
`mise.toml`; the first `bun run check` then downloads the tools it names, and every run after that is
offline. `bun run check:rows` prints what the gate covers.

On Windows, the Durable Object and D1 tests run in workerd, which keeps SQLite files under the temp
directory. A long temp path pushes them past `MAX_PATH`, and every such test fails with `internal error`
and nothing more. Point `TEMP` at a short path for the run. The push hook runs the gate's quick form,
without its test row, for this reason.

## Running it

```sh
bun run dev
```

That is `wrangler dev`, serving the worker at a local URL with KV, D1 and the Durable Object simulated.
Worker secrets for the local run come from `.dev.vars`, copied from `.dev.vars.template`; the file is
gitignored and holds real values, so nothing reads it but wrangler.

A local deploy reads `.env.local`, copied from `.env.local.template`, for the account and the optional
domain and access key. [docs/deploy.md](deploy.md) says what a deploy does.

## Generated files

- `worker-configuration.d.ts`, by `bun run cf-typegen`. The command passes `--env-file .dev.vars.template`,
  so the committed file carries the template's secret names rather than whichever ones a contributor keeps
  in `.dev.vars`. The gate's `cf-typegen:check` row deletes the file, regenerates the whole of it, and runs
  `git diff --exit-code` against it, so it compares bytes against the index rather than trusting the file's
  own header. wrangler carries the runtime half forward from an existing file whenever its
  `// Runtime types generated with workerd@` line matches, which is why the row deletes first, and
  wrangler's own `--check` flag reads only the header lines, which is why it is not used. The diff passes
  `--no-ext-diff`, so a `diff.external` seeded through the environment cannot answer for it. A red row means
  the committed file is stale: stage the regenerated one and run again. If wrangler itself fails, the
  file is absent until `git checkout -- worker-configuration.d.ts` restores it.
- `mise.lock`, by `mise lock` after any edit to `[tools]` in `mise.toml`. A release with no asset digest
  gets its checksums computed once from the artifacts at the recorded urls; a relock keeps them, and
  `mise.toml` says which tool and how, beside its pin. The gate holds each recorded url to the asset name
  `scripts/tools.ts` carries for that tool and platform, so an asset an upstream release renames, or a
  platform added to `lockfile_platforms`, is an edit there in the same diff.
- `CHANGELOG.md`, `package.json`'s version and `.release-please-manifest.json`, by release-please. Nobody
  edits those by hand; [CONTRIBUTING.md](../CONTRIBUTING.md#releases) says why.

## Tests that need a real thing

None. Every test runs against miniflare's bindings with `fetch` stubbed, so no test reaches the
Cloudflare API, a DNS record or an ntfy server.
