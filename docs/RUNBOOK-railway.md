# Runbook: Railway project `threadline`

Nov 7, 2026 · task T15 of [the infra plan](plans/0001-infra-implementation.md) · implements
[ADR-0001](adr/0001-infrastructure.md) action items 1–3 and the Railway half of 7

This runbook lists every Railway setting Threadline depends on, the exact commands that apply it, how to check it
worked, how to undo it, and how to rebuild the project from nothing. **Nothing in it has been applied yet.**
Each step that changes Railway waits on an owner gate:

| Gate | Needed for | State on 2026-11-07 |
|---|---|---|
| **G1 · Domain** | §3 domains, §4 URL variables, §7 `nodes.` domain | Open: no domain bought |
| **G4 · Railway changes** | Every step in §3–§8 | Open: an agent may read Railway state, not change it |

When a step is applied, fill in its row in [§10 Change log](#10-change-log) in the same PR or commit.

## Contents

1. [Current state](#1-current-state-read-only-2026-11-07)
2. [Before you start](#2-before-you-start)
3. [Custom domains on `web`](#3-custom-domains-on-web-g1-g4)
4. [URL variables](#4-url-variables-g1-g4)
5. [Postgres PITR and scheduled backups](#5-postgres-pitr-and-scheduled-backups-g4)
6. [Tracing](#6-tracing-g4)
7. [Empty `node-gateway` service](#7-empty-node-gateway-service-g1-g4)
8. [`staging` environment](#8-staging-environment-g4)
9. [Rebuild from nothing](#9-rebuild-the-project-from-nothing)
10. [Change log](#10-change-log)
11. [Settings register](#11-settings-register-target-state)

Order matters in two places: **§3 and §4 before the first live post** (a tracked link minted on the
`up.railway.app` host stays in that Reddit comment forever), and **§5 before any migration that drops data**.

## 1. Current state (read-only, 2026-11-07)

Read with `railway list`, the Railway MCP read tools (`describe-environment`, `get-service-config`, `list-domains`,
`get-tracing`) and `railway postgres pitr status|schedule list|backup list`. Variable *values* were not read.

| | Value |
|---|---|
| Project | `threadline`, id `01f8ca60-b3ba-4633-9024-ccabae87a7db`, workspace "My Projects" |
| Environments | `production` only (id `654a4810-fb8a-4398-890d-c340d84eeecf`) |
| Region | `us-east4-eqdc4a`, 1 replica per service |

| Service | Id | Source / build | Domains | Variables set (names only) |
|---|---|---|---|---|
| `web` | `36cfb471-536c-461c-8ab1-221064d91019` | `railway up`, Railpack | `web-production-e42e5.up.railway.app` → :3000; no custom domain | `APP_ENCRYPTION_KEY`, `APP_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST`, `AUTH_URL`, `DATABASE_URL`, `ERP_API_URL`, `LLM_MODEL_DRAFT`, `LLM_MODEL_FAST`, `PORT`, `REDIS_URL`, `TRACKING_HOST` |
| `worker` | `271d9d7e-d280-45fa-b143-30bd809238dc` | `railway up`, Railpack | none | `APP_ENCRYPTION_KEY`, `APP_URL`, `AUTH_SECRET`, `DATABASE_URL`, `LLM_MODEL_DRAFT`, `LLM_MODEL_FAST`, `REDIS_URL`, `SERVICE_ROLE`, `TRACKING_HOST` |
| `Postgres` | `f562a9a6-675b-4336-bf6a-d1e55abc3824` | image `ghcr.io/railwayapp-templates/postgres-ssl:18` | none (no TCP proxy) | template defaults |
| `Redis` | `ef6bfaf6-e4c4-4beb-b9fc-d7bd35406e24` | image `redis:8.2` | none (no TCP proxy) | template defaults |

| Volume | Id | Mounted on | Size |
|---|---|---|---|
| `postgres-volume` | `0033b471-1c0b-4b3d-8dd3-233e4e1b4bea` | `Postgres:/var/lib/postgresql/data` | 50 GB |
| `redis-volume` | `bcf02d5e-aa8b-4d78-94be-9411b591c3bb` | `Redis:/data` | 50 GB |

| Setting | State |
|---|---|
| Postgres PITR | **off** (`enabled: false`, `bucketWired: false`) |
| Backup schedule | **none** (`schedule list` → `[]`); no backups exist (`backup list` → `[]`) |
| Tracing | **off** on all four services (traced and auto-instrumentation both false) |
| `node-gateway` service | does not exist |
| `staging` environment | does not exist |

Findings that change the steps below:

- `TRACKING_HOST` is read by **both** `web` (`packages/db/src/repos/analytics.ts`, link list display) **and**
  `worker` (`apps/worker/src/queues/draft-generate.ts`, which mints the link that goes into a Reddit comment). It must
  be changed on both services, worker first matters most.
- `REDDIT_REDIRECT_URI` is not set on Railway, so the Reddit OAuth callback is derived from `APP_URL`
  (`apps/web/lib/reddit-oauth.ts`). Changing `APP_URL` changes the redirect URI Reddit must accept (§4).
- `ERP_API_URL` on `web` turns on sign-in with Recycle Servers ERP credentials (`apps/web/lib/erp-auth.ts`).
  Unset it to go back to magic link / Google only.
- No `/healthz` route exists yet; T16 adds it. Until then, check `web` with `/login`.

## 2. Before you start

```bash
# CLI 5.57.9 is installed; §6 needs `railway trace`, which this version lacks. Upgrade first:
railway upgrade --yes
railway whoami

# Work from a scratch directory so the repo is never linked by accident.
mkdir -p ~/railway-threadline && cd ~/railway-threadline
railway link --project 01f8ca60-b3ba-4633-9024-ccabae87a7db --environment production

export DOMAIN=example.com          # G1: the bought domain, no scheme, no trailing dot
export P=01f8ca60-b3ba-4633-9024-ccabae87a7db
```

Rules while running this runbook:

- Never print variable values into a ticket, chat or log. `railway variable list --json` and `--kv` print raw
  secrets; use the dashboard or `--json | jq 'keys'` when you need names.
- Prefer `--skip-deploys` when setting several variables, then redeploy once.
- Every command takes explicit `--environment` and `--service` so a mislinked directory cannot hit the wrong place.
- The Railway MCP tools named in each step do the same thing as the CLI line; use either.

## 3. Custom domains on `web` (G1, G4)

Target: `app.<domain>` (the product) and `go.<domain>` (tracked links, `/r/<slug>`) both route to `web` on port 3000.
Both hosts serve the whole Next.js app; only `/r/*` is ever handed out on `go.`.

```bash
railway domain "app.$DOMAIN" --service web --environment production --project "$P" --port 3000 --json
railway domain "go.$DOMAIN"  --service web --environment production --project "$P" --port 3000 --json
```

Dashboard equivalent: `web` → Settings → Networking → Custom Domain, target port 3000. (The MCP `generate-domain`
tool makes `*.up.railway.app` domains only; use the CLI or dashboard for custom domains.)

Each command prints two DNS records. Add **both** at the DNS provider exactly as shown:

| Type | Name | Value |
|---|---|---|
| `CNAME` | `app` | the `*.up.railway.app` target printed for `app.<domain>` |
| `TXT` | the `_railway-verify…` name printed | the verification token printed |
| `CNAME` | `go` | the target printed for `go.<domain>` |
| `TXT` | the name printed | the token printed |

If the DNS provider is Cloudflare, set the `CNAME`s to **DNS only** (grey cloud) until Railway shows the
certificate as issued; proxied records block certificate issuance.

Check:

```bash
railway domain status "app.$DOMAIN" --service web --environment production --project "$P"
railway domain status "go.$DOMAIN"  --service web --environment production --project "$P"
dig +short CNAME "go.$DOMAIN"
curl -sS -o /dev/null -w '%{http_code}\n' "https://app.$DOMAIN/login"      # 200
```

If the certificate is stuck: `railway domain certificate retry "go.$DOMAIN" --service web`.

**Done-when check (tracked link redirects).** Find a slug that exists in production:

```bash
railway connect Postgres --environment production --ssh    # SSH tunnel; never add a TCP proxy for this
#   SELECT slug, "destinationUrl" FROM "TrackedLink" ORDER BY "createdAt" LIMIT 5;
```

Production is not guaranteed to hold the dev seed. If the query returns `pm6tea` (the first seed link), use it;
if it returns nothing, create a link in the app (Analytics → Tracked links → New link) and use its slug. Then:

```bash
curl -sS -o /dev/null -D - "https://go.$DOMAIN/r/<slug>" | grep -iE '^(HTTP|location|set-cookie|cache-control)'
# HTTP/2 302
# location: <destinationUrl>?utm_source=reddit&utm_medium=…
# set-cookie: tl_vid=…; Secure
# cache-control: no-store
```

A `404 Link not found` means the host works and the slug does not exist. Any other status means the domain is
not routed to `web`. Each check click is counted as a real click; that is acceptable for one or two requests.

Rollback: `railway domain delete "go.$DOMAIN" --service web --environment production --yes`. **Do not delete `go.`
after the first live post**: links in Reddit comments would break forever.

## 4. URL variables (G1, G4)

| Service | Variable | New value | Was |
|---|---|---|---|
| `worker` | `TRACKING_HOST` | `https://go.<domain>` | the `up.railway.app` URL (check in the dashboard) |
| `web` | `TRACKING_HOST` | `https://go.<domain>` | same |
| `web` | `APP_URL` | `https://app.<domain>` | `https://web-production-e42e5.up.railway.app` (expected) |
| `worker` | `APP_URL` | `https://app.<domain>` | same |
| `web` | `AUTH_URL` | `https://app.<domain>` | same |
| `web` | `AUTH_TRUST_HOST` | `true` (unchanged) | `true` |

**First**, because `APP_URL` drives the Reddit OAuth callback: in the Reddit app settings
(reddit.com/prefs/apps) add the redirect URI `https://app.<domain>/api/auth/reddit/callback`. Reddit apps accept
one redirect URI; switch it in the same minute you redeploy `web`, or set `REDDIT_REDIRECT_URI` explicitly to keep
the old one working until you switch. If Google sign-in is configured later, add the same host to its authorized
redirect URIs (`https://app.<domain>/api/auth/callback/google`).

```bash
railway variable set "TRACKING_HOST=https://go.$DOMAIN" "APP_URL=https://app.$DOMAIN" \
  --service worker --environment production --project "$P" --skip-deploys --json
railway variable set "TRACKING_HOST=https://go.$DOMAIN" "APP_URL=https://app.$DOMAIN" "AUTH_URL=https://app.$DOMAIN" \
  --service web --environment production --project "$P" --skip-deploys --json
railway redeploy --service worker --environment production --yes
railway redeploy --service web --environment production --yes
```

MCP equivalent: `set-variables` with `skipDeploys`, then `redeploy`.

Check:

```bash
railway variable list --service worker --environment production --json | jq '{TRACKING_HOST, APP_URL}'
railway variable list --service web --environment production --json | jq '{TRACKING_HOST, APP_URL, AUTH_URL}'
# sign in at https://app.$DOMAIN/login; the magic link in the email must point at app.<domain>
# the Analytics → Tracked links panel shows go.<domain>/r/… for new links
```

(Those `jq` filters print only the three URL variables, never a secret.)

The per-workspace `settings.shortHost` (Settings in the app) overrides the displayed host; leave it empty unless a
workspace has its own short domain.

Rollback: set the previous values again and redeploy. Links minted while the new host was live keep pointing at it,
which is why §3 must be stable before §4.

## 5. Postgres PITR and scheduled backups (G4)

PITR makes the Postgres image archive every WAL segment to a Railway bucket with pgBackRest (weekly full, daily
differential, last 4 fulls kept: about 4 weeks of restore window). Enabling it **restarts Postgres once**; `web` and
`worker` reconnect on their own. Do it in a quiet hour.

```bash
railway postgres pitr status --service Postgres --environment production --project "$P" --json   # before
railway postgres pitr enable --service Postgres --environment production --project "$P"
railway postgres pitr status --service Postgres --environment production --project "$P" --json   # enabled: true, bucketWired: true
```

Wait until the archiver is healthy and the first base backup exists (the image takes it on its own), then add the
volume backup schedule. The card asks for a daily schedule; weekly is added so a bad day cannot age out every copy:

```bash
railway postgres pitr schedule set --daily --weekly --service Postgres --environment production --project "$P"
railway postgres pitr schedule list --service Postgres --environment production --project "$P" --json
railway postgres pitr backup create --name t15-first --service Postgres --environment production --project "$P"
railway postgres pitr backup list --service Postgres --environment production --project "$P" --json
```

Dashboard equivalent: `Postgres` → Backups → Enable point-in-time recovery; Backups → Schedule → Daily + Weekly.

**Done-when check (a restore point is listed):** the Backups tab shows the PITR datetime picker with a window that
starts at the first base backup, and `backup list` shows `t15-first`. Record the earliest restorable time in §10.

Restore (never over the live service; it always creates a new one):

```bash
railway postgres pitr restore --at 2026-11-08T03:00:00Z --new-service-name postgres-restore-test \
  --service Postgres --environment production --project "$P"
```

Then point a scratch copy of the app at the new service, check row counts against production, time the whole thing
(M8 target: under 15 minutes; T40 runs the formal drill), and delete the restored service. Never repoint
production `DATABASE_URL` at a restored service without the owner.

Off-Railway copy: T17 adds a nightly `pg_dump -Fc` cron service to an S3-compatible bucket. PITR and volume
backups live inside Railway; the T17 dump is the copy that survives a Railway account problem.

Rollback: `railway postgres pitr disable --service Postgres --environment production --yes` (restarts Postgres;
existing backups stay); `railway postgres pitr schedule set --none` (existing backups stay).

## 6. Tracing (G4)

Turns on edge tracing for HTTP requests and, on the next deploy, injects the `OTEL_*` variables
(`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`).
T33 adds the OTel SDK that reads them; until it lands, `web` gets edge spans only and `worker` (no domain) gets none.
Leave automatic instrumentation **off**: T33's SDK is the one source of spans, and two instrumentations double-count.

```bash
railway trace enable --service web    --environment production
railway trace enable --service worker --environment production
railway redeploy --service web --environment production --yes      # picks up OTEL_* variables
railway redeploy --service worker --environment production --yes
```

MCP equivalent: `set-service-tracing` (`tracingEnabled: true`, `autoInstrumentationEnabled: false`) per service.
Dashboard: service → Settings → Observability → Traced.

Check: `get-tracing` shows `tracingEnabled: true` for `web` and `worker`; `list-traces` for `web` shows spans for
`GET /login` within a minute of loading it; `railway variable list --service web --json | jq 'keys | map(select(startswith("OTEL_")))'`
lists the injected names. Do not paste `OTEL_EXPORTER_OTLP_HEADERS` anywhere: it holds the ingest token.

`node-gateway` gets the same switch in §7. Postgres and Redis stay untraced.

After `railway upgrade`, confirm the subcommands with `railway trace --help`; the commands above follow the
current Railway docs (`railway trace enable --service <name>`), which CLI 5.57.9 predates.

Rollback: `railway trace disable --service <name> --environment production` (or the MCP tool with
`tracingEnabled: false`), then redeploy.

## 7. Empty `node-gateway` service (G1, G4)

An empty service now, so the domain, certificate and variables exist before T16 points a source at it. It deploys
nothing until T16 connects the repo with the `gateway` Docker target.

```bash
# `railway add` has no --project/--environment flags: it uses the link from §2 (production)
railway add --service node-gateway \
  --variables "SERVICE_ROLE=gateway" --variables "PORT=8080" --json
railway domain "nodes.$DOMAIN" --service node-gateway --environment production --project "$P" --port 8080 --json
# add the printed CNAME + TXT for `nodes` at the DNS provider, as in §3

# shared secret for web → gateway VNC requests and agent VNC tokens (ADR §3.5). Generate once, never echo it:
openssl rand -base64 32 | railway variable set GATEWAY_INTERNAL_SECRET --stdin \
  --service node-gateway --environment production --project "$P" --skip-deploys --json
# one token per browser node; the DB keeps only its sha256 (BrowserNode.tokenHash). Keep a copy for the node's env file:
openssl rand -base64 32 > ~/browser-1.node-token && chmod 600 ~/browser-1.node-token
railway variable set NODE_TOKEN_BROWSER_1 --stdin --service node-gateway --environment production \
  --project "$P" --skip-deploys --json < ~/browser-1.node-token

railway variable set \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' 'REDIS_URL=${{Redis.REDIS_URL}}' \
  'APP_ENCRYPTION_KEY=${{worker.APP_ENCRYPTION_KEY}}' \
  --service node-gateway --environment production --project "$P" --skip-deploys --json

# web and worker reach the gateway over the private network only
railway variable set 'NODE_GATEWAY_URL=http://node-gateway.railway.internal:8080' \
  'GATEWAY_INTERNAL_SECRET=${{node-gateway.GATEWAY_INTERNAL_SECRET}}' \
  --service web --environment production --project "$P" --skip-deploys --json
railway variable set 'NODE_GATEWAY_URL=http://node-gateway.railway.internal:8080' \
  --service worker --environment production --project "$P" --skip-deploys --json

railway trace enable --service node-gateway --environment production
```

Notes:

- Use single quotes around `${{…}}` so the shell does not expand them; Railway resolves the reference.
- `APP_ENCRYPTION_KEY` must be the same key as `worker` (the gateway decrypts proxy credentials). The reference
  keeps one source of truth. If `worker`'s value is itself a reference, point at the same source instead.
- Check whether `web`/`worker` `DATABASE_URL` and `REDIS_URL` are references (`${{Postgres.DATABASE_URL}}`) in the
  dashboard's raw editor; if they are literal URLs, prefer switching them to references in the same change window.
- The gateway must listen on `::` (dual stack) port 8080 so both the public domain and
  `node-gateway.railway.internal` reach it. T11/T16 own that code and the healthcheck.
- Never add a TCP proxy to `node-gateway`, `Postgres` or `Redis`. The gateway takes WSS only, on `nodes.<domain>`.
- `CLOAKBROWSER_LICENSE_KEY` never goes on Railway: it lives only in the node's env file (ADR, T32).
- Another node later: add `NODE_TOKEN_BROWSER_2`, and nothing else on Railway.

Check: `describe-environment` lists `node-gateway` (no deployment yet is expected), `list-domains` shows
`nodes.<domain>` with target port 8080, `domain status` shows the certificate issued, and
`railway variable list --service node-gateway --json | jq 'keys'` shows exactly `APP_ENCRYPTION_KEY`, `DATABASE_URL`,
`GATEWAY_INTERNAL_SECRET`, `NODE_TOKEN_BROWSER_1`, `PORT`, `REDIS_URL`, `SERVICE_ROLE` (plus Railway's own and
`OTEL_*` after tracing). `curl https://nodes.$DOMAIN/` returns Railway's "no deployment" page until T16 deploys.

Rollback: `railway service delete --service node-gateway --environment production --yes` (also removes its domain;
delete the `nodes` DNS records) and delete `NODE_GATEWAY_URL` / `GATEWAY_INTERNAL_SECRET` from `web` and `worker`.

## 8. `staging` environment (G4)

A full copy of the project's shape with its own data and secrets (ADR: own Postgres, Redis, Reddit app and node
token). T34 runs the browser-fallback flow against it.

```bash
railway environment new staging --duplicate production --json
railway environment list --json
```

Duplicating copies services, their config and variables; Postgres and Redis get **new, empty volumes**. Then, in
`staging` only:

1. Replace every secret copied from production. Never share `APP_ENCRYPTION_KEY` or `AUTH_SECRET` across
   environments:

   ```bash
   # web, worker and node-gateway share one APP_ENCRYPTION_KEY within staging; worker holds it, the others reference it
   openssl rand -base64 32 | railway variable set APP_ENCRYPTION_KEY --stdin --service worker --environment staging --skip-deploys
   railway variable set 'APP_ENCRYPTION_KEY=${{worker.APP_ENCRYPTION_KEY}}' --service web --environment staging --skip-deploys
   openssl rand -base64 32 | railway variable set AUTH_SECRET --stdin --service web --environment staging --skip-deploys
   railway variable set 'AUTH_SECRET=${{web.AUTH_SECRET}}' --service worker --environment staging --skip-deploys
   openssl rand -base64 32 | railway variable set GATEWAY_INTERNAL_SECRET --stdin --service node-gateway --environment staging --skip-deploys
   openssl rand -base64 32 > ~/browser-staging.node-token && chmod 600 ~/browser-staging.node-token
   railway variable set NODE_TOKEN_BROWSER_1 --stdin --service node-gateway --environment staging --skip-deploys < ~/browser-staging.node-token
   ```

2. Point `DATABASE_URL` / `REDIS_URL` at the staging `Postgres` / `Redis` (references resolve per environment, so
   `${{Postgres.DATABASE_URL}}` already does; a copied literal URL would point at **production** and must be
   replaced).
3. Domains: give staging `web` a Railway-generated domain (`railway domain --service web --environment staging`) and
   set `APP_URL`, `AUTH_URL` and `TRACKING_HOST` to it. Do not reuse `app.`/`go.`. When T34 needs a staging
   gateway, add `nodes-staging.<domain>` to staging `node-gateway` (proposal; owner may prefer another name).
4. Reddit: a separate Reddit app for staging (its own `REDDIT_CLIENT_ID`/`SECRET` and redirect URI) and only a
   private test subreddit. Leave `ANTHROPIC_API_KEY` unset unless the owner wants paid LLM calls in staging.
5. Deploy, migrate and seed: `railway up` into staging (or the T16 repo source). Today `web` builds with Railpack and
   its start command is `next start` only, so **nothing runs migrations** and the new staging Postgres is empty.
   Run them by hand, then the seed, from inside the staging network:
   `railway ssh --service web --environment staging` → `pnpm db:migrate:deploy` → `pnpm db:seed`.
   This manual migrate step is needed until T16 makes the Dockerfile `web` target (`migrate:deploy` then start) the
   build source; after that only the seed is manual. The seed creates link `pm6tea`, so
   `curl -I https://<staging web domain>/r/pm6tea` → 302.
6. Tracing on for `web`, `worker`, `node-gateway` in staging (§6 commands with `--environment staging`). PITR is not
   needed in staging.

Check: `describe-environment --environment staging` lists all services with their own volume ids (different from
§1); staging `web` `/login` returns 200; signing in on staging does not work with a production session.

Rollback: `railway environment delete staging --yes` (deletes its volumes; nothing in production changes).

## 9. Rebuild the project from nothing

For disaster recovery or a new region. Order: data, then app, then the steps above.

1. `railway init --name threadline` (or a new name), region `us-east4`; `railway link`.
2. Data: `railway add --database postgres` is **not** what production uses. Deploy the image
   `ghcr.io/railwayapp-templates/postgres-ssl:18` (Postgres template, version 18) with a 50 GB volume at
   `/var/lib/postgresql/data`, and `redis:8.2` with a volume at `/data`. Neither gets a TCP proxy.
3. Restore data: from a Railway backup or PITR (`railway postgres pitr restore`, then rename the restored service to
   `Postgres`), or from the T17 dump (`pg_restore -d "$DATABASE_URL" --no-owner threadline.dump` from inside the
   project via `railway ssh`). pgvector: the first migration runs `CREATE EXTENSION vector`, and the image ships it.
4. Services `web` and `worker` from the repo (T16 `railway.json` per service; Railpack today). Variables from §11,
   with `DATABASE_URL=${{Postgres.DATABASE_URL}}` and `REDIS_URL=${{Redis.REDIS_URL}}`. **Reuse the old
   `APP_ENCRYPTION_KEY`** (from the owner's password manager): every stored Reddit token and proxy password is
   encrypted with it, and a new key makes them unreadable.
5. Migrations: today `web` builds with Railpack and starts with `next start -p 3000` only, so nothing applies the
   schema. Run `railway ssh --service web --environment production` → `pnpm db:migrate:deploy` (with restored data
   this applies only migrations newer than the backup; on an empty database it creates the schema). Seed only a
   non-production rebuild (`pnpm db:seed`). Needed until T16 makes the Dockerfile `web` target, which runs
   `migrate:deploy` then start on `PORT=3000`, the build source.
6. Apply §3 (move the custom domains: delete them on the old project first, then add here and update DNS), §4, §5,
   §6, §7, §8.
7. Check: §3's `go.<domain>/r/<slug>` redirect, `/login`, a worker log line from `attribution.rollup` (every 15 min).

## 10. Change log

One row per applied change. Times in UTC. "By" is a person, or an agent plus the owner who approved it.

| Date (UTC) | Section | Change | By / approved by | Check result |
|---|---|---|---|---|
| 2026-11-07 | §1 | Read-only inventory; nothing changed | T15 agent | — |
| | §3 | `app.<domain>`, `go.<domain>` on `web` | | |
| | §4 | `TRACKING_HOST`, `APP_URL`, `AUTH_URL` on `web`, `worker`; Reddit redirect URI | | |
| 2026-11-07 21:16 | §5 | PITR enabled; schedule daily + weekly; first backup `t15-first`; earliest restore point 2026-11-07 21:16 UTC | coordinator agent / owner (G4) | archiver healthy, 1 base backup |
| 2026-11-07 21:22 | §6 | Tracing on `web`, `worker`, `node-gateway` (auto-instrumentation off) | coordinator agent / owner (G4) | |
| 2026-11-07 21:20 | §7 | `node-gateway` service with Railway domain `node-gateway-production-6426.up.railway.app` (no custom domain until G1); gateway variables; `NODE_GATEWAY_URL`/`GATEWAY_INTERNAL_SECRET` on `web`, `worker` | coordinator agent / owner (G4) | |
| 2026-11-07 21:22 | T16 | `web`, `worker`, `node-gateway` build from the repo `Dockerfile` (`railway up`); start commands per service; `web` pre-deploy runs `migrate:deploy`. Rollback: redeploy `web` 14c80ce9, `worker` d0b76404 | coordinator agent / owner (G4) | |
| 2026-11-08 16:40 | CD | `web`, `worker`, `node-gateway` source = GitHub `JinhuW/reddit_marketing@main` with Wait for CI (`checkSuites`); `worker` and `node-gateway` also run `migrate:deploy` as pre-deploy. Rollback: reconnect nothing, redeploy the previous deployment | owner request | docs/RELEASING.md "Continuous deployment" |
| | §8 | `staging` environment | | |

## 11. Settings register (target state)

Everything Railway holds for Threadline after T15, T16 and T17. Values in `<…>` are secrets or owner choices and
are never written here.

### Project

| Setting | Value |
|---|---|
| Project / region | `threadline` / `us-east4-eqdc4a` |
| Environments | `production`, `staging` |
| Shared variables | none |

### Services (production)

| Service | Source | Public | Private | Tracing | Volume |
|---|---|---|---|---|---|
| `web` | repo, T16 config (Railpack until then); start = `migrate:deploy` + start only after T16, manual `pnpm db:migrate:deploy` before | `app.<domain>`, `go.<domain>`, `web-production-e42e5.up.railway.app` → :3000 | `web.railway.internal` | on, auto-instr. off | — |
| `worker` | repo, T16 config | none | `worker.railway.internal` | on, auto-instr. off | — |
| `node-gateway` | repo, Dockerfile `gateway` target (T16) | `nodes.<domain>` → :8080, WSS only | `node-gateway.railway.internal:8080` | on, auto-instr. off | — |
| `db-backup` | `deploy/db-backup` (T17), cron `30 2 * * *` | none | — | off | — |
| `Postgres` | `ghcr.io/railwayapp-templates/postgres-ssl:18` | **none, no TCP proxy** | `postgres.railway.internal:5432` | off | 50 GB; PITR on; schedule daily + weekly |
| `Redis` | `redis:8.2` | **none, no TCP proxy** | `redis.railway.internal:6379` | off | 50 GB |

### Variables (production)

| Variable | `web` | `worker` | `node-gateway` | Value |
|---|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | ✓ | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | ✓ | ✓ | ✓ | `${{Redis.REDIS_URL}}` |
| `APP_ENCRYPTION_KEY` | ✓ | ✓ | ✓ | `<32 bytes base64>`, one value for all three |
| `AUTH_SECRET` | ✓ | ✓ | | `<secret>` |
| `AUTH_URL` | ✓ | | | `https://app.<domain>` |
| `AUTH_TRUST_HOST` | ✓ | | | `true` |
| `APP_URL` | ✓ | ✓ | | `https://app.<domain>` |
| `TRACKING_HOST` | ✓ | ✓ | | `https://go.<domain>` |
| `PORT` | ✓ | | ✓ | `3000` / `8080` |
| `SERVICE_ROLE` | | ✓ | ✓ | `core` / `gateway` |
| `NODE_GATEWAY_URL` | ✓ | ✓ | | `http://node-gateway.railway.internal:8080` |
| `GATEWAY_INTERNAL_SECRET` | ✓ | | ✓ | `<secret>`; web references the gateway's |
| `NODE_TOKEN_<NAME>` | | | ✓ | `<token>` per node (`NODE_TOKEN_BROWSER_1`) |
| `LLM_MODEL_DRAFT`, `LLM_MODEL_FAST` | ✓ | ✓ | | model ids |
| `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` | ✓ | ✓ | | `<secret>` when LLM features go live |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` | ✓ | ✓ | | Reddit app; redirect URI `https://app.<domain>/api/auth/reddit/callback` |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | ✓ | | | magic-link email |
| `OTEL_*` | auto | auto | auto | injected by Railway tracing |
| `ERP_API_URL` | ✓ | | | ERP sign-in; unset = magic link / Google only |

Never on Railway: `CLOAKBROWSER_LICENSE_KEY`, `GATEWAY_URL`, `NODE_NAME`, `NODE_TOKEN` (node env file only),
`SHADOW_DATABASE_URL` (dev only).

### Backups and restore

| Layer | Where | Schedule | Retention | Owner |
|---|---|---|---|---|
| PITR (WAL + pgBackRest) | Railway bucket | continuous; weekly full, daily diff | ~4 weeks | §5 |
| Volume backups | Railway | daily + weekly | Railway's per-schedule retention | §5 |
| `pg_dump -Fc` | off-Railway S3 bucket | 02:30 UTC nightly | 7 daily / 4 weekly | T17 |
| Browser profiles | node disk / home-1 (restic) | weekly | — | T32 |
| Restore drill | scratch environment | monthly; target < 15 min | — | T40 |
