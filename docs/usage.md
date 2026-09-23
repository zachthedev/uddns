# Usage

What a token, a device and a caller do with a deployed worker. [docs/deploy.md](deploy.md) is how the
worker gets there, and [docs/faq.md](faq.md) is the setup mistakes a device or a token makes, each with
its fix.

## The Cloudflare API token

1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Profile > API Tokens**.
3. Create a custom token with **Zone → Zone → Read** and **Zone → DNS → Edit**. The worker lists your
   zones to find each hostname's record, so DNS Edit alone is not enough.
4. Scope the token to the zones you want to update. One zone keeps the blast radius small; several are
   supported, but each hostname must match exactly one record across them.
5. Save the token securely. It is a User API Token, not an Account API Token.

## The UniFi device

1. Log in to your [UniFi OS Controller](https://unifi.ui.com/).
2. Go to **Settings > Internet > WAN > Dynamic DNS**.
3. Create a new Dynamic DNS entry:
   - **Service:** `custom`
   - **Hostname:** `subdomain.example.com` or `example.com`
   - **Username:** the deployment's access key if it has one (recommended); any value otherwise, since
     the field is never used for Cloudflare authentication. [docs/deploy.md](deploy.md#on-every-release-with-github-actions)
     says what shape the key has and how to set it.
   - **Password:** the Cloudflare API token above.
   - **Server:** `<worker-name>.<worker-subdomain>.workers.dev/update?ip4=%i&ip6=auto&hostnames=%h`

Omit `https://` from the Server field. Do not percent-encode any of it; inadyn treats `%` sequences as
its own substitution variables.

## The URL contract

The Server field is the worker's interface, and the version number describes it.

- `hostnames=` takes one hostname or a comma-separated list, across zones:
  `hostnames=example.com,*.example.com`. A request carries up to 40 records, and each hostname counts
  once per IP family, so 40 hostnames with `ip4` alone or 20 with both. Batches near that size need the
  paid Workers plan; the free plan's 50-subrequest ceiling fits roughly six records.
- `ip4=` and `ip6=` each take a literal address or `auto`, which uses the connecting IP when it matches
  that family and skips the slot otherwise. Provide at least one.
- `zone=example.com` restricts matching to one zone.
- `ntfy=` sends change notifications to your ntfy server, pasted raw: `ntfy=https://ntfy.sh/my-topic`.
  A notification goes out only when a record changes.

## Audit history

Every DNS change, and every no-op touch of the API, is recorded in D1 with timestamp, hostname, record
type, previous and new IP, caller IP and outcome. Query your own history, scoped to the API token you
authenticate with:

```sh
curl -H "Authorization: Bearer <api-token>" -H "X-Access-Key: <access-key-if-set>" \
  "https://<worker-url>/history?limit=50&hostname=example.com"
```

Cache fast-path hits are not recorded; only requests that reached the DNS API produce events.

Pages are capped at 1000 events. The response carries `data.cursor`, and passing it back as `before=`
continues from where the page ended; it is `null` on the last page. Treat the value as opaque and pass it
verbatim, and keep `hostname=` fixed across a walk, since the cursor is a position in the result set the
page came from. `data.refusedToday` below rides on the first page only, since it describes the day rather
than the page.

The cursor embeds the audit row's id, which is a table-wide sequence. On a deployment several people share,
that lets one of them read the total number of audit rows written before their own, and polling it times
the others' activity. It is aggregate volume, never row contents, and a deployment serving one household
leaks nothing to itself. Signing the cursor would close it, and that needs a deployment secret this worker
does not require: the access key is optional, and the deployments that leave it unset are the shared ones
where this matters.

## Refusals

The history response also carries `data.refusedToday`: the times this token reached past its own
authority today, UTC, and the names it reached for.

```json
{ "total": 47, "distinct": 2, "hostnames": ["typo.example.net", "old.example.net"] }
```

Reaching past authority means a hostname no zone on the token could hold, or a `zone=` naming a zone it
cannot see. A record you have not created yet is **not** counted, nor is a token missing the Zone Read
scope, nor is a token that sees no zones at all: those are setup steps, and counting them would bury the
signal under every new user's first afternoon. The `hostnames` list is your own, so it names exactly which
of your entries to fix. It carries 50 of them, the last to be seen for the first time, since a name refused
again keeps its original place. `distinct` counts every name the tally kept, which itself stops at 200.

Refusals are **counted, not recorded per event**. Any active Cloudflare token can produce them without
limit, so a row apiece would let one caller grow a table every deployment shares. The tally lives in a
Durable Object, one instance per token: requests to an instance serialize, so nothing is lost to a race and
there is no batching window for a caller to time a burst against. Padding a batch changes the count, never
what the count sees. It resets when the UTC day rolls.

That moves per-caller growth rather than removing it: any active token that reaches past its authority
creates one instance. Each holds a single key, keeps at most 200 distinct names, spends at most 699 writes
a day before the tally goes quiet, and clears itself 24 to 48 hours after the last refusal, so the bound is
the reclaim window rather than the decision to count.

Reaching 100 **distinct** names in a day logs a warning to Workers Logs, because `/history` is scoped to
the very token being counted: without the log the tally would only ever be visible to the caller it
describes. Distinct rather than total, because a DDNS client polls every two minutes, so one hostname typed
wrong passes any total given an afternoon. Variety is what a caller sweeping for names it does not hold
produces and a misconfigured one does not.

These limits are worth stating plainly. The tally is keyed on the API token, and a Cloudflare account
issues tokens freely, so an enumerator that rotates tokens before reaching the threshold never trips it.
The per-record IP cache is consulted before zones are read, so for up to its own 30-day TTL after a token
loses a zone, a name it used to hold still answers 200 and counts nothing; that is the record cache, not
the 5-minute zone cache. And a zone added within the last five minutes reads as outside the token's
authority until the zone cache expires. The warning is a cheap way to see a misconfigured or careless
caller, not a control that stops a determined one.

Nothing is counted against a token that sees more than 1000 zones. The zone walk stops at that ceiling, so
a hostname in a zone past it was never looked for rather than reached for.
