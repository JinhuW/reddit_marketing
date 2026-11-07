# Threadline — Implementation Plan

Nov 7, 2026 · Jinhu Wang

> Exported from the planning doc. Milestone checkboxes (§8) are ticked as work lands; see docs/DECISIONS.md for
> choices the plan left open.

## 1. Overview

Threadline is a Reddit marketing platform for SaaS founders, marketing teams and agencies. It finds buying
conversations on Reddit, lets AI "agent employees" draft replies that a human approves before anything is posted,
tracks everyone who engages as a lead, and attributes clicks, signups and revenue back to each thread. The UI is
designed on the canvas **Threadline — Rounded Inter** (artboard sources in `docs/design/`).

### Goals for v1 (single-tenant Pro plan, one workspace)
- A full loop that works end to end: keyword match → scored opportunity → agent draft → human approval → post from
  the owner's own Reddit account → engaged user becomes a lead → tracked link click → signup/payment attributed.
- Three agent personas (Maya, Leo, Sam) with editable persona, skills, context and assignment.
- A dedicated browser profile per connected account with its own proxy, plus a VNC take-over view.
- Every posted item records who approved it, which account posted it, and that a disclosure was present.

### Non-goals for v1
- Multi-workspace agency billing and white-label reports (schema supports it; UI ships later).
- Blog or backlink agents, account "warming", or any automation that posts without an approval.
- Native mobile apps. The web app is responsive down to tablet only.

### How to use this plan with Claude Code
1. Create the repo, paste section 13 into CLAUDE.md, and commit this doc as docs/PLAN.md.
2. Work milestone by milestone (section 8). Each milestone lists its tasks as checkboxes, the files it touches, and
   the acceptance criteria that gate the next one.
3. Every screen has a route and a component list in section 7; the mockup artboard is the source of truth for
   layout and copy.
4. Anything marked *decide* in section 14 should be settled before the milestone that needs it.

## 2. Stack and architecture

One TypeScript monorepo, Postgres as the single source of truth, Redis-backed workers for everything that talks to
Reddit or an LLM, and one Docker container per browser profile. Everything self-hosts with Docker Compose on a
single server for v1.

| Layer | Choice | Why |
|---|---|---|
| Web app | Next.js 15 (App Router, React 19, TypeScript, Tailwind v4) | Server components for data-dense pages, route handlers for webhooks and the link redirector, one deploy unit |
| UI kit | shadcn/ui on Radix, restyled with the Threadline tokens (§7) | Accessible primitives, owned code, matches the rounded Inter mockups |
| Data | Postgres 16 + Prisma 6 | Relational model (leads, drafts, audit) fits; Prisma migrations are easy to evolve |
| Jobs | BullMQ on Redis 7, in apps/worker | Polling Reddit, scoring, drafting, posting and syncing must be retryable and rate-limited per account |
| Auth | Auth.js v5 with email magic link + Google; roles Admin / Approver / Editor / Viewer | Standard, no password storage |
| Reddit | Official OAuth2 (identity read submit privatemessages history) per connected account; thin in-house client on fetch | Posting via the API from the owner's own token is the compliant default |
| Browser profiles | One container per account: Chromium + Xvfb + x11vnc + websockify (noVNC), driven by Playwright over CDP; proxy per container | Needed when a step cannot go through the API, and to give each account one stable device and exit IP |
| LLM | Anthropic Claude via @anthropic-ai/sdk with tool use; MCP client for connectors | Agents are prompts + tools + a knowledge base, not fine-tunes |
| Vectors | pgvector on the same Postgres | Agent context search without a second datastore |
| Tracking | Route handler /r/[slug] for short links; tl.js site snippet; Stripe webhooks | All attribution data lands in the same DB |
| Realtime | Server-Sent Events from /api/events | Simpler than websockets; VNC has its own websocket via noVNC |
| Observability | pino logs, OpenTelemetry traces to a local Jaeger, Sentry optional | Agent runs must be debuggable step by step |
| Testing | Vitest (unit), Playwright (e2e), MSW for Reddit/LLM mocks | See §11 |
| Package tooling | pnpm workspaces + Turborepo, Biome | Fast, one config |

### Service boundaries
- **apps/web** serves the UI, auth, route handlers (webhooks, link redirects, SSE) and reads/writes Postgres directly
  through packages/db.
- **apps/worker** runs all BullMQ queues. It is the only process that holds Reddit tokens in memory and the only one
  that talks to browser containers.
- **apps/browser-profile** is a Docker image; the worker starts one container per BrowserProfile row with the
  profile's proxy and persistent /data volume, and exposes CDP on an internal network plus noVNC behind the web
  app's authenticated proxy route.
- **packages/agents** holds agent runtime code (prompt assembly, tools, rule checks) shared by the worker and the
  "Test the agent" playground.

The web app never touches Reddit or an LLM directly; the only route from a person to a browser container is the
authenticated VNC proxy.

## 3. Repository layout

See the repository tree; conventions:
- Feature code lives in `apps/web/components/<feature>/`; a page file only composes components and loads data.
- All DB access through packages/db repository functions, never raw Prisma in components.
- Every cross-package type is a zod schema in packages/shared; the API and the worker validate at the boundary.
- Enum values live once in `packages/shared/src/enums.ts` and mirror the Prisma enums.
- Secrets only from env; tokens encrypted at rest with AES-256-GCM using `APP_ENCRYPTION_KEY`.

## 4. Data model

Every table carries id (cuid), workspaceId, createdAt, updatedAt. Post and RedditUser are deduplicated per
workspace by Reddit's own ids so one person stays one lead across threads. The authoritative definition is
`packages/db/prisma/schema.prisma` (Workspace, User, WorkspaceMember, RedditAccount, BrowserProfile, Proxy,
BrowserSession, Agent, AgentSkill, ContextItem, Connector, KeywordGroup, Subreddit, AccountSubredditStat, Post,
Opportunity, Draft, RedditUser, Lead, LeadTask, Conversation, Message, TrackedLink, ClickEvent, SiteEvent,
Attribution, AuditEvent, Notification).

Indexes created up front: Opportunity(workspaceId, status, score desc), Draft(workspaceId, status, createdAt),
Lead(workspaceId, stage), ClickEvent(trackedLinkId, occurredAt), AuditEvent(workspaceId, at desc), and the pgvector
HNSW index on ContextItem.embedding.

## 5. Core flows

One loop with a human gate in the middle. Each step is a worker queue job and writes an AuditEvent.

1. **Poll** — reddit.poll every 10 minutes per KeywordGroup; include/exclude terms; upsert Post; backoff on 429;
   app client-credentials token.
2. **Score** — opportunity.score; tool `score_opportunity(score, level, intent, reason, competitors[])`;
   ≥ 60 creates an Opportunity, picks the group's agent, fires alerts.
3. **Draft** — draft.generate: persona prompt, top-8 ContextItems, tools `search_context`, `get_subreddit_rules`,
   `insert_tracked_link`, `write_draft`; rule checks; Draft saved `pending`; Opportunity → drafting.
4. **Approve** — Approve, Edit-then-approve, Regenerate, Schedule, Reject (reason required). Only members with
   canApprove may approve. AuditEvent `draft.approved` with approver, account, disclosure-present flag.
5. **Post** — post.publish re-checks limits at post time; comment `/api/comment`, post `/api/submit`, DM
   `/api/compose`; falls back to the browser profile; verification → owner takes over over VNC.
6. **Engage** — dm.poll and the comment poller create RedditUser + Lead + Conversation. DM follow-ups only for leads
   with a prior inbound Message.
7. **Attribute** — /r/[slug] logs a ClickEvent and sets `tl_vid`; tl.js and Stripe post events; attribution.rollup
   matches last click within 30 days and moves the lead stage.
8. **Sync** — lead.sync pushes leads to HubSpot.

## 6. Integrations

Reddit (OAuth2 per account, token bucket 60 req/min, app token for polling), browser profiles/proxies/VNC
(container per profile, CDP, proxy auth via CDP, GeoLite2 connection test, fingerprint captured at connect time,
authenticated VNC websocket proxy, 15-minute idle timeout), agents (prompt builder, tools, AgentRun logs, MCP
connectors for Notion/Drive/HubSpot, dry-run playground), tracking and attribution (/r/[slug], tl.js,
/api/tl/collect, Stripe webhook, HubSpot, Slack alerts).

## 7. Screens, routes and components

| Artboard | Route |
|---|---|
| Sidebar, Topbar | (app)/layout.tsx |
| 1 Home | / |
| 2 Opportunities | /opportunities |
| 3 Approvals | /approvals |
| 4 Conversations | /conversations |
| 5 Leads | /leads |
| 5b Lead detail | /leads/[id] |
| 6 Agents | /agents, /agents/[id]/(persona\|skills\|context\|connectors\|assignment\|performance) |
| 7 Analytics | /analytics |
| 8 Tracking | /tracking |
| 9 Accounts | /accounts, /accounts/connect |
| 9b Browsers | /browsers |
| 9c Remote session | /browsers/[id]/session |
| 10 Settings | /settings/(team\|audit\|billing\|workspaces\|reports) |

Design tokens: `packages/ui-tokens/tokens.css` (light/dark), mapped to Tailwind utilities in `theme.css`.
Inter via next/font, tabular numbers, 8px grid, 24px page padding, 20px between panels, 1px borders, no shadows,
radii 16/12/9/999. Dark mode via `data-theme` on `<html>` with prefers-color-scheme default.

## 8. Milestones

### M0 · Foundation
- [x] Scaffold the monorepo (pnpm, Turborepo, Biome), apps/web, apps/worker, packages/db|shared|agents|ui-tokens
- [x] docker-compose.yml with postgres (pgvector image), redis, jaeger; .env.example
- [x] Prisma schema for every entity in §4, first migration, seed.ts that loads the mockup sample data
- [x] Auth.js with magic link, WorkspaceMember roles, requireRole() helper
- [x] App shell: Sidebar, Topbar, PlanUsageCard, tokens, dark mode toggle; empty pages for every route
- [x] CI: typecheck, lint, unit tests, prisma migrate diff check

*Accepted when:* pnpm dev boots web + worker, login works, every route renders the shell with its page title,
seed data visible in Prisma Studio.

### M1 · Tracking and opportunities
- [ ] Reddit app registration, client-credentials token, reddit/client.ts with rate limiter and fixtures — client + rate limiter done; needs a registered Reddit app and recorded fixtures
- [x] KeywordGroup and Subreddit CRUD + Tracking screen
- [ ] reddit.poll queue + Post upsert; opportunity.score with the Claude scoring tool and the ≥ 60 threshold — code done and unit-tested; not yet run against live Reddit/Claude
- [x] Opportunities screen: filters, cards with keyword highlights and intent reason, detail panel, bulk actions
- [ ] Slack/email alerts per keyword group — Slack instant alerts done; email digest pending

*Accepted when:* adding a keyword group against a live subreddit yields scored opportunities within 10 minutes;
filters and bulk actions persist; a fixture run scores the sample "Asana alternative" post ≥ 85.

### M2 · Accounts and agents
- [ ] Reddit OAuth connect flow (4 steps), token encryption, owner uniqueness rule, fingerprint capture — built; untested against a real Reddit app
- [x] Accounts screen with limits and self-promo meters computed from the account's last 7 days of comments
- [ ] Agent CRUD + Persona, Skills, Assignment tabs; Context tab with URL/doc import and pgvector embeddings — all tabs done; context.embed (Voyage) pending
- [ ] packages/agents: prompt builder, tools, AgentRun logging; Test the agent playground — runtime + AgentRun logs done; playground shows the prompt, live run pending

*Accepted when:* a connected account shows real karma/age; the playground returns a draft with reasoning for the
sample post, with the disclosure line present, in under 20 s.

### M3 · Drafts and approvals (first end-to-end loop)
- [x] draft.generate queue, tracked-link minting, rule checks (§10), Draft lifecycle
- [x] Approvals screen: split view, keyboard shortcuts, edit, regenerate, schedule, reject with reason, PostingAsBanner
- [ ] post.publish via API for comments, posts and DMs; limit and ratio re-check at post time; AuditEvent on every transition — done with integration tests (fake poster); not yet posted to live Reddit
- [x] Home dashboard KPIs, hot opportunities, activity feed

*Accepted when:* Generate draft → Approve → the comment appears on Reddit under the owner's account with the
disclosure line and the tracked link, and the audit log shows approver, account and timestamp. A draft without a
disclosure cannot be approved.

### M4 · Leads and conversations
- [ ] Comment-reply and DM pollers; RedditUser, Lead, Conversation, Message creation rules
- [x] Leads kanban and table (saved views, CSV export); Lead detail with timeline, notes, tasks
- [x] Conversations three-column screen; Ask agent to draft creates a Draft that goes to Approvals
- [ ] Notifications and unread counts over SSE

*Accepted when:* a reply to our comment creates a lead in replied within 5 minutes, drag-to-stage persists, and a
DM draft for a user with no inbound message is refused with a visible reason.

### M5 · Attribution and analytics
- [ ] /r/[slug] redirector, tl.js, /api/tl/collect, Stripe webhook, attribution.rollup — all but the Stripe webhook
- [x] Analytics screen: KPI row, clicks/signups chart, revenue flow, breakdown tables, tracked links + UTM builder, integration strip
- [ ] Home funnel and leaderboard from real rollups; weekly report email and CSV export

*Accepted when:* clicking a tracked link, firing tl.track('signup') and a Stripe test payment moves the matching
lead to customer with revenue, and the thread shows the revenue in Analytics.

### M6 · Browser profiles, proxies and VNC
- [ ] apps/browser-profile image; browser/manager.ts (dockerode) with per-profile volume and proxy env; health checks
- [ ] Browsers screen: profile table, proxy editor, connection test, region-mismatch warning, fingerprint, permissions — screen done; connection test runs in the worker (M6)
- [ ] Playwright actions openThread, submitComment, sendDm; NeedsHuman detection; post.publish browser fallback
- [ ] Remote session screen: noVNC viewer behind the authenticated websocket proxy, take-over, session log, Hand back, idle timeout

*Accepted when:* a profile starts with its proxy and the test shows the expected exit IP; a forced verification page
pauses the job and notifies the owner; the owner completes it over VNC and Hand back lets the queue finish the post.

### M7 · Connectors and performance
- [ ] MCP adapters for Notion, Google Drive, HubSpot; connector tiles with per-tool permissions
- [ ] Agents › Performance tab from AgentRun and Draft stats
- [ ] HubSpot sync job and hubspotSyncedAt indicators

*Accepted when:* a Notion page becomes a ContextItem the agent cites in a draft, and a stage change appears on the
HubSpot contact within 2 minutes.

### M8 · Settings, billing and hardening
- [x] Team and roles, invites, audit log with CSV export, weekly report settings, workspace list
- [ ] Stripe Billing for Starter / Pro / Agency with plan limits enforced
- [ ] Dark mode pass on every screen; tablet layout pass; accessibility audit
- [ ] Load test the pollers; backup and restore runbook; Sentry

*Accepted when:* a Viewer cannot approve, plan limits block the 6th agent on Pro, every screen passes axe with no
serious issues, and a full restore from backup takes under 15 minutes.

## 9. Background jobs

| Queue | Trigger | Concurrency | Idempotency key | Retries |
|---|---|---|---|---|
| reddit.poll | every 10 min per KeywordGroup | 4 | group:&lt;id&gt;:&lt;window&gt; | 3, exponential, respects 429 |
| opportunity.score | on new Post | 4 | post:&lt;id&gt; | 2 |
| draft.generate | Generate draft, Regenerate, Ask agent to draft | 2 | draft:&lt;id&gt;:v&lt;n&gt; | 2 |
| post.publish | on approve, or every minute for scheduledFor ≤ now | 1 per account | draft:&lt;id&gt; | 3; pauses account on NeedsHuman |
| dm.poll | every 5 min per account | 1 per account | account:&lt;id&gt;:&lt;window&gt; | 3 |
| comment.poll | every 5 min per posted Draft younger than 14 days | 2 | draft:&lt;id&gt;:&lt;window&gt; | 3 |
| account.stats | nightly 03:00 | 2 | account:&lt;id&gt;:&lt;date&gt; | 1 |
| subreddit.refresh | nightly 03:30 | 2 | sub:&lt;id&gt;:&lt;date&gt; | 1 |
| attribution.rollup | every 15 min | 1 | rollup:&lt;window&gt; | 2 |
| lead.sync | on lead create/stage change | 2 | lead:&lt;id&gt;:&lt;rev&gt; | 5 |
| context.embed | on ContextItem create/update | 2 | item:&lt;id&gt;:&lt;hash&gt; | 2 |
| browser.health | every 2 min | 1 | profile:&lt;id&gt;:&lt;window&gt; | 0 |
| session.idle | every minute | 1 | session:&lt;id&gt; | 0 |
| report.weekly | Monday 08:00 workspace time | 1 | ws:&lt;id&gt;:&lt;week&gt; | 2 |

## 10. Security and policy guardrails

Enforced in code (`packages/agents/src/rules.ts` and the post.publish queue). A draft that fails a block rule
cannot be approved; a warn rule shows in the rule-check panel and is logged with the approval.

| Rule | Level | Check |
|---|---|---|
| Disclosure present | block | Body contains the account's disclosureLine (fuzzy, case-insensitive); DMs need it in the first message |
| Subreddit link rule | block | URLs in the body ≤ what Subreddit.linkRule allows today |
| Daily posting limit | block | Posted items for this account today < dailyPostLimit |
| Account eligible | block | Karma and age meet the subreddit's minimums; health is not blocked |
| One account per person | block | RedditAccount.ownerMemberId is unique; connect flow refuses a second account |
| Human approval | block | post.publish only accepts approved/scheduled drafts with an approver who had canApprove |
| DM only after engagement | block | A dm draft needs a Conversation with at least one inbound Message |
| Self-promo ratio | warn | Promotional / all items in 7 days ≤ selfPromoMax after this post |
| Thread age | warn | Post older than 48 h |
| Competitor pricing claims | warn | Competitor name within 40 characters of a price |
| Proxy region mismatch | warn | Proxy exit region ≠ owner's fingerprint region |

Security: credentials encrypted at rest and decrypted only in the worker; role checks in server actions and route
handlers; VNC proxy only for Admins or the account owner, browser containers expose no host ports; beacons
validated against allowed origins; append-only audit log; per-IP rate limits on public endpoints; no automation
that posts without approval, no vote manipulation, no account warming, no posting from accounts the workspace does
not own.

## 11. Testing strategy

Unit (Vitest) for every rule and pure function; integration (queues against real Postgres/Redis with recorded
Reddit/LLM fixtures); E2E (Playwright) for the M3 loop and per-screen flows; visual screenshots at 1440 and 1024 in
light and dark; nightly live smoke against a private test subreddit.

### Definition of done for a milestone
1. All checkboxes in §8 ticked and acceptance criteria demonstrated.
2. Unit and integration tests green; new rules or queues have tests.
3. `pnpm typecheck && pnpm lint` clean; no `any` added without a comment.
4. Screens match the artboard at 1440 wide in light mode; dark mode by M8.
5. Conventional Commit PR titles (they become the CHANGELOG via release-please, docs/RELEASING.md) and an updated
   .env.example if config changed. A milestone ships as a tagged release.

## 12. Environment, local setup and deployment

See `.env.example`. Local development:
1. `docker compose up -d postgres redis jaeger`
2. `pnpm install && pnpm db:migrate && pnpm db:seed`
3. `pnpm dev` — web on :3000, worker with hot reload
4. `pnpm browser:build` once to build the browser-profile image
5. `pnpm test`, `pnpm test:e2e`

Deployment (v1, single server): Docker host; Caddy for TLS routing `app.<domain>` → web and `go.<domain>` → the
/r/[slug] redirector; nightly pg_dump; weekly browser-volume backup; deploy via GitHub Actions over SSH.

## 13. CLAUDE.md

See `CLAUDE.md` at the repo root.

## 14. Open decisions and assumptions

| Decision | Needed by | Default and alternatives |
|---|---|---|
| Hosting | M0 | Single Docker host; alternative: Vercel for web + a VPS for worker and browsers |
| Reddit app type and account | M1 | One web app registered under the brand's Reddit account; poller uses its client-credentials token |
| Embedding provider | M2 | Voyage AI voyage-3-lite; alternatives OpenAI text-embedding-3-small or local bge-small |
| Proxy provider | M6 | Bring-your-own (Bright Data / Oxylabs residential, sticky) |
| Fallback posting through the browser | M6 | On by default for DMs and verification recovery only |
| Attribution window and model | M5 | Last click within 30 days |
| Email provider | M0 | Resend for magic links and weekly reports |
| Billing | M8 | Stripe Billing, three fixed plans ($69 / $200 / $499); limits enforced in-app |
| Agency workspaces | M8 | Schema supports parentWorkspaceId from M0; switcher UI ships in M8 |
| Product name and domain | M0 | "Threadline"; tracked-link host go.&lt;domain&gt; — confirm before M5 |

Assumptions: posting only from accounts the customer owns, with disclosure and human approval; browser profiles
keep each real account on one stable device and exit location and let the owner take over — not to create
identities; mockup sample data is seed data for development and demos only; v1 targets one workspace, with
multi-tenant isolation in the schema and in requireRole.
