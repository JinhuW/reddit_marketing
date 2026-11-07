# Changelog

## Unreleased

### M0 · Foundation
- Monorepo (pnpm, Turborepo, Biome), apps/web, apps/worker, packages/db|shared|agents|ui-tokens.
- Prisma schema for every entity in the plan, first migration (pgvector HNSW, append-only AuditEvent), seed from
  the mockup sample data.
- Auth.js magic link (+ Google when configured), workspace roles, `requireRole()`.
- App shell from the Sidebar/Topbar artboards, design tokens, dark mode, SSE counts, every route.
- CI: lint, typecheck, migration drift check, unit tests, Playwright.

### First pass at M1–M5 and M8 screens
- Every screen from the canvas on real seed data, with Playwright coverage (61 e2e tests).
- Drafts repository with the approval gate: transitions in transactions with AuditEvents; approve/schedule refuse
  when a block rule fails or the actor cannot approve.
- Worker: draft.generate (Claude tool loop → pending Draft + tracked link + rule checks) and post.publish (the
  only posting path; re-checks every block rule at post time), both with DB-backed integration tests and fakes.
- Link rule now counts bare `domain.tld/path` links and the workspace short host.
- `Draft.subredditId` for new posts.
- /r/[slug] redirector, tl.js, /api/tl/collect, attribution.rollup.
