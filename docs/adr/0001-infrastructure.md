# ADR-0001: Infrastructure — Railway for everything public, local VMs for CloakBrowser

**Status:** Proposed (rev. 3: Railway hosts every public page; OCI is optional)
**Date:** 2026-11-07
**Deciders:** Jinhu Wang
**Resolves:** docs/PLAN.md §14 "Hosting" and the deployment line in §12

## Context

Threadline is already deployed on Railway (project `threadline`, environment `production`, region `us-east4`):

| Service | Source | State on 2026-11-07 |
|---|---|---|
| `web` | `railway up`, Railpack build | Live on `web-production-e42e5.up.railway.app`; runs `migrate:deploy` then `next start` |
| `worker` | `railway up`, Railpack build | Live, no public domain; `attribution.rollup` runs every 15 min |
| `Postgres` | `ghcr.io/railwayapp-templates/postgres-ssl:18`, 50 GB volume | Both migrations applied, including `CREATE EXTENSION vector` |
| `Redis` | `redis:8.2`, volume | Live |

What is left to place is the part the plan puts in Docker on one server: **browser profiles** (M6). The browser engine
is **CloakBrowser**: a patched Chromium that removes `navigator.webdriver`, the CDP leak and the shared SwiftShader
GPU, and gives each profile a seeded fingerprint.

Forces:

1. **Every public page runs on Railway**: the app, `/r/[slug]` tracked links, Stripe and tl.js endpoints, SSE and the
   authenticated VNC proxy. Tracked links in Reddit comments are permanent, so their host must not change.
2. **Railway cannot run the browser profiles.** They need a Docker daemon to start one container per account, an
   X display and long-lived headed Chromium. Railway runs your containers; it does not give them a Docker socket.
3. **CloakBrowser is Linux x86_64 only** (no linux-arm64 build found), needs a license key checked online at every
   launch, and counts seats per concurrent session.
4. **Local VMs are behind home NAT**: they can dial out but accept nothing inbound.
5. **Railway's private network** (`*.railway.internal`) is reachable only from services in the same project.
   Reaching Postgres or Redis from outside means a public TCP proxy.
6. **PLAN §2 and §10**: the worker is the only process that holds Reddit tokens and talks to browsers; browser
   containers publish no host ports; nothing posts without an approved Draft.
7. **OCI Always Free is available but not required.** Its only big host is the arm64 A1, which CloakBrowser cannot use.

## Decision

Railway runs everything public plus the data and the core worker. Local x86 VMs run CloakBrowser profiles and
connect **outbound only** to a new Railway service, `node-gateway`. No database or queue is exposed to the internet.

```
 Internet ──HTTPS──► Railway project "threadline" (us-east4)
                     ┌──────────────────────────────────────────────────────────────┐
                     │ web            app.<domain>, go.<domain>   (public)           │
                     │   │ private network                                          │
                     │ worker         every queue; Reddit API; LLM  (no domain)     │
                     │ node-gateway   nodes.<domain>, WSS only    (public, authed)   │
                     │ Postgres 18 + pgvector · Redis 8           (private only)     │
                     └───────────────────────────▲──────────────────────────────────┘
                                                 │ outbound WSS from home (no inbound ports)
                     ┌───────────────────────────┴──────────────────────────────────┐
                     │ browser-1  local VM, x86_64                                   │
                     │ node-agent → local Docker → CloakBrowser containers → proxies │
                     └──────────────────────────────────────────────────────────────┘
```

### Railway services

| Service | Change from today | Notes |
|---|---|---|
| `web` | Add custom domains `app.<domain>` and `go.<domain>`; set `TRACKING_HOST=https://go.<domain>` | Do this **before the first live post**: a tracked link minted on the `up.railway.app` host stays in that comment forever |
| `worker` | None for M1–M5. In M6 it enqueues browser work to `browser.<nodeId>` after the §10 re-checks | Stays private; still the only service with Reddit tokens |
| `node-gateway` | **New**, same image as `worker` with `SERVICE_ROLE=gateway`, domain `nodes.<domain>` | Accepts WSS from node agents; consumes `browser.<nodeId>` jobs; relays VNC; writes results, `BrowserSession` and `AuditEvent` rows |
| `Postgres` | Turn on PITR and scheduled volume backups | Stays private: no TCP proxy |
| `Redis` | None | Stays private: no TCP proxy |

`worker` already has a `SERVICE_ROLE` variable; the gateway reuses that switch instead of a new image.

### Browser nodes: outbound-only agents

A browser node runs one process, `node-agent` (its own package, `apps/node-agent`, with no database
dependency), next to Docker:

1. On start it dials `wss://nodes.<domain>/agent` with its node id and a per-node token (Railway variable
   `NODE_TOKEN_<id>`, stored hashed), and reconnects with backoff.
2. The gateway pushes commands: start or stop a profile, run a Playwright action (`openThread`, `submitComment`,
   `sendDm`), health check. The agent starts the CloakBrowser container through the **local** Docker socket,
   attaches with Playwright `connectOverCDP` on the internal `threadline_browsers` network, and streams back the
   result: `posted`, `NeedsHuman` or `license_denied`.
3. Proxy credentials come with the start command, decrypted by the gateway, over TLS, and live only in the agent's
   memory and the container's environment. Never in Redis, a job payload, logs or the node's disk.
4. **VNC take-over**: the web VNC route checks the role (Admin or account owner), then connects to the gateway over
   the private network. The gateway asks the agent to open a second outbound WSS for that session, and pipes the
   two together. The container still publishes no host ports and CDP never leaves the node.

The node holds **no** database URL, Redis URL, Reddit token or `APP_ENCRYPTION_KEY`. A stolen node leaks one
CloakBrowser license key and the profiles stored on it.

Losing a home node does not stop the product: posting goes through the Reddit API first (PLAN §5), and the browser
is the fallback for DMs and verification. While no agent is connected, the gateway leaves browser jobs queued, the
account is paused with reason `node_offline`, and the owner is notified.

### Browser engine: CloakBrowser

| Concern | Decision |
|---|---|
| Image | `apps/browser-profile` keeps its shape (supervisor, Xvfb, x11vnc, websockify, CDP on the internal network). One pinned CloakBrowser build is baked in (`CLOAKBROWSER_BINARY_PATH`), `linux/amd64` only, never auto-downloaded |
| Build bump | Changes every profile's user agent: a device change. Roll it like a release, one profile first |
| Fingerprint | `BrowserProfile.cloakSeed`, `cloakPersona`, `cloakGpu`, written once at connect time and never changed. A random seed per launch would look like a new device on every start |
| Persona | Match the owner's real OS and install that OS's fonts. No UA, client-hint or viewport override from Playwright |
| Proxy | Per-profile sticky residential proxy, auth over CDP `Fetch.authRequired`. Some Playwright paths (`context.request`) skip credentialed proxies, so all traffic goes through the page; the connection test checks the exit IP from both |
| License key | `CLOAKBROWSER_LICENSE_KEY` in the node's env file (`chmod 600`). Passed to builds as a BuildKit secret, never in an image layer |
| Seats | Peak concurrent profiles + 1 for the health probe. The 15-minute idle stop keeps this small. Start on the 5-seat tier |
| License failure | `license_denied`: do not open Reddit, pause the account, write an AuditEvent, notify the owner. A crashed container can hold a seat on the license server, so health reports seats in use and the agent waits before relaunching |

CloakBrowser keeps each owner's real account on one stable device. It is not used to create identities or run
accounts for anyone but their real owner. A person may own several accounts (DECISIONS 2026-11-08), each with its
own profile, and PLAN §10's `one_voice_per_thread` block rule keeps two of them out of the same thread.

### Local VMs

| Host | Runs | Size |
|---|---|---|
| `browser-1` | `node-agent`, Docker, CloakBrowser containers, weekly restic of profile volumes | x86_64, 4 vCPU, 8–16 GB, 60 GB; ~6–12 profiles at once (seats cap it first) |
| `browser-2+` | More nodes when seats or RAM run out | x86_64 |
| `home-1` (optional) | Self-hosted GitHub Actions runner for Testcontainers + Playwright; nightly `pg_dump` copy pulled through the Railway CLI | Any |

Deploy to nodes: `docker compose pull && up -d` of `deploy/node/compose.yml` (agent + pinned browser image from a
private GHCR repo), run by the self-hosted runner after a release, or by hand.

### OCI (optional)

Nothing depends on OCI. If you want to use it:

- An E2.1.Micro running Uptime Kuma, checking `go.<domain>/healthz`, `app.<domain>` and `nodes.<domain>` from
  outside Railway.
- Object Storage (20 GB free) as an off-Railway copy of the nightly `pg_dump`, so a Railway account problem cannot
  take the only backup with it.
- If CloakBrowser ships linux-arm64, an A1 can become a browser node. The agent is outbound-only, so nothing else
  changes. OCI's datacenter IP doesn't matter because profiles use residential proxies.

If you keep OCI instances, upgrade the tenancy to Pay As You Go, or Always Free instances that look idle may be reclaimed.

### Observability, secrets, backups

| Area | Decision |
|---|---|
| Traces | Railway tracing for `web`, `worker`, `node-gateway` (OTel SDK reads the `OTEL_*` variables Railway injects). Jaeger stays for local dev only. Agents send spans through the gateway |
| Logs | pino to stdout → Railway logs. Node agents log locally and send errors to Sentry |
| Secrets | Railway variables per service; `APP_ENCRYPTION_KEY` only on `web`, `worker`, `node-gateway`. Node env files hold only node id, node token and the CloakBrowser key |
| Postgres backups | Railway PITR plus scheduled volume backups; nightly `pg_dump -Fc` copied off Railway (home-1 or OCI Object Storage) |
| Browser profiles | Weekly restic of each `/data` volume on the node, to a second disk or home-1 |
| Restore drill | Monthly: PITR restore into a scratch Railway environment, run the app against it, time it (M8 target < 15 min) |

### Build and release

- Keep `railway up` until M5, then connect `web`, `worker` and `node-gateway` to the GitHub repo and deploy on the
  release-please tag, with a `railway.json` per service (build, start command, healthcheck).
- Railway builds with Railpack today, not the repo `Dockerfile`. Pick one; the Dockerfile matches local
  `docker compose` and pins Node 22.
- GitHub Actions builds `browser-profile` and the node-agent image for `linux/amd64` to private GHCR.
- Staging: a Railway `staging` environment with its own Postgres, Redis, Reddit app and node token, pointing at one
  staging browser node.

## Options Considered

### Option A: Railway + outbound node agents (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one new Railway service and an agent protocol (commands, results, VNC pipe) |
| Cost | Railway usage for one more small service; local VMs and CloakBrowser seats |
| Scalability | New node = VM + token + seats; Railway services scale on their own |
| Security | Postgres and Redis stay private; nodes hold no app secrets |

**Pros:** keeps the current deployment; no database or queue on the internet; works behind any NAT; matches §2
("only the worker talks to browsers": the gateway is a worker role).
**Cons:** the protocol is new code in M6 instead of reusing BullMQ on the node; the gateway is a second public
endpoint (WSS only, token-authenticated).

### Option B: Railway + Tailscale subnet router inside the project

Run a Tailscale container in Railway that advertises the private network, so home nodes reach Postgres and Redis
as if local, and browser workers consume BullMQ directly.

**Pros:** least code; BullMQ everywhere.
**Cons:** only community templates exist, none verified by Railway; every node holds `DATABASE_URL`, `REDIS_URL` and
`APP_ENCRYPTION_KEY`; VNC from `web` to a home node still needs a route back.

### Option C: Railway + public TCP proxies for Postgres and Redis

**Pros:** no new service.
**Cons:** puts the source-of-truth database and the queue on the internet. Redis traffic through the TCP proxy is
not TLS by default. Rejected.

### Option D: Move everything back to a self-managed host (OCI or home)

Rejected: you asked for Railway for public pages, and it's already running.

## Trade-off Analysis

The choice is between **less code (B)** and **a smaller blast radius (A)**. The browser node is the least
trusted machine in the system: it sits on a home network, runs a closed-source binary and opens Reddit pages. In A it
holds a node token and a license key; in B it holds the keys to the database and every Reddit token. M6 hasn't
started (`browser/manager.ts` doesn't exist), so the agent protocol is new code either way. A also sidesteps
reverse VNC routing, because every connection starts at the node.

## Consequences

- Easier: one platform for every public page, backups, traces and logs; nodes can be added anywhere with outbound
  HTTPS, including OCI if an arm64 build appears.
- Harder: the gateway/agent protocol needs its own tests (reconnects, job leases when an agent drops mid-action,
  VNC pipe teardown); local dev needs a fake agent.
- A job leased to an agent that disconnects must time out and return to the queue. Posting stays idempotent on
  `draft:<id>` and is re-checked before retry, so it can't double-post.
- The CloakBrowser Binary License needs a separate agreement when the binary is bundled or exposed through an
  API. Your own single workspace is your own use; selling plans to customers likely is not. Ask CloakHQ before M8.
- Postgres is 18 on Railway; PLAN says 16. pgvector works (migrations applied). Record this in docs/DECISIONS.md.
- Revisit: more than ~25 concurrent profiles; multi-tenant browser pools; a CloakBrowser linux-arm64 build.

## Action Items

1. [ ] Buy the domain; add `app.<domain>` and `go.<domain>` to `web` and set `TRACKING_HOST` before any live post.
2. [ ] Turn on Postgres PITR and scheduled backups in Railway; add the nightly off-Railway `pg_dump` copy.
3. [ ] Enable Railway tracing on `web` and `worker`; point the OTel SDK at the injected variables.
4. [ ] Add `railway.json` per service; decide Railpack vs the repo Dockerfile; connect the repo before M5.
5. [ ] Create `browser-1` (x86_64 VM) with Docker; CloakBrowser spike with no Reddit account: pinned build, Xvfb,
       `connectOverCDP`, VNC, proxy exit IP from page and worker, stable seed, blocked license host →
       `license_denied`.
6. [ ] Buy the 5-seat CloakBrowser tier after the spike; ask CloakHQ about customer workspaces.
7. [ ] M6 design input: `node-gateway` service, agent protocol (auth, commands, leases, results, VNC pipe),
       `BrowserProfile.nodeId` and `cloak*` fields, `node_offline` and `license_denied` outcomes, all with tests.
8. [ ] Optional OCI: Uptime Kuma on a micro, Object Storage for the off-site dump; PAYG upgrade if kept.
9. [ ] Update PLAN §2 (browser profiles row), §12, §14 and docs/DECISIONS.md once accepted.
