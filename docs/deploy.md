# Deploying

How a copy of this worker reaches a Cloudflare account, how a release reaches the production
deployment, and what to watch once it runs. [docs/usage.md](usage.md) is what a device and a token do
with the URL that comes out of this.

## Your own deployment

Three ways, each ending at a `*.workers.dev` URL, or a custom domain where one is set. The committed
`wrangler.jsonc` carries no resource IDs and no domain: wrangler binds the KV namespace and the D1
database by name at deploy time, reuses the ones the deployed worker already holds under those binding
names, and creates them where no such worker exists.

### With the button

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zachthedev/uddns)

1. Click the button and complete the deployment. The KV namespace and the D1 audit database are created
   on this first deploy.
2. Note the `*.workers.dev` route.
3. Apply the D1 migrations afterwards. The button flow creates the database but runs no migration, so
   `/history` and audit logging stay dark until you do. The other two paths run the migrations
   themselves. This step needs [Bun](https://bun.sh) and a clone of this repository with its install, so
   the wrangler it starts is the one `bun.lock` pins. `--no-install` keeps bunx from fetching one from
   the registry:
   ```sh
   bun install --frozen-lockfile
   bun x --no-install wrangler d1 migrations apply AUDIT_DB --remote
   ```

### With the CLI

Requires [Bun](https://bun.sh).

1. Clone this repository and run `bun install`. Every wrangler command below runs the wrangler that
   install puts in the clone, and `--no-install` keeps bunx from fetching one from the registry.
2. Log in and create the D1 audit database once. The deploy applies its migrations before uploading, and
   the migration step resolves the database by name without creating it:
   ```sh
   bun x --no-install wrangler login
   bun x --no-install wrangler d1 create d1-uddns-audit-prod
   ```
3. Deploy. The KV namespace is created on this first deploy, and every later deploy reuses both resources
   by their binding names:
   ```sh
   bun run deploy
   ```
   On an interactive first deploy wrangler also writes the IDs it created or connected into
   `wrangler.jsonc`. Discard that change with `git checkout -- wrangler.jsonc`; the committed file binds
   by name.
4. Note the `*.workers.dev` route.

With more than one Cloudflare account on the login, copy `.env.local.template` to `.env.local`
(gitignored) and set the account there. The same file takes the optional custom domain and access key
for local deploys; the template names each and says what shape it has.

`bun run deploy` is `scripts/deploy.ts`, the one deploy path for a machine and for CI. It applies the D1
migrations, deploys the committed `wrangler.jsonc`, and syncs the access key to the worker as a secret
when the environment carries one. The custom domain, when set, reaches wrangler as `--domain`.

### On every release, with GitHub Actions

Fork this repository, create the D1 audit database once (the CLI path, step 2), then create an
environment named `production` under the fork's Settings. The deploy job in
[`.github/workflows/cd.yml`](../.github/workflows/cd.yml) declares that environment and reads
everything from it, and the job's `env:` block names each value. Every value falls in one of three
classes. A public identifier is a variable. A private identifier or a credential is a secret, so the run
log masks it. `CLOUDFLARE_ACCOUNT_ID` and the optional `CUSTOM_DOMAIN` are private identifiers, and
`CLOUDFLARE_API_TOKEN` and the optional `ACCESS_KEY` are credentials, so the fork sets all four as
secrets of the `production` environment, each with `gh secret set <NAME> --env production` from the
fork's clone. No resource ID goes into a file.

Releases deploy, so a push to `main` reaches production only through the releaser app. Before the first
release, create a GitHub App for the fork, install it on the fork, and create an environment named
`release-pr` holding the app's client id as the variable `RELEASER_CLIENT_ID`, a public identifier, and
its private key as the secret `RELEASER_PRIVATE_KEY`. The `release-pr` job reads both. Without them, it
fails on every push to `main`, and the deploy job never runs. Until the app is in place, a manual run of
the `cd` workflow deploys: `gh workflow run cd.yml` from the fork's clone, or Run workflow on the
workflow's page ([Releasing deploys](#releasing-deploys)).

Give each environment a deployment branch policy, so a workflow pushed on any other branch cannot read
its secrets. `production` admits `main` and the release tags, `v*`, which a manual deploy run against a
tag needs ([Operating it](#operating-it)). `release-pr` admits `main` alone.

The access key is 32 hexadecimal characters (16 random bytes). One comes from `openssl rand -hex 16`,
or on a machine without openssl from
`bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'))"`. Set it
with `gh secret set ACCESS_KEY --env production` from the fork's clone. The next deploy syncs it to the
worker. Then put the same value in every device's DDNS Username. Keep that order: the worker refuses
every other value the moment the deploy finishes, and a device still sending one gets 401 until its
Username changes.

Notifications need no deployment configuration: callers pass their own ntfy target with the `ntfy=`
query parameter.

### Naming

Cloudflare resources follow `<type>-<project>-<purpose>-<env>`: `kv-uddns-cache-prod`,
`kv-uddns-cache-dev`, `d1-uddns-audit-prod`. Binding names in code stay short (`DDNS_KV`, `AUDIT_DB`).
The D1 name comes from `wrangler.jsonc` and follows the convention on its own. A KV namespace wrangler
creates on a first deploy is titled `uddns-ddns-kv`, its `<worker>-<binding>` default, and the
convention-named title is applied by renaming in the dashboard; titles are cosmetic, and wrangler matches
on the binding name. The maintainer's production worker is named `uddns` and is served at a custom domain.

## Releasing deploys

Releases deploy, and pushes do not. A deploy applies the D1 migrations, so tying one to a release means
the schema in production corresponds to a revision you can check out, instead of to whichever commit
landed last.

[release-please](https://github.com/googleapis/release-please) drives it. Once a releasable change lands
on `main`, it opens one pull request and keeps it up to date, carrying the version bump and the
changelog entries for everything landed since the last release. `pull-request-title-pattern` in
`release-please-config.json` sets its title. Nothing ships while it sits there. Merging it is the
release: the merge commit is tagged and a draft release is created, the `publish` job waits for the
`release` environment's reviewer and flips the draft public, and the deploy runs against that revision.
[CONTRIBUTING.md](../CONTRIBUTING.md#releases) says which commit types make a change releasable.

The release pull request is opened by the `zachthedev-releaser` app, so it gets the same checks as every
other pull request. That is what the app is for: GitHub holds the CI run for a pull request opened by
`GITHUB_TOKEN` at `action_required` with no jobs, until somebody approves it by hand. No check is waived
for it, and the pull request's own gate run is what judged the merge.

`cd.yml` answers to a push to `main` and to a manual run, with no tag trigger, so a tag pushed by hand
deploys nothing. The manual run deploys a revision without releasing one; a revision that never passed a
pull request is the owner's act.

## Operating it

- Logs are Workers Logs with the query string redacted, because it carries the caller's ntfy topic and
  the hostnames it manages. The handler logs every request the rate limiter admits and its outcome; a
  flood the limiter turns away writes no line.
- The `audit` workflow runs the `audit` script over the whole lock file, and zizmor's online audits over the
  pinned actions, once a day. A red run is a report, never a check: it means work to pick up, a
  direct bump through Renovate's next security fix or a transitive one by hand. Between an advisory
  landing and a fix, the worker runs vulnerable code, and that run is the only thing that says so.
  Somebody has to read it.
- The scheduled workflows depend on Renovate staying alive. GitHub disables a `schedule:` trigger in a
  public repository after 60 days with no repository activity, and Renovate's branch pushes are that
  activity. If Renovate stops, the dependency update and audit schedules go quiet together and are then
  disabled. GitHub sends one email about the disable, to the last committer, and nothing after it, so
  check Renovate is still opening pull requests. `gh workflow enable` turns a disabled workflow back on.
- Rollback is `wrangler rollback` from a clone logged in to the account, or Rollback on the Worker's
  Deployments page in the Cloudflare dashboard. It makes one of the Worker's 100 most recent versions the
  active deployment at once, with no build and no migration. D1 and KV keep their data, so the older
  code runs against the newer schema, and a migration that drops or rewrites a column takes that
  rollback away. Cloudflare refuses a rollback past a Durable Object class change, such as a class added
  or renamed in `wrangler.jsonc`. A manual run of the deploy workflow against the last good tag is the
  fallback for a version older than those. It applies migrations and never reverts one.
- A caller reaching past its token's authority for 100 distinct names in a day logs a warning.
  [docs/usage.md](usage.md#refusals) says what counts and what the warning can and cannot catch.
