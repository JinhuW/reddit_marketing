# Threadline

Reddit marketing platform for SaaS teams: finds buying conversations on Reddit, lets AI agents draft replies
that a human approves before anything is posted, tracks everyone who engages as a lead, and attributes clicks,
signups and revenue back to each thread.

- Plan and milestones: [docs/PLAN.md](docs/PLAN.md)
- Decisions log: [docs/DECISIONS.md](docs/DECISIONS.md)
- Releasing and changelog: [docs/RELEASING.md](docs/RELEASING.md) · [CHANGELOG.md](CHANGELOG.md)
- Working with Claude Code: [CLAUDE.md](CLAUDE.md)

## Local development

```bash
cp .env.example .env   # fill APP_ENCRYPTION_KEY and AUTH_SECRET: openssl rand -base64 32
docker compose up -d postgres redis jaeger
pnpm install && pnpm db:migrate && pnpm db:seed
pnpm dev               # web on :3000, worker with hot reload
```

Sign in as `jane@acme.so`. Without `RESEND_API_KEY`, the magic link is printed in the web log and appended to
`data/dev-mail.log`.

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` (needs the dev server and seed).
