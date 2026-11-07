# Changelog

## Unreleased

### M0 · Foundation
- Monorepo (pnpm, Turborepo, Biome), apps/web, apps/worker, packages/db|shared|agents|ui-tokens.
- Prisma schema for every entity in the plan, first migration (pgvector HNSW, append-only AuditEvent), seed from
  the mockup sample data.
- Auth.js magic link (+ Google when configured), workspace roles, `requireRole()`.
- App shell from the Sidebar/Topbar artboards, design tokens, dark mode, SSE counts, every route.
- CI: lint, typecheck, migration drift check, unit tests, Playwright.
