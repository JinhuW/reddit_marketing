# Decisions

Running log of choices made while building that docs/PLAN.md left open or that differ from it.
Newest first.

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
