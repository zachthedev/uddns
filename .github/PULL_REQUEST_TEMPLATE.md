## What this changes

<!-- One or two sentences. The why belongs in the commit message. -->

## The gate

Paste the test summary `bun run check:all` ends with.

<!-- On Windows, point TEMP at a short path first. CONTRIBUTING.md says why. -->

```text

```

## Tested on

- Deployment: `wrangler dev`, a `*.workers.dev` route, or a custom domain
- Caller: a UniFi device and its version, or `curl`
- `ACCESS_KEY`: set or unset

## Every change

- [ ] Each new test states what the code should do, and none of them reaches the Cloudflare API, a DNS
      record or an ntfy server. `fetch` is stubbed and the bindings are miniflare's.
- [ ] The README says what a caller sees, where this changes it.

## If this changes a query parameter or a response field

- [ ] The README's Server field and `docs/faq.md` show the new shape.
- [ ] The commit is `feat!` when a Server field that works today stops working. The URL contract is
      the interface the version number describes.
