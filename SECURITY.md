# Security

uddns is a Cloudflare Worker on a public URL. Every request carries a Cloudflare API token, and the
worker uses that token to rewrite DNS records in whatever zones it holds. One deployment serves every
caller, so their cached addresses, audit rows and refusal tallies share one KV namespace, one D1
database and one Durable Object namespace, kept apart by token. This file says what counts as a
vulnerability in that arrangement, and how to report one without publishing it first.

## Reporting

Open a private advisory: <https://github.com/zachthedev/uddns/security/advisories/new>

Never open a public issue for a vulnerability. Everything else belongs in the issue tracker.

A report is most useful with the uddns version, the deployment it ran against, the request that shows
it with the token and the access key removed, and the JSON the worker answered with. Keep a proof of
concept inert: run it with your own token against a zone you hold, and against your own deployment
where you can. A response that shows the hole is reachable proves it as well as a rewrite of somebody
else's record.

## What is supported

The newest release on the [Releases page](https://github.com/zachthedev/uddns/releases). A fix ships
as a new release, not as a patch to an older one, and the release deploys. The deployment at
`ddns.quist.network` runs the newest release. A deployment from a fork is supported while it runs the
same one.

## In scope

- The token boundary. Cache keys, the audit query and the refusal tally all carry the token id, so a
  caller only ever reads or writes what its own token wrote. A record, a cached address, a zone list,
  an audit row or a tally reached through a token that does not hold it is a finding.
- The order of the gates. The rate limiter runs before anything else, and the access key is checked
  before any Cloudflare API call, KV read or D1 query. A request that reaches one of those out of
  order on a deployment that sets `ACCESS_KEY` is a finding, and so is a comparison of the key that
  is not constant-time.
- Credentials in the clear. The API token, the access key and the `ntfy` topic must not appear in a
  log line, an error message, an audit row or another caller's response. Logs redact the query string
  and error messages quote inputs encoded and cut short, so anything that gets past that is a finding.
- The `ntfy` relay. The worker posts a message it built from API-validated DNS data to the https URL
  a caller names, once per request that changed a record, after a successful update through a valid
  token. A way to choose the body, to fire it without a DNS change, or to aim it anywhere the request
  did not name is a finding.
- The release and deploy workflows. A way to deploy a revision `main` does not contain, or a workflow
  that hands a repository secret or write access to a pull request.
- This repository's own tooling, where it runs on a contributor's machine.

## Out of scope

- Cloudflare itself: the Workers runtime, KV, D1, Durable Objects, the rate limiter and the DNS API.
  Report those to Cloudflare.
- Anything the token already allows. A token scoped to a zone can rewrite every record in it through
  the API directly, and the worker adds no permission the token lacks. Scope the token to the zones a
  device updates, as the README says.
- A deployment that leaves `ACCESS_KEY` unset. It answers anyone holding a valid Cloudflare token and
  spends the deployment's quota doing it. The README names the key as the lockdown, and the rate
  limiter is a cost cap rather than a gate.
- The limits the README states plainly, each with the reason it stands: the history cursor carrying a
  table-wide row id, the refusal tally that a caller rotating tokens never trips, the cache windows
  during which a token that lost a zone still answers, and the rate limiter's per-colo precision.
- The UniFi device, its DDNS client and where the controller keeps the password field. Report those
  to Ubiquiti.
- What an ntfy server does with a message. The topic in a caller's own `ntfy=` URL is the only thing
  guarding who reads its notifications, which is ntfy's design and the reason the query string stays
  out of the logs.

## After a report

One person maintains this project, and a first reply takes up to a week. There is no bounty. A report
gets an acknowledgment, a fix, and a credit in the advisory unless you ask to stay anonymous.
