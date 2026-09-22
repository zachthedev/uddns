# Claude Code in this repository

Everything a contributor needs is in the human-facing files, and the root [CLAUDE.md](../CLAUDE.md)
carries the rest. This one only points at them.

Read [CONTRIBUTING.md](../CONTRIBUTING.md) and the root [CLAUDE.md](../CLAUDE.md) before changing
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

| File                                                            | Holds                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [CLAUDE.md](../CLAUDE.md)                                       | The gate's composition, the audit policy, generated types and naming   |
| [CONTRIBUTING.md](../CONTRIBUTING.md)                           | Setup, the gate, commit messages, scopes and pull requests             |
| [README.md](../README.md)                                       | What the worker does, deploying it, the URL contract, history and cost |
| [docs/faq.md](../docs/faq.md)                                   | The setup mistakes a device or a token makes, each with its fix        |
| [docs/dependency-overrides.md](../docs/dependency-overrides.md) | Advisory waivers, and re-resolving before pinning anything             |
| [SECURITY.md](../SECURITY.md)                                   | What counts as a vulnerability, and how to report one                  |
