## What this changes

<!-- One or two sentences. The why belongs in the commit message. -->

## The gate

Paste the last line the gate prints. `CONTRIBUTING.md` names the command.

<!-- On Windows, point TEMP at a short path first. CONTRIBUTING.md#troubleshooting says why. -->

```text

```

## Tested on

- Deployment: `wrangler dev`, a `*.workers.dev` route, or a custom domain
- Caller: a UniFi device and its version, or `curl`
- `ACCESS_KEY`: set or unset

## Every change

- [ ] Each commit follows Conventional Commits, with a scope from `.github/commit-scopes.json` or none.
- [ ] The documentation says what a user sees, where this changes it.
- [ ] A deviation from the handbook is recorded at its drift site.
- [ ] Each new test states what the code should do, and none of them reaches the Cloudflare API, a DNS
      record or an ntfy server. `fetch` is stubbed and the bindings are miniflare's.

## If this changes a query parameter or a response field

- [ ] `docs/usage.md`'s URL contract and `docs/faq.md` show the new shape.
- [ ] The commit is `feat!` when a Server field that works today stops working. The URL contract is
      the interface the version number describes.
