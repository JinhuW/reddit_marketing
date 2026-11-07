# Threadline

Reddit marketing platform: find buying conversations, let AI agents draft replies a human approves,
track engaged users as leads, attribute clicks/signups/revenue. Full plan: docs/PLAN.md (read it first).
UI spec: the Design canvas "Threadline — Rounded Inter"; each screen in docs/PLAN.md §7 names its artboard.
Exported artboard sources live in docs/design/*.dc.html.

## Stack
pnpm + Turborepo monorepo. apps/web = Next.js 15 App Router + Tailwind v4 + shadcn/ui. apps/worker = BullMQ.
packages/db = Prisma 6 (Postgres 16 + pgvector). packages/agents = LLM runtime. packages/shared = zod + enums.

## Commands
pnpm dev · pnpm test · pnpm test:e2e · pnpm typecheck · pnpm lint (Biome) · pnpm db:migrate · pnpm db:seed

## Rules
- Work milestone by milestone from docs/PLAN.md §8. Tick its checkboxes as you finish them; do not start the
  next milestone until the acceptance criteria pass.
- DB access only through packages/db repository functions. Enums only in packages/shared/enums.ts.
- Every state transition on Draft, Lead, RedditAccount, BrowserSession writes an AuditEvent.
- Never add a code path that posts to Reddit without an approved Draft and an approverMemberId.
- Never weaken a `block` rule in packages/agents/rules.ts; add tests for any rule you touch.
- Secrets: env only; tokens encrypted with APP_ENCRYPTION_KEY; never log them.
- UI: use tokens from packages/ui-tokens; Inter; tabular numbers; 1px borders, no shadows; radii 16/12/9/999.
  Match the artboard before adding anything it does not show.
- Tests: Vitest for packages, Testcontainers for queues, Playwright for flows. Record Reddit/LLM fixtures
  under tests/fixtures; never call live services in CI.
- Commit style: Conventional Commits, `feat(approvals): …`, `fix(worker): …`; one milestone task per PR where
  practical. PR titles are Conventional Commits too (squash merge). Never hand-edit CHANGELOG.md or versions:
  release-please generates them. Process: docs/RELEASING.md.

## When unsure
Prefer the simpler option that keeps the human-approval gate intact, then leave a note in docs/DECISIONS.md.
