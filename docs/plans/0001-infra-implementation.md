# Implementation plan: Railway + CloakBrowser browser nodes

Nov 7, 2026 · implements [ADR-0001](../adr/0001-infrastructure.md) · covers PLAN §8 M6 and the deployment parts of M8

This plan is written for a team of Claude agents working in parallel, one task per agent, each in its own
worktree and branch. Every task card says which files it owns, what it may only read, what it must deliver and how
it is checked. Read §1–§3 before picking up any task.

## 0. Preconditions (owner decisions)

| Gate | Decision needed | Blocks |
|---|---|---|
| **G0 · Milestone order** | CLAUDE.md says not to start M6 before M1–M5 acceptance passes. This plan pulls M6 infra forward. Approve the exception (and log it in docs/DECISIONS.md), or run only the Railway hardening tasks (T15, T16, T17) now | Waves 1–4 except T15–T17 |
| **G1 · Domain** | Buy `<domain>`; Threadline uses `app.`, `go.`, `nodes.` | T15 |
| **G2 · CloakBrowser key** | Free key for the spike (one session); 5-seat tier after T13's probe passes | T13, then T34 |
| **G3 · Browser VM** | One local x86_64 VM, 4 vCPU / 8–16 GB / 60 GB, Docker installed, outbound HTTPS | T13 probe, T32, T34 |
| **G4 · Railway changes** | Approve each outward change (domains, new service, PITR, staging env). Agents prepare; you or an agent with your approval applies | T15, T16 |

## 1. Target architecture (recap)

```
Railway project "threadline" (us-east4)                         local x86 VM "browser-1"
┌───────────────────────────────────────────────────────┐       ┌──────────────────────────────────┐
│ web           app.<domain>, go.<domain>  + VNC ws     │       │ node-agent  (apps/node-agent)    │
│ worker        SERVICE_ROLE=core: all non-browser queues│ WSS   │   ├─ docker.ts → tl-profile-<id> │
│ node-gateway  SERVICE_ROLE=gateway: nodes.<domain>    │◄──────│   ├─ actions/* (Playwright/CDP)  │
│ Postgres 18 + pgvector, Redis 8 (private only)        │ out-  │   └─ vnc.ts (pipe to :6080)      │
└───────────────────────────────────────────────────────┘ bound │ CloakBrowser containers → proxy  │
                                                                └──────────────────────────────────┘
```

Refinement of the ADR: the node agent is its own package, **`apps/node-agent`**, not a worker role. It depends only
on `@threadline/shared`, `ws`, `dockerode` and `playwright-core`, so the node image cannot reach the database even
by accident. The gateway is a worker role (`SERVICE_ROLE=gateway`) because it writes to Postgres and reads BullMQ.

## 2. Rules for parallel work

1. **Wave 0 merges first.** It freezes the shared contracts in §3. Later tasks code against them and do not edit
   them. If a task needs a contract change, it stops and asks the coordinator; the coordinator lands a small
   `feat(shared): …` PR and rebases the others.
2. **File ownership is exclusive within a wave** (§5). A task touches only files it owns plus new files under its
   own directories. Shared files: `packages/shared/src/*`, `packages/db/prisma/schema.prisma`,
   `packages/db/src/index.ts`, root `package.json`, `pnpm-lock.yaml` (only via `pnpm add` in the owned package),
   `.env.example`, `docs/PLAN.md`, `docs/DECISIONS.md` are owned by Wave 0 and Wave 4 only.
3. Each task is one PR, Conventional Commit title as given on its card, rebased on `main` before merge, squash-merged.
4. Repo rules apply to every task: DB access only through `packages/db` repos; enums only in
   `packages/shared/src/enums.ts`; every state change on Draft, RedditAccount, BrowserSession writes an AuditEvent;
   no code path posts to Reddit without an approved Draft and an `approverMemberId`; never weaken a `block` rule;
   never call live Reddit, LLM or CloakBrowser license servers in CI (record fixtures under `tests/fixtures`).
5. Definition of done for every task: `pnpm typecheck && pnpm lint && pnpm test` green; new behaviour has tests;
   `.env.example` lists any new variable (via the coordinator); the card's "Done when" is demonstrated in the PR body.

## 3. Contracts frozen in Wave 0

### 3.1 Database (migration `browser_nodes`)

```prisma
model BrowserNode {
  id           String            @id @default(cuid())
  workspaceId  String
  name         String            // "browser-1"; also the queue suffix
  tokenHash    String            // sha256 of the node token; token itself only in Railway + node env
  status       BrowserNodeStatus @default(offline)
  agentVersion String?
  imageDigest  String?           // browser-profile image the node reports
  seatsInUse   Int               @default(0)
  seatsLimit   Int?
  maxProfiles  Int               @default(8)
  lastSeenAt   DateTime?
  createdAt    DateTime          @default(now())
  updatedAt    DateTime          @updatedAt
  workspace    Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  profiles     BrowserProfile[]
  @@unique([workspaceId, name])
}

// BrowserProfile gains:
  nodeId       String?
  cloakSeed    Int?              // set once at connect time, never changed
  cloakPersona String?           // "windows" | "macos" | "linux"
  cloakGpu     String?           // "nvidia" | "intel" | "amd"
  node         BrowserNode?      @relation(fields: [nodeId], references: [id])

// RedditAccount gains:
  pausedReason PauseReason?
  pausedAt     DateTime?
```

### 3.2 Enums (`packages/shared/src/enums.ts`, mirrored in Prisma)

```ts
export const BrowserNodeStatus = ['online', 'offline', 'draining'] as const;
export const PauseReason = ['needs_human', 'license_denied', 'node_offline', 'proxy_failed', 'manual'] as const;
export const BrowserOutcome = ['ok', 'posted', 'needs_human', 'license_denied', 'proxy_failed', 'error'] as const;
// AuditAction additions:
'node.online', 'node.offline', 'profile.started', 'profile.stopped', 'profile.license_denied',
'profile.fingerprint_assigned', 'account.paused', 'account.resumed'
```

### 3.3 Queues (`packages/shared/src/queues.ts`)

```ts
export const browserQueue = (nodeName: string) => `browser.${nodeName}` as const;

export type BrowserJob =
  | { kind: 'profile.start'; workspaceId: string; profileId: string; reason: 'action' | 'takeover' | 'test' }
  | { kind: 'profile.stop'; workspaceId: string; profileId: string; reason: 'idle' | 'handback' | 'manual' }
  | { kind: 'action.submitComment' | 'action.sendDm'; workspaceId: string; profileId: string; draftId: string }
  | { kind: 'profile.testProxy'; workspaceId: string; profileId: string }
  | { kind: 'health.check'; workspaceId: string };
// Job ids: `bj-<kind>-<draftId|profileId>` (no colons; see DECISIONS on BullMQ ids).
// Job payloads never contain secrets. The gateway loads and decrypts at dispatch time.
```

### 3.4 Gateway ↔ agent protocol (`packages/shared/src/node-protocol.ts`, zod)

Transport: `wss://nodes.<domain>/agent`, subprotocol `tl-node.v1`, headers `Authorization: Bearer <NODE_TOKEN>`,
`X-Node-Name: <name>`. JSON text frames, each validated with zod on both ends; unknown `type` closes with 4400.

```ts
// agent → gateway
Hello     { type:'hello', node, agentVersion, imageDigest, maxProfiles, seats:{inUse, limit|null}, running: ProfileRef[] }
Heartbeat { type:'heartbeat', ts, running: ProfileRef[], seats:{inUse, limit|null} }
Ack       { type:'ack', cmdId }
Result    { type:'result', cmdId, outcome: BrowserOutcome, data?: unknown, error?: { code, message } }
Event     { type:'event', profileId, kind:'container.exited'|'session.activity'|'needs_human', detail? }

// gateway → agent
Welcome   { type:'welcome', serverTime, heartbeatSec: 15, protocol: 1 }
Command   { type:'command', cmdId, deadlineMs, cmd: Cmd }
Cmd =
  | { kind:'profile.start', profileId, seed, persona, gpu, tz, locale, screen,
      proxy: { protocol:'http'|'socks5', host, port, username?, password? } | null }
  | { kind:'profile.stop', profileId }
  | { kind:'action.submitComment', profileId, draftId, threadUrl, parentFullname, body }
  | { kind:'action.sendDm', profileId, draftId, to, subject, body }
  | { kind:'profile.testProxy', profileId }       // data: { pageIp, agentIp }
  | { kind:'vnc.open', profileId, sessionId, upstreamUrl, token }   // token: HMAC, 60 s
  | { kind:'health.check' }                        // data: { running, seats, docker:'ok'|'error' }
```

Semantics every implementation must honour:

- `cmdId` is the BullMQ job id. The agent keeps the last 500 `cmdId → Result` and replays a stored result instead of
  re-running a command. This is what makes reconnect-and-retry safe for posting.
- The agent sends `ack` within 2 s, `result` before `deadlineMs`. The gateway fails the job as retryable
  (`NodeTimeout`) after the deadline, or as `NodeDisconnected` if the socket closes first.
- Three missed heartbeats (45 s) mark the node `offline`.
- Close codes: 4401 bad token, 4409 node name already connected, 4400 protocol error, 4426 protocol version.
- VNC: on `vnc.open` the agent dials `upstreamUrl` (`wss://nodes.<domain>/vnc/<sessionId>?t=<token>`) and pipes
  binary frames to `ws://tl-profile-<id>:6080/websockify`. No other inbound path exists.

### 3.5 Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `SERVICE_ROLE` | worker image | `core` (default) or `gateway` |
| `NODE_GATEWAY_URL` | web, worker | private URL of the gateway, e.g. `http://node-gateway.railway.internal:8080` |
| `GATEWAY_INTERNAL_SECRET` | web, gateway | HMAC key for web → gateway VNC requests and agent VNC tokens |
| `NODE_TOKEN_<NAME>` | gateway | one per node; compared by hash with `BrowserNode.tokenHash` |
| `GATEWAY_URL`, `NODE_NAME`, `NODE_TOKEN` | node | where to dial, who it is |
| `CLOAKBROWSER_LICENSE_KEY` | node only | passed to containers; never logged |
| `BROWSER_IMAGE`, `BROWSER_NETWORK`, `NODE_MAX_PROFILES` | node | pinned image digest, internal network, cap |

## 4. Waves and tasks

```
Wave 0  T00 contracts ───────────────────────────────────────────────┐
Wave 1  T10 roles   T11 gateway hub   T12 agent core   T13 image+probe   T14 testkit   T16 CI/Railway config
        T15 Railway ops (human-gated, any time)   T17 db backup service (any time)
Wave 2  T20 dispatch   T21 docker mgr   T22 actions   T23 VNC (web)   T24 VNC (relay)   T25 worker integration
Wave 3  T30 Browsers UI   T31 proxy test   T32 node deploy   T33 observability   T34 staging E2E
Wave 4  T40 acceptance, docs, restore drill
```

Estimates (calendar, with parallel agents): Wave 0 ≈ 1 day, Wave 1 ≈ 2–3 days, Wave 2 ≈ 3–4 days, Wave 3 ≈ 2–3 days,
Wave 4 ≈ 1 day. Critical path: T00 → T11 → T20 → T25 → T34 → T40.

---

### Wave 0

#### T00 · Contracts, schema and repos
- **Owns:** `packages/shared/src/{enums.ts,queues.ts,node-protocol.ts,index.ts}`, `packages/db/prisma/schema.prisma`,
  new migration, `packages/db/prisma/seed.ts` (one `browser-1` node for dev), `packages/db/src/repos/nodes.ts` (new),
  `packages/db/src/repos/browsers.ts`, `packages/db/src/index.ts`, `.env.example`, `docs/DECISIONS.md`,
  `apps/worker/src/gateway/index.ts` (stub only: `export async function startGateway(): Promise<void>` that throws
  `not implemented`; T11 replaces it).
- **Build:** everything in §3. Repos:
  `nodes.{register, verifyToken, markOnline, markOffline, recordHeartbeat, listOnline, getByName}`;
  `browsers.{assignNode, ensureCloakFingerprint, pauseAccount, resumeAccount, getProfileForDispatch}`.
  `ensureCloakFingerprint` assigns a seed once (deterministic from profile id + a random salt stored with it) and
  writes `profile.fingerprint_assigned`. `pauseAccount`/`resumeAccount` and node status changes write AuditEvents.
  `getProfileForDispatch` returns the profile with decrypted proxy credentials; it is the only decrypting function
  and is documented as gateway-only.
- **Tests:** zod round-trips for every message; enum mirror test extended; repo tests (token verify by hash,
  fingerprint never changes on second call, pause writes audit).
- **Done when:** migration applies on a clean DB and on the Railway schema (dry run with `migrate diff`); other
  tasks can import every type in §3.
- **PR:** `feat(shared): browser node contracts, schema and repos`

### Wave 1 (parallel)

#### T10 · Worker roles
- **Owns:** `apps/worker/src/index.ts`, `apps/worker/src/roles/{core.ts,gateway.ts}` (new), `apps/worker/package.json` scripts.
- **Build:** `SERVICE_ROLE` switch. `core` = today's processors minus `browser.health`. `gateway` = calls
  `startGateway()` from `src/gateway/index.ts` (T00's stub until T11 lands). Shared graceful shutdown.
- **Tests:** role selection, unknown role exits non-zero.
- **PR:** `feat(worker): service roles for core and gateway`

#### T11 · Gateway hub
- **Owns:** `apps/worker/src/gateway/{index.ts,server.ts,hub.ts,auth.ts}` (new).
- **Build:** HTTP server on `PORT` with `/healthz`; WSS `/agent` using `ws`; token auth via `nodes.verifyToken`;
  hello/welcome, heartbeat, offline after 45 s, one connection per node name (4409). `hub.send(nodeName, cmd, {deadlineMs})
  → Promise<Result>` with ack/deadline/disconnect handling as in §3.4. Emits `node.online/offline` through repos.
- **Tests:** with T14's FakeAgent once available, else a raw `ws` client: auth failures, duplicate node, heartbeat
  timeout, deadline, disconnect mid-command, result replay.
- **PR:** `feat(gateway): authenticated websocket hub for browser nodes`

#### T12 · Node agent core
- **Owns:** `apps/node-agent/**` except `src/docker.ts`, `src/actions/**`, `src/vnc.ts`.
- **Build:** new package (`@threadline/node-agent`, TS, ESM). `config.ts` (zod env), `client.ts` (dial, subprotocol,
  jittered backoff 1–30 s, heartbeat), `dispatch.ts` (handler registry keyed by `Cmd.kind`, ack, result cache of 500,
  deadline guard), `log.ts` (pino with redaction of `password`, `token`, `CLOAKBROWSER_LICENSE_KEY`), `Dockerfile`
  (`linux/amd64`, node 22 slim, non-root, Docker socket mounted at runtime). Handlers for docker/actions/vnc are
  registered from modules that T21–T24 create; ship them as stubs returning `{ outcome:'error', error:{code:'not_implemented'} }`.
- **Tests:** against T14's FakeGateway (or a local `ws` server): reconnect, replay, deadline, redaction.
- **PR:** `feat(node-agent): gateway client with reconnect and command dispatch`

#### T13 · CloakBrowser image and probe
- **Owns:** `apps/browser-profile/**`, `scripts/browser-probe.ts` (new).
- **Build:** Dockerfile installs one pinned CloakBrowser build (build arg `CLOAK_VERSION`, key via
  `--secret id=cloak_key`, binary path in `CLOAKBROWSER_BINARY_PATH`), fonts for Windows-metric, emoji and CJK.
  `supervisor.mjs` starts it headed under Xvfb with `--fingerprint=$CLOAK_SEED`, persona and GPU flags, `TZ`, `LANG`,
  `--proxy-server` when `PROXY_URL` is set, CDP on 9222, websockify on 6080. No UA or viewport override. Exit code
  78 when the license check fails, so the agent can map it to `license_denied`.
  `browser-probe.ts`: connects over CDP and reports `navigator.webdriver`, UA + client hints, WebGL vendor,
  canvas hash, exit IP from the page, and whether two launches with one seed match.
- **Needs:** G2 (free key), G3 (VM) for the live probe. The image build itself runs in CI without a key only if the
  binary can be fetched without one; otherwise mark the build job manual.
- **Done when:** the probe on `browser-1` shows webdriver false, stable hashes for one seed across restarts,
  different hashes for two seeds, and exit 78 with the license host blocked. Paste the probe output in the PR.
- **PR:** `feat(browser-profile): CloakBrowser image with seeded fingerprint and probe`

#### T14 · Test kit
- **Owns:** `packages/node-testkit/**` (new), `tests/fixtures/reddit-pages/**` (new).
- **Build:** `FakeAgent` (connects to a gateway URL, scripted results per `Cmd.kind`, can drop the socket on cue),
  `FakeGateway` (accepts an agent, sends commands, records results), `startFakeCdpTarget()` that launches
  Playwright's bundled Chromium with `--remote-debugging-port` serving fixture pages. Fixture HTML for a thread,
  comment box, DM compose, a verification wall and a login wall, captured once by hand and scrubbed.
- **PR:** `test(node-testkit): fake agent, fake gateway and Reddit page fixtures`

#### T15 · Railway hardening (human-gated, can start now)
- **Owns:** Railway project settings only; `docs/RUNBOOK-railway.md` (new).
- **Do, with G1/G4 approval:** add `app.` and `go.` custom domains to `web`; set `TRACKING_HOST`, `APP_URL`,
  `AUTH_URL`; turn on Postgres PITR and a daily volume backup schedule; enable tracing on `web` and `worker`;
  create an empty `node-gateway` service (domain `nodes.`, private port 8080); create a `staging` environment.
- **Done when:** `go.<domain>/r/<seed slug>` redirects; a PITR restore point is listed; the runbook records every
  setting and how to redo it.
- **PR:** `docs(ops): Railway runbook`

#### T16 · Build and deploy config
- **Owns:** `railway.json` files under `apps/web/`, `apps/worker/` (with a gateway variant), `Dockerfile`,
  `.github/workflows/images.yml` (new), `.github/workflows/ci.yml` (add node-agent and testkit to the matrix).
- **Build:** choose the repo Dockerfile over Railpack (pins Node 22, matches local compose) and add a `gateway`
  target; healthchecks (`/healthz`, `/login`); `images.yml` builds `node-agent` and `browser-profile` for
  `linux/amd64` on release tags and pushes to private GHCR, with the Cloak key as a BuildKit secret; verify no key in
  `docker history`.
- **PR:** `ci: railway service config and node image builds`

#### T17 · Off-Railway database backup
- **Owns:** `deploy/db-backup/**` (new).
- **Build:** a Railway cron service (`postgres:18` image) that runs `pg_dump -Fc` nightly at 02:30 UTC over the
  private network and uploads to an S3-compatible bucket (OCI Object Storage or any S3), with 7 daily / 4 weekly
  retention. Credentials from Railway variables.
- **Done when:** one dump lands in the bucket and `pg_restore --list` reads it.
- **PR:** `feat(ops): nightly off-Railway postgres dump`

### Wave 2 (parallel; needs Wave 0 and the listed Wave 1 tasks)

#### T20 · Gateway dispatch (needs T11)
- **Owns:** `apps/worker/src/gateway/{dispatch.ts,outcomes.ts}`.
- **Build:** for each online node, a BullMQ `Worker` on `browserQueue(name)` (concurrency = `maxProfiles`, 1 per
  profile via job grouping or a per-profile lock); closed when the node goes offline. Per job: load with
  `getProfileForDispatch`, build the `Cmd`, `hub.send`, map the result.
  **Approval guard (block):** before `action.submitComment` or `action.sendDm`, re-read the Draft and refuse unless
  status is `approved`/`scheduled`, `approverMemberId` is set and the draft is not posted; run the §10 post-time
  checks again. Outcomes: `posted` → `drafts.markPosted` + `draft.posted`; `needs_human` → pause
  `needs_human` + notification; `license_denied` → pause + `profile.license_denied`; `proxy_failed` → pause.
  Offline sweep: when a node goes offline with jobs waiting, pause the affected accounts with `node_offline`;
  resume them when it returns.
- **Tests:** with FakeAgent: each outcome; unapproved draft never reaches the agent; disconnect → retry → replayed
  result posts once.
- **PR:** `feat(gateway): dispatch browser jobs to nodes behind the approval gate`

#### T21 · Docker manager (needs T12)
- **Owns:** `apps/node-agent/src/docker.ts`, `apps/node-agent/src/handlers/profile.ts`.
- **Build:** `dockerode` on the local socket. Ensure the internal network; per profile a volume
  `tl-profile-<id>` and container `tl-profile-<id>` from `BROWSER_IMAGE` with env from `profile.start`, no published
  ports, `--shm-size=1g`, memory limit 1.5 GB, labels. Start waits for CDP ready (30 s) else `error`; exit 78 →
  `license_denied`. Stop, idle reconcile, `container.exited` events, seat count = running containers; refuse start
  above `NODE_MAX_PROFILES` or seat limit; wait 60 s before relaunching a profile that crashed.
- **Tests:** Testcontainers-style against the local Docker daemon using a tiny fake image (skipped in CI if no
  Docker; tagged `@docker`).
- **PR:** `feat(node-agent): per-profile containers through the local docker socket`

#### T22 · Playwright actions (needs T12, T14)
- **Owns:** `apps/node-agent/src/actions/**`, `apps/node-agent/src/handlers/actions.ts`.
- **Build:** `connectOverCDP` to `tl-profile-<id>:9222`; proxy auth through CDP `Fetch.authRequired`;
  `submitComment(threadUrl, parentFullname, body)`, `sendDm(to, subject, body)`, `testProxy()` (exit IP from the page
  via `fetch()` in `page.evaluate`, and from the agent). Detect verification, captcha and login walls →
  `needs_human`. Return the new item's fullname for `posted`. Never use `context.request`.
- **Tests:** against T14 fixtures served by `startFakeCdpTarget()`; one test per wall type.
- **PR:** `feat(node-agent): comment, DM and proxy test actions over CDP`

#### T23 · VNC in web (needs T00)
- **Owns:** `apps/web/server.ts` (new), `apps/web/package.json` start/dev scripts,
  `apps/web/app/api/vnc/[profileId]/route.ts`, `apps/web/components/browsers/VncViewer.tsx`.
- **Build:** a Node custom server wrapping Next that handles the websocket upgrade on `/api/vnc/:profileId`: session
  cookie → member, `canControlProfile`, `startHumanSession` (writes `session.started`), then open
  `${NODE_GATEWAY_URL}/internal/vnc/:profileId?session=…` signed with `GATEWAY_INTERNAL_SECRET` and pipe frames.
  Wire noVNC `RFB` in `VncViewer` per the TODO in that file. The route handler keeps answering plain GETs with status.
- **Tests:** upgrade refused for Viewer/non-owner (403), signed URL verified by a fake gateway, pipe closes both ways.
- **PR:** `feat(web): authenticated VNC websocket proxy`

#### T24 · VNC relay (needs T11, T12)
- **Owns:** `apps/worker/src/gateway/vnc.ts`, `apps/node-agent/src/vnc.ts`, `apps/node-agent/src/handlers/vnc.ts`.
- **Build:** gateway `/internal/vnc/:profileId` (HMAC-checked, private network only) sends `vnc.open` with a 60 s
  token and waits up to 10 s for the agent to dial `/vnc/<sessionId>`; pipes the two sockets; closes both on either
  side closing. Agent dials upstream and pipes to the container's websockify. Session activity events feed
  `session.idle`.
- **Tests:** FakeAgent + fake websockify echo: bytes round-trip; bad/expired token refused; teardown.
- **PR:** `feat(gateway): VNC relay over the agent's outbound socket`

#### T25 · Worker integration (needs T00; merges after T20)
- **Owns:** `apps/worker/src/queues/{post-publish.ts,session-idle.ts,browser-health.ts}`, `apps/worker/src/roles/core.ts` schedules.
- **Build:** on `NeedsBrowser`, keep today's notification and, for DMs and verification recovery only (PLAN §14),
  enqueue `action.*` on the profile's node queue; on hand-back, re-enqueue. `session.idle` enqueues `profile.stop`.
  `browser.health` every 2 min enqueues `health.check` per online node and records seats. Accounts paused with any
  `PauseReason` are skipped by `post.publish` with a clear reason.
- **Tests:** extend `post-publish.test.ts`: fallback enqueued only for allowed types; paused account not posted.
- **PR:** `feat(worker): browser fallback, idle stop and node health`

### Wave 3 (parallel)

#### T30 · Browsers UI (needs T20)
- **Owns:** `apps/web/components/browsers/{ProfileTable.tsx,ProfileEditor.tsx,view.ts}`, `apps/web/app/(app)/browsers/**`.
- **Build:** show node, live status and pause reason (`node_offline`, `license_denied`, `needs_human`) and a resume
  action for Admins. Check `docs/design/Browsers.dc.html` first; anything the artboard does not show gets the
  smallest form that fits and a note in the PR for DECISIONS.
- **PR:** `feat(browsers): node status and pause reasons`

#### T31 · Proxy connection test (needs T20, T22)
- **Owns:** `apps/worker/src/gateway/geo.ts`, proxy test action wiring in the Browsers screen.
- **Build:** gateway resolves both exit IPs with GeoLite2 (`GEOLITE2_DB` on a gateway volume), stores `Proxy.lastTest`,
  raises the region-mismatch warn rule; fails when page IP and agent IP differ from the proxy.
- **PR:** `feat(browsers): proxy connection test from page and agent`

#### T32 · Node deployment (needs T12, T21; G3)
- **Owns:** `deploy/node/**` (new): `compose.yml` (agent + socket mount + restart policy), `install.sh`, env template,
  restic weekly backup of `tl-profile-*` volumes, `.github/workflows/deploy-node.yml` for a self-hosted runner on the node.
- **Done when:** a fresh VM goes from `install.sh` to `online` in the gateway in under 10 minutes.
- **PR:** `feat(ops): browser node install and deploy`

#### T33 · Observability (needs T20)
- **Owns:** `apps/worker/src/otel.ts`, `apps/web/instrumentation.ts`, `apps/node-agent/src/otel.ts`.
- **Build:** OTel SDK reading Railway's `OTEL_*` variables in web, worker and gateway; spans per browser job with
  node, profile and outcome; agent errors to Sentry (`SENTRY_DSN`), never with secrets.
- **PR:** `feat(ops): tracing for gateway and browser jobs`

#### T34 · Staging end-to-end (needs Wave 2, T32; G2, G3)
- **Owns:** `apps/web/tests/e2e/browser-fallback.spec.ts`, `docs/RUNBOOK-nodes.md`.
- **Build:** staging Railway env + `browser-1` pointed at it. Flow: approved DM draft → browser fallback → forced
  verification page → owner takes over over VNC → hand back → queue finishes the post. In CI the same spec runs
  with FakeAgent and fixtures; on staging it runs against a private test subreddit, never in CI.
- **PR:** `test(e2e): browser fallback with VNC take-over`

### Wave 4

#### T40 · Acceptance and docs
- **Owns:** `docs/PLAN.md` (§2, §8 M6 boxes, §12, §14), `docs/DECISIONS.md`, `docs/adr/0001-infrastructure.md` status.
- **Do:** run PLAN M6 acceptance on staging, then production with one real account; run a PITR restore drill and
  record the time (target < 15 min); mark ADR-0001 Accepted.
- **PR:** `docs: M6 acceptance and infra decisions`

## 5. File ownership by wave

| Path | W0 | W1 | W2 | W3 | W4 |
|---|---|---|---|---|---|
| `packages/shared/src/*`, `schema.prisma`, `packages/db/src/repos/{nodes,browsers}.ts` | T00 | — | — | — | — |
| `apps/worker/src/index.ts`, `roles/*` | | T10 | T25 (`roles/core.ts` schedules) | | |
| `apps/worker/src/gateway/{index,server,hub,auth}.ts` | T00 (`index.ts` stub) | T11 | | | |
| `apps/worker/src/gateway/{dispatch,outcomes}.ts` | | | T20 | | |
| `apps/worker/src/gateway/vnc.ts` | | | T24 | | |
| `apps/worker/src/gateway/geo.ts` | | | | T31 | |
| `apps/worker/src/queues/{post-publish,session-idle,browser-health}.ts` | | | T25 | | |
| `apps/node-agent/**` (core) | | T12 | | | |
| `apps/node-agent/src/{docker.ts,handlers/profile.ts}` | | | T21 | | |
| `apps/node-agent/src/{actions/**,handlers/actions.ts}` | | | T22 | | |
| `apps/node-agent/src/{vnc.ts,handlers/vnc.ts}` | | | T24 | | |
| `apps/browser-profile/**`, `scripts/browser-probe.ts` | | T13 | | | |
| `packages/node-testkit/**`, `tests/fixtures/reddit-pages/**` | | T14 | | | |
| `apps/web/server.ts`, `api/vnc/**`, `VncViewer.tsx` | | | T23 | | |
| `apps/web/components/browsers/*` (other), `(app)/browsers/**` | | | | T30 | |
| `railway.json`, `Dockerfile`, `.github/workflows/*` | | T16 | | T32 (`deploy-node.yml`) | |
| `deploy/db-backup/**` / `deploy/node/**` | | T17 | | T32 | |
| `docs/PLAN.md`, `docs/DECISIONS.md` | T00 | | | | T40 |

Each node-agent handler file registers itself in `apps/node-agent/src/handlers/index.ts`, which T12 creates with one
import line per handler module already present (stubs), so Wave 2 tasks replace stubs without editing it.

## 6. Coordinator checklist

- [ ] Get G0–G4 decisions from the owner; log G0 in docs/DECISIONS.md.
- [ ] Dispatch T00 alone; review that §3 matches the merged code exactly.
- [ ] Dispatch Wave 1 (T10–T14, T16) in parallel; run T15 and T17 with the owner.
- [ ] Merge order in Wave 2: T25 rebases after T20; T23 and T24 can merge in any order.
- [ ] After each wave: `pnpm typecheck && pnpm lint && pnpm test` on `main`, then deploy to staging.
- [ ] Before production: T13 probe output, T34 staging run and the restore drill time are in the PRs.
