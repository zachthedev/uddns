# uddns, a bun-service

A Cloudflare Worker that lets UniFi OS devices update Cloudflare DNS records. [README.md](README.md)
says what it does and why.

## Read first

Read these before changing anything, in order. They bind an agent as they bind a person.

1. [README.md](README.md)
2. [CONTRIBUTING.md](CONTRIBUTING.md), whole
3. [SECURITY.md](SECURITY.md)
4. [docs/deploy.md](docs/deploy.md)
5. [docs/usage.md](docs/usage.md)

## Verify

- `bun run check` is the gate. Run it before calling a change done, and never run its steps separately
  as a substitute.
- `bun run check:quick` is the gate without its test row, the form the push hook runs.
- `bun run check:rows` prints the rows and runs nothing.
- `bun run check <row>` runs the named rows.

[CONTRIBUTING.md#the-gate](CONTRIBUTING.md#the-gate) says what the rows cover and which checks run in CI
alone.

## Never

Session rules, each with its reason:

- Never run `bun run deploy` unless the user asks. It provisions and changes resources on a real
  Cloudflare account.
- Never read `.dev.vars` or `.env.local`. They hold real secrets. `.dev.vars.template` and
  `.env.local.template` are the files to read.
- Never set `CLOUDFLARE_INCLUDE_PROCESS_ENV` or `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` around the gate.
  Either changes what the `cf-typegen:check` row generates, so a green row goes red for a reason the
  tree does not carry.
- Never carry `BUN_OPTIONS=--preload`, `NODE_OPTIONS=--require` or `JITI_ALIAS` into a gate run. Each
  runs code inside the gate or the tools it calls, so a green result under one proves nothing about the
  tree. The gate clears `BUN_OPTIONS` for every process it starts, after a preload it names has run in the
  gate itself, and documents the other two rather than refusing them, because the environment that carries
  them also carries `PATH`.
- Never run `bun add` or `bun install` with `--minimum-release-age` below the value in `bunfig.toml`, and never
  pass `--ignore-scripts` to work around a blocked install script. A worktree's install and an unread pull request
  branch's install pass `--ignore-scripts` on purpose ([Setup](CONTRIBUTING.md#setup)). The cooldown is the
  window in which a malicious release is pulled, and a version installed under a lowered one lands in `bun.lock`
  for every later install, where no cooldown reads it again.

Tree rules, each held by the gate or review, with the reason in
[CONTRIBUTING.md#what-never-happens](CONTRIBUTING.md#what-never-happens):

- Never commit a resource ID or a route in `wrangler.jsonc`
  ([why](CONTRIBUTING.md#what-never-happens)).
- Never let a test reach the Cloudflare API, a DNS record or an ntfy server
  ([why](CONTRIBUTING.md#what-never-happens)).
- Never hand-edit a file release-please owns ([why](CONTRIBUTING.md#what-never-happens)).
- Never write a `mise.lock` line outside `mise lock`, except a checksum computed as `mise.toml` says
  ([why](CONTRIBUTING.md#what-never-happens)).
- Never merge past a red gate ([why](CONTRIBUTING.md#what-never-happens)).
- Never put a version number in prose ([why](CONTRIBUTING.md#what-never-happens)).
- Never use a scope outside `.github/commit-scopes.json` ([why](CONTRIBUTING.md#what-never-happens)).
- Never give a tooling change a type that cuts a release ([why](CONTRIBUTING.md#what-never-happens)).
- Never add a check as a workflow step ([why](CONTRIBUTING.md#what-never-happens)).
- Never restate a list another file owns ([why](CONTRIBUTING.md#what-never-happens)).

## Deviations

A comment beside a deviating line records a deliberate deviation. It is a decision, not a defect.

## Where the rest is

[README.md#documentation](README.md#documentation) indexes every document.
