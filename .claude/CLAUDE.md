# Claude Code in this repository

Everything a contributor needs is in the human-facing files, and the root [AGENTS.md](../AGENTS.md)
carries the rest. This one only points at them.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) and the root [AGENTS.md](../AGENTS.md) before changing
anything.

## The rules that do not bend

- **The gate is `bun run check`.** Run it before calling a change done, and never run its steps
  separately as a substitute.
- **A test never reaches the Cloudflare API, a DNS record or an ntfy server.** `fetch` is stubbed and
  the bindings are miniflare's. Never run `bun run deploy` unless the user asks. It provisions and
  changes resources on a real Cloudflare account.
- **Never read `.dev.vars`.** It holds real secrets. `.dev.vars.template` is the file to read.
- **Commit scopes come from `.github/commit-scopes.json`.** commitlint enforces them. Omit the scope
  rather than invent one.
- **release-please owns the version in `package.json`, `.release-please-manifest.json` and
  `CHANGELOG.md`.** Never edit any of the three by hand.
- **`wrangler.jsonc` carries no resource IDs and no route.** wrangler reuses the KV namespace and D1
  database the deployed Worker holds under the binding names, and creates them where no such Worker
  exists. An ID committed there would pin every fork to one account, and `tests/wrangler-config.node.test.ts`
  refuses one; the custom domain arrives from `CUSTOM_DOMAIN` at deploy time for the same reason.

## The documentation

| File                                  | Holds                                                                 |
| ------------------------------------- | --------------------------------------------------------------------- |
| [AGENTS.md](../AGENTS.md)             | The gate's composition, the audit policy and generated types          |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | The gate, commit messages, where code goes, dependencies and releases |
| [README.md](../README.md)             | What the worker does, and the documentation table indexing the rest   |
| [docs/dev.md](../docs/dev.md)         | Prerequisites, the first run, running it locally and generated files  |
| [docs/deploy.md](../docs/deploy.md)   | Deploying to your own account, how a release deploys, operating it    |
| [docs/usage.md](../docs/usage.md)     | The token, the device entry, the URL contract and audit history       |
| [docs/faq.md](../docs/faq.md)         | The setup mistakes a device or a token makes, each with its fix       |
| [SECURITY.md](../SECURITY.md)         | What counts as a vulnerability, and how to report one                 |
