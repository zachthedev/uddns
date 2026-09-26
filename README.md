# 🌩️ Cloudflare DDNS for UniFi OS

[![codeql](https://github.com/zachthedev/uddns/actions/workflows/codeql.yml/badge.svg)](https://github.com/zachthedev/uddns/actions/workflows/codeql.yml)
[![ci](https://github.com/zachthedev/uddns/actions/workflows/ci.yml/badge.svg)](https://github.com/zachthedev/uddns/actions/workflows/ci.yml)
[![deps](https://github.com/zachthedev/uddns/actions/workflows/deps.yml/badge.svg)](https://github.com/zachthedev/uddns/actions/workflows/deps.yml)
[![cd](https://github.com/zachthedev/uddns/actions/workflows/cd.yml/badge.svg)](https://github.com/zachthedev/uddns/actions/workflows/cd.yml)

A Cloudflare Worker that lets UniFi OS devices (UDM and UXG series) dynamically update DNS A/AAAA records on Cloudflare.

## Features

- **Push notifications** - Per-caller [ntfy](https://ntfy.sh) alerts via the `ntfy=` parameter (self-hosted servers supported), sent only when a DNS record actually changes
- **Multi-hostname updates** - Comma-separated hostnames in a single entry, including across multiple zones, with every record's own outcome reported when a batch fails part-way
- **Multi-zone tokens** - One token can manage records in several zones, with optional `zone=` scoping
- **Dual-stack** - Explicit `ip4`/`ip6` parameters with family-aware `auto`, updating A and AAAA together
- **Record preservation** - Proxy status, TTL, and comments on existing records survive updates
- **Token-only auth** - DNS-scoped API tokens; no account email anywhere
- **Access key lockdown** - Optional `ACCESS_KEY` secret locks the worker to your devices, checked timing-safe before any API call
- **Audit history** - Every DNS change recorded in D1, queryable at `GET /history`, scoped to your own token
- **Built for throughput** - KV-cached fast path, edge rate limiting, and a structured JSON API

## Why Use This?

UniFi Network Application 9.1.92+ ships native Cloudflare DDNS support (Service: Cloudflare, with hostname, zone name, and API token). If all you need is one hostname following your WAN IP, use that. This worker exists for everything the native client doesn't do: the feature list above.

## Setup

Three steps, each in its own document.

1. Deploy the worker to your Cloudflare account: with the button, from the CLI, or from a fork on every
   release. [docs/deploy.md](docs/deploy.md) has all three.

   [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zachthedev/uddns)

2. Create a Cloudflare API token scoped to the zones the worker updates.
3. Point each UniFi device's Dynamic DNS entry at the worker. The Server field is the worker's URL
   contract, and [docs/usage.md](docs/usage.md) spells out every parameter it takes, the token's scopes,
   and the audit history a caller can read back.

The committed `wrangler.jsonc` carries no resource IDs and no domain. wrangler binds the KV namespace and
the D1 database by name at deploy time, and the custom domain comes from the machine that deploys.
Notifications need no deployment configuration: callers pass their own ntfy target with the `ntfy=`
query parameter.

## ⚡ **Throughput & Cost**

The worker is built to take heavy public traffic cheaply:

- **Steady-state polling is API-free.** With the access key configured, a request whose records all match the KV cache answers with zero Cloudflare API calls: one worker invocation, one rate-limit check, and one KV read per record. A device polling every 2 minutes costs ~22k invocations and ~44k KV reads per month per record pair, far inside the Workers paid plan's included 10M requests and 10M KV reads.
- **Cache misses stay lean.** Token verification and the zone list (cached per token for 5 minutes) front a parallel record lookup; only records whose DNS content actually differs trigger an update call. Audit writes and notifications ride `ctx.waitUntil` after the response.
- **Strangers are throttled at the edge.** The rate limiter (50 requests/minute per IP, per colo) returns 429 before authentication runs, and an unauthenticated or wrong-key request never reaches the Cloudflare API, KV, or D1. Enforcement is Cloudflare's best-effort, eventually-consistent counter, a cost cap against sustained abuse rather than a precise gate; short bursts can overshoot.
- **Ballpark beyond included quotas** (Workers paid plan pricing): ~$0.30 per additional 1M requests, ~$0.50 per additional 1M KV reads; D1 audit volume is negligible by design (rows only on actual DNS-touching events). A refusal costs one Durable Object call and up to two of its storage writes; `GET /history` costs one read-only call.

## 🛠️ **Testing & Troubleshooting**

Using this worker with various Ubiquiti devices and different UniFi software versions can introduce unique challenges. If you encounter issues, start with [docs/faq.md](docs/faq.md). If you don't find a solution, you can ask a question on the [discussions page](https://github.com/zachthedev/uddns/discussions/new?category=q-a). If the problem persists, please raise an issue [here](https://github.com/zachthedev/uddns/issues).

## Documentation

`bun run check` is the gate; [CONTRIBUTING.md](CONTRIBUTING.md#the-gate) says what it covers.

| File                               | Holds                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| [docs/usage.md](docs/usage.md)     | The API token, the device entry, the URL contract, audit history and refusals         |
| [docs/deploy.md](docs/deploy.md)   | Deploying to your own account, how a release deploys, and operating it                |
| [docs/faq.md](docs/faq.md)         | The setup mistakes a device or a token makes, each with its fix                       |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to set up, change, check and release this repository, indexed by its own headings |
| [SECURITY.md](SECURITY.md)         | What counts as a vulnerability here, and how to report one                            |
| [CHANGELOG.md](CHANGELOG.md)       | Every release, written by release-please                                              |

## 🙏 **Acknowledgments**

This project began as a fork of [willswire/unifi-ddns](https://github.com/willswire/unifi-ddns) and has since been rewritten end to end. Thanks to Will Walker for the original worker that made UniFi-to-Cloudflare DDNS approachable in the first place.

## License

[MIT](LICENSE).
