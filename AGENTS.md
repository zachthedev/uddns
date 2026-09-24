# uddns, a bun-service

A Cloudflare Worker that lets UniFi OS devices update Cloudflare DNS records. [README.md](README.md)
says what it does and why.

## Read first

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/dev.md](docs/dev.md) before changing anything. They
bind an agent as they bind a person.

## Verify

- `bun run check` is the gate. Run it before calling a change done, and never run its steps separately
  as a substitute.
- `bun run check:quick` is the gate without its test row, the form the push hook runs.
- `bun run check:rows` prints the rows and runs nothing. A row that is a `package.json` script runs alone
  as `bun run <name>`.

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

Tree rules, each held by the gate or review, with the reason in
[CONTRIBUTING.md#what-never-happens](CONTRIBUTING.md#what-never-happens):

- Never commit a resource ID or a route in `wrangler.jsonc`
  ([why](CONTRIBUTING.md#what-never-happens)).
- Never let a test reach the Cloudflare API, a DNS record or an ntfy server
  ([why](CONTRIBUTING.md#what-never-happens)).
- Never hand-edit a file release-please owns ([why](CONTRIBUTING.md#what-never-happens)).
- Never use a scope outside `.github/commit-scopes.json` ([why](CONTRIBUTING.md#what-never-happens)).
- Never give a tooling change a type that cuts a release ([why](CONTRIBUTING.md#what-never-happens)).
- Never add a check as a workflow step ([why](CONTRIBUTING.md#what-never-happens)).
- Never restate a list another file owns ([why](CONTRIBUTING.md#what-never-happens)).

## Deviations

A comment beside a line that names the handbook records a deliberate deviation. It is a decision, not a
defect.

## Where the rest is

[README.md#documentation](README.md#documentation) indexes every document.
