# Decisions

Running log of choices made while building that docs/PLAN.md left open or that differ from it.
Newest first.

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
