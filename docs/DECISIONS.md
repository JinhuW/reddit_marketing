# Decisions

Running log of choices made while building that docs/PLAN.md left open or that differ from it.
Newest first.

## 2026-11-08 · One person may own several Reddit accounts; "one voice per thread" replaces "one account per person"

- Asked for by the workspace owner: one person (a founder running a personal and a brand account, an agency
  member running client accounts) needs more than one account. `RedditAccount.ownerMemberId` is no longer unique
  (migration `20261110000000_accounts_per_owner`); `WorkspaceMember.ownedAccounts` is a list.
- The old block rule (`assertOneAccountPerMember`) existed to stop sockpuppeting. It is **replaced, not dropped**,
  by a block rule aimed at that harm directly: `one_voice_per_thread` in `evaluateDraft` fails when another
  account of the same owner already has an approved, scheduled or posted draft on the same Reddit post, started
  the thread, or is the DM counterpart. It runs at generation, edit, approval and again at post time
  (`drafts.buildRuleContext` → `ownerOtherAccounts`). Pending drafts do not count, so two agents may both draft
  for a thread; whichever is approved first wins and the other can no longer be approved.
- The cap is now the plan's account limit (`PLAN_LIMITS[plan].accounts`, Starter 1 / Pro 5 / Agency 20), enforced
  in `accounts.connect` and `accounts.startBrowserConnect` and before the OAuth redirect. Blocked accounts
  (disconnected or banned) do not count. A person's unfinished browser connect is still resumed rather than
  starting another, so pending accounts do not pile up.
- Unchanged: every account belongs to a real member who signs in themselves, has its own disclosure line, its
  own browser profile (named "Jane · Chrome 2", "… 3" for later ones) and its own daily and self-promo limits.

## 2026-11-08 — Cloudflare edge, Next.js stays on Railway

- **The web app is not moved to Cloudflare Workers.** `apps/web` is a full Next.js server, not a static frontend:
  most pages and server actions read Postgres and Redis directly, and `server.ts` handles the VNC websocket. On
  Workers it would need Prisma's driver adapter with a client per request, Hyperdrive through a Cloudflare Tunnel
  (or a public Postgres TCP proxy, which ADR-0001 rules out), an HTTP queue API on `node-gateway`, and a rewritten
  VNC proxy, and every page query would cross from the edge to us-east4. The owner chose to harden the edge
  instead. Revisit if `/r` or `tl.js` traffic grows; move those public routes to the edge first.
- **`threadline-edge` lives in `deploy/cloudflare`** (deploy with `deploy/cloudflare/deploy.sh`; tests:
  `node --test deploy/cloudflare/worker.test.mjs`). It redirects http → https and forwards everything to Railway
  `web`, with two additions:
  - It caches `/_next/static/*` at the edge (`immutable`, one year), and only when the response is a 200. A miss
    gets `no-store`, so a chunk that 404s during a deploy is never cached.
  - It adds per-IP flood guards from Workers rate-limit bindings, counted per Cloudflare location:
    `POST /api/tl/collect` above 300/60 s and `/r/*` above 600/60 s get a 429. Both sit well above the app's own
    Redis limits, because a tracked link must keep working. A missing or failing limiter lets the request through.

## 2026-11-07 — browser node contracts (infra plan T00)

- **Contracts live in `packages/shared`**: `enums.ts` (BrowserNodeStatus, PauseReason, BrowserOutcome, CloakPersona,
  CloakGpu, NodeEventKind, new AuditActions), `queues.ts` (`browserQueue`, `BrowserJob`, `BrowserJobSchema`,
  `browserJobId`) and `node-protocol.ts` (zod schemas for every frame). BrowserOutcome, CloakPersona and CloakGpu
  are not Prisma enums: the outcome is never stored, and the plan stores persona/GPU as text.
- **The fingerprint salt is kept in `BrowserProfile.fingerprint.cloakSalt`**, not a new column: §3.1 lists no salt
  column. `cloakSeed = sha256("<profileId>:<salt>")[0..4] >>> 1`, so it fits Postgres `int` and can be re-derived.
  The first `ensureCloakFingerprint` wins through a conditional update; later calls return the stored values.
- **`deadlineMs` in `command` is a duration** (ms from receipt), not an epoch time, so clock skew between Railway and
  a home VM cannot expire a command early. `ProfileRef = { profileId, startedAt }` (epoch ms, agent clock).
  `Hello.imageDigest` may be null before the image is pulled.
- **Protocol parse errors never echo the frame**: a `profile.start` carries decrypted proxy credentials, and Node's
  JSON parse errors quote the input. Errors carry only paths and messages.
- **Browser job ids**: `bj-<kind>-<draftId|profileId>`; `health.check` uses the workspace id plus an optional suffix
  (a time bucket) so a repeating job is not deduplicated against the last one. `BrowserJobSchema` is `.strict()`
  so no extra field (e.g. a credential) can ride in a payload.
- **Node token auth**: `nodes.verifyToken(name, token)` matches by name across workspaces and compares sha256
  hashes in constant time; rows returned by the nodes repo never include `tokenHash`. Tokens shorter than 16 chars
  are refused. The dev seed's `browser-1` uses `NODE_TOKEN_BROWSER_1` or `dev-node-token-browser-1`.
- **Pauses: the first reason wins.** Pausing an already-paused account is a no-op without an audit row, so a later
  `node_offline` cannot hide a `needs_human`. `resumeAccount({ onlyReasons })` lets the gateway clear only
  `node_offline` pauses when a node returns.
- **Node status audits on transitions only**: `node.online` when the node was not online, `node.offline` when it
  was not offline; heartbeats write no audit rows.
- **Postgres is 18 on Railway, 16 locally and in PLAN.** pgvector and both earlier migrations work on 18; the
  `browser_nodes` migration uses only enum, column, table and FK DDL, which behave the same on both.

## 2026-11-07 — M0 and first pass at every screen

- **Embedding dimension is 512, not 1536.** The plan's default provider (Voyage `voyage-3-lite`) returns 512-d
  vectors. `ContextItem.embedding` is `vector(512)`; changing provider means a migration.
- **HNSW index and AuditEvent append-only rule live in raw SQL** in the init migration. Prisma cannot model either.
  Append-only is a `BEFORE UPDATE OR DELETE` trigger (works even for a superuser in dev); production should
  also `REVOKE UPDATE, DELETE` from the app role. The seed uses `TRUNCATE`, which the trigger does not block.
  `pnpm --filter @threadline/db migrate:check` allows exactly that one index difference.
- **`User.image` instead of `avatarUrl`.** The Auth.js Prisma adapter requires the field name.
- **Sign-in is invite-only.** The `signIn` callback refuses emails with no `WorkspaceMember` row.
- **Dev mail sink.** With no `RESEND_API_KEY`, magic links are printed to the web log and appended to
  `data/dev-mail.log`; Playwright signs in through the real flow by reading it.
- **No Next.js middleware for auth.** Database sessions + Prisma can't run on the edge runtime; the `(app)` layout
  calls `requireMember()` and every server action / route handler calls `requireRole()`.
- **Approval rights = role ≥ approver AND `canApprove`.** An Admin needs `canApprove` too (Jane has it).
- **Docker is not available in the build sandbox**, so Postgres 16 (+ apt `postgresql-16-pgvector`) and Redis 7
  ran natively. `docker-compose.yml` is the supported local setup.
- **LLM calls use `tool_choice: auto` + `strict: true` tools + an explicit "call the tool" instruction**, never
  forced tool choice: newer Claude models reject forced `tool_choice`, and model ids are swappable via env.
  Model ids stay as the plan's `.env.example` defaults.
- **Scoring uses `LLM_MODEL_DRAFT`.** `LLM_MODEL_FAST` is reserved for the classification-only paths.
- **Seed volumes are generated** where the mockup shows totals (e.g. 33 filler opportunities, click events spread
  over 30 days with a deterministic PRNG) so dashboards compute real numbers from rows instead of hard-coded copy.
- **`@playwright/test` pinned to 1.63.0** to match the browsers preinstalled in the build environment.

## 2026-11-07 — screens and worker wiring

- **BullMQ job ids use `-`, not `:`** (BullMQ rejects colons in custom ids): `draft-<id>`, `draft-<id>-v<n>`, `post-<id>`.
- **Context search is keyword (ILIKE) until `context.embed` runs**; the pgvector HNSW index is in place.
- **Reddit OAuth callback stores the identity in a 15-minute encrypted cookie**; the final step of the connect
  flow creates the account, browser profile and `account.connected` audit row in one transaction, so the flow
  keeps the artboard's order (Reddit first).
- **Disconnecting an account** clears its token and scopes and sets health `blocked`; history is kept.
- **NeedsBrowser (captcha/verification) leaves the draft approved** and notifies the account owner; the M6 browser
  fallback will pick it up.
- **Share of voice** is horizontal bars over 30 days instead of the artboard's weekly lines (no chart library yet).

## 2026-11-07 — infrastructure (ADR-0001)

- **G0: M6 browser-node infra starts before M1–M5 acceptance.** The owner asked to start the infra plan
  (`docs/plans/0001-infra-implementation.md`) now. Code-only tasks run; anything that needs the domain (G1),
  a CloakBrowser key (G2), a local VM (G3) or a Railway change (G4) stops at "ready, not applied".
  M1–M5 acceptance is still required before M6 is ticked in PLAN §8.
- **Browser nodes dial out to a Railway `node-gateway` over WSS** (ADR-0001). Postgres and Redis stay private.
- **Browser node names are unique across workspaces.** The name is the `browser.<name>` queue and the gateway
  login (`X-Node-Name`), so `@@unique([workspaceId, name])` became `name @unique`; `nodes.register` refuses a
  name another workspace owns.
- **First CloakBrowser pin: `156.0.8078.47.1-pro` (linux-x64), team plan.** Fetched once on the node with the npm
  package's signed download (Ed25519-checked), packed as the `vendor/` archive (sha256
  `a27a3d95619a43b1ac93fa42c71beb0e4e59b02fc1a661d0873ff084022ccffb`). A build bump is a device change (ADR).
- **Chromium keeps its sandbox on the node** via a seccomp profile = Docker's default plus `clone`, `clone3`,
  `unshare`, `setns` (Ubuntu 24.04 + Docker's default profile otherwise kills the zygote: "No usable sandbox").
  The agent passes it with `BROWSER_SECCOMP_PROFILE`. `--no-sandbox` is not used.
- **`browser-1` runs on the homelab VM and dials the gateway's Railway domain** until the custom domain exists
  (G1); `GATEWAY_URL` is the only thing to change then. It starts at `NODE_MAX_PROFILES=1`.

## 2026-11-07 — Browser mode (plan 0002)

Accounts can connect without a Reddit API app: a person signs in inside the account's browser profile and the
node reads the identity. Spec: `docs/plans/0002-browser-mode.md`.

**Data and gate**

- **`RedditAccount.authMode` (`oauth` | `browser`) and `identifiedAt`.** A browser account starts as
  `pending-<id>` with `redditId` `pending:<id>` and `identifiedAt` null; `accounts.completeBrowserIdentity` sets
  the real username, `t2_<id>` and `identifiedAt` and writes `account.connected`. It is idempotent and refuses a
  Reddit user already connected in the workspace (`AccountConflictError`).
- **The "signed in" check lives inside the existing `account_eligible` block rule**, not a new rule, so the
  checks list keeps its shape. Drafts for an unidentified account can be neither approved nor posted; the
  gateway also refuses `action.*` jobs for them. No rule was weakened.
- **`nodes.pickForProfile` takes no lock.** Two connects at the same moment can push a node one profile over
  `maxProfiles`; accepted for now. A hard cap would lock the node row (`SELECT … FOR UPDATE`) inside the tx.

**Node agent and gateway**

- **`profile.whoami` loads `/api/me.json` in a tab of the profile's own context.** A redirect to the login page
  is `ok {loggedIn:false}` (it is exactly "not signed in"), not `needs_human`; captcha and verification walls are
  `needs_human` and keep the tab for take-over. The body and cookies are never logged.
- **whoami results are never cached by the node's dispatcher**, because its cmdId is the same for every check
  on a profile and a stored `loggedIn:false` would be replayed.
- **The gateway returns whoami as `{outcome:'ok', data}`**; a duplicate identity fails the job as final with
  code `identity_conflict`, malformed data as `bad_whoami_data`.
- **Refused-before-send failures carry the prefix `refused: `.** When the dispatcher refuses a job before
  anything reaches the node, the failure text starts with `refused: ` (`DISPATCH_REFUSED_PREFIX`). Anything that
  matches failure text, including the web UI, must expect it.

**Posting and polling**

- **Browser-mode accounts never call the Reddit API to post.** After the same `assertPublishable` check,
  comment and DM drafts go to the node's browser queue (`bj-action.<kind>-<draftId>`). New threads (`post`
  drafts) are failed with "New threads are not supported in browser mode; nothing was sent."
- **Re-queue only after a clean refusal.** Approved drafts are swept every minute; if the earlier browser job
  was refused before send, post.publish re-queues as `<id>-r1` … `-r3`. Any other finished job may have reached
  Reddit, so it is never re-sent: the account is paused with `needs_human`.
- **Without a Reddit app, `reddit.poll` reads the public Atom feed** (`/r/<sub>/new/.rss?limit=100`), because
  `new.json` returns 403 without OAuth. Plain User-Agent, optional `REDDIT_READ_PROXY_URL`, 1 request per 3 s per
  process, 429 honoured (Retry-After or backoff from 10 s; a wait over 60 s fails the run). Feed posts carry no
  score or comment count, so those are 0 on insert and left alone on update. Polling is now always scheduled.
  The plan doc still describes `new.json`.

**Web UI additions not shown on the artboards** (each in its smallest form)

- Browsers table: a **Node column** (name, Online/Offline/Draining below) and a **"Paused · <reason>" chip**
  under Status (Needs a human, No browser seat, Node offline, Proxy failed, Paused by an admin).
- Profile editor: a **"Browser" block** at the top with status, Admin **Assign node** (online nodes plus
  Unassigned; an offline current node stays listed), a pause banner with Admin **Resume**, a "Sign in now" link
  for an unidentified account, and **Start / Stop / Open browser** for the admin or the account owner. Save stays
  in the header and submits the proxy form through `form=`.
- **"Use a saved proxy"** select above the proxy fields; labels are provider · host:port · profile count, never
  credentials.
- Connect step 1 in browser mode: **"Connect through the browser"** with a short explanation and a Proxy select.
  It is the first choice when no Reddit app is configured, the second when one is.
- Session page: a **sign-in panel** above the viewer ("I'm signed in" runs whoami and checks every 3 s for 60 s;
  then "Signed in as u/name" + "Hand back and finish", "Not signed in yet", or the error) and a warning note when
  the node is missing or offline. Take-over now also queues `profile.start`; hand back leaves the stop to the idle
  sweep.
- Accounts card: **"Waiting for sign-in"** title and chip with an "Open sign-in" strip, and a "Browser sign-in"
  chip once connected. Pending accounts cannot be removed from the UI yet (Disconnect is hidden).
- The Browsers page **refreshes itself every 10 s** while the tab is visible.
- The web app copies the gateway's browser job options (`BROWSER_JOB_OPTIONS`) because it cannot import
  apps/worker; moving them to packages/shared is a later clean-up.

## 2026-11-08 · An unfinished browser connect is resumed, not counted as the owner's account

- A browser-mode account that was started but never signed in to (`authMode` browser, `identifiedAt` null) used
  to block its owner from connecting again ("You already own u/pending-…"), with no way to remove it.
- `accounts.startBrowserConnect` now **resumes** it: role, disclosure line and limits are updated, the chosen proxy
  is attached, a node is assigned if it has none, and `account.connect_started` is written with `resumed: true`.
  The profile and its fingerprint are kept. The connect form says it picks up u/pending-… where it left off.
- The one-account-per-person block rule is unchanged: once the account has a Reddit identity, a second connect
  is refused. OAuth connect still refuses while a pending browser account exists (it cannot reuse it).

## 2026-11-08 · Browsers are created on their own; an account is assigned to one

Plan: docs/plans/0003-standalone-browsers.md. The Design canvas has no artboard for this yet; the screens follow the
existing Browsers editor and the owner's reference (an anti-detect-browser "edit account" dialog).

- `BrowserProfile.accountId` is optional. **One account per browser at a time**, an account in at most one browser
  (`@unique`). Assign / unassign write `profile.account_assigned` / `profile.account_unassigned`, and both are
  refused while someone has control of the browser. Deleting an account keeps its browser.
- An account-less browser is controlled by admins and its creator (`createdByMemberId`). It is never dispatched
  for actions. Assigning an existing account also needs admin or that account's owner, so nobody can move someone
  else's account into their own browser.
- The **password and 2FA secret** are stored encrypted on the account and used only by the gateway to build
  `profile.signIn`. That command fills reddit.com/login and the TOTP code, and a captcha or check falls back to
  the VNC take-over. Audit records which fields changed, never the values.
- **Start tab and cookies** live on the browser. Pasted cookie JSON is encrypted, imported on the next
  `profile.signIn` and then deleted (the profile's own volume keeps them).
- Identity: an account added by name must be signed in as that name. `completeBrowserIdentity` refuses any other
  user, so a browser whose cookies still hold the previous account cannot pass as the new one.
- The `/accounts/connect` browser flow is unchanged. It resumes only its own `pending-…` placeholders, never an
  account added by name.

## 2026-11-08 · Continuous deployment from main

- Every push to `main` deploys to production once its GitHub checks pass (owner: "always deploy once merged to
  main"). Railway follows the repo (`main`, Wait for CI) instead of `railway up` from a laptop, so no Railway token
  lives in GitHub. All three Railway services run `migrate:deploy` before start (Prisma's advisory lock serializes
  them), which fixes the race where the gateway started before `web` had migrated.
- Browser nodes deploy through a self-hosted runner on the homelab (user systemd service, linger), only when node
  files changed since the last node deploy, so an unrelated commit never restarts the agents.
- A missing `CLOAKBROWSER_LICENSE_KEY` now skips the browser-profile image with a warning instead of failing the
  release, since a red release commit would hold back the Railway deploy.
- GitHub Actions may now open PRs (repo setting), so release-please runs in CI again. PRs it opens with
  `GITHUB_TOKEN` do not trigger other workflows; the code in them already passed CI on `main`.

## 2026-11-09 · Releases cut entirely in GitHub Actions

- `release.yml` merges the release-please PR, tags it and builds the images. Before this, release-please ran from a
  laptop (`npx release-please …`, `gh pr merge`), because the workflow targeted the repo's default branch
  (`claude/pensive-galileo-2wyj7e`) instead of `main`. It now pins `target-branch: main`, and `main` is the
  default branch.
- release-please uses `RELEASE_TOKEN`, a fine-grained PAT limited to this repo (Contents and Pull requests), rather than `GITHUB_TOKEN`.
  Railway held the first bot-merged release commit (v0.6.1) as NEEDS_APPROVAL, and a `GITHUB_TOKEN` push starts no
  workflows. Without the secret the workflow still releases, by dispatching CI and images.yml itself; images.yml is dispatched, not called, because the called job's GHCR push was refused.
  `AUTO_RELEASE=false` (repo variable) pauses at the release PR for a human review.

## 2026-11-09 · Guardrails for deploy-on-every-commit

- **Migration guard** (CI job, so it gates Railway's "Wait for CI"). A new migration that can lose data fails unless
  it carries `-- allow-destructive: <reason>`, and editing a migration already on `main` always fails. It works from
  a pattern list, not a SQL parser: it can over-flag (any `RENAME`), and the marker is the way through.
- **Smoke check** after Railway reports a deployment success. It checks the served build id, `/login` and the
  gateway `/healthz`. It alerts through a `prod-smoke` issue, because nobody is notified about a failed run that
  Railway's bot started. It does not roll back on its own: that would need a Railway token in GitHub, which ADR-0001
  avoids.

## 2026-11-12 · Browsers page grows toward an anti-detect browser manager (plan 0004)

- Scope and what is deliberately left out (RPA, Local API, synchronizer): `docs/plans/0004-browser-parity.md`.
  The line is the approval gate: nothing that could drive a browser to post outside an approved Draft.
- `BrowserProfile.status` now follows the node (heartbeat list, start/stop results). An offline node's profiles
  read `idle`; `check` / `error` on a stopped profile stay until it runs again.
- The connection test's place comes from a geo lookup the agent makes through the proxy (default
  `https://ipinfo.io/json`), not from a GeoLite2 file on the worker: the agent is already on the proxy path and the
  worker image stays free of a database to refresh. A lookup that fails only leaves the place out.
- A test where the page and the agent leave through different addresses is stored as failed (`ip_mismatch`).
- "Reddit reachable" no longer shows a status code (the artboard's "Yes · 200"): the check is "answered below 500".
