# Plan 0002 · Browser mode: Reddit without an API app

Status: in progress (2026-11-07). Owner decision: Threadline drives Reddit through each account's CloakBrowser
profile instead of the Reddit API. Production has no Reddit OAuth app (`REDDIT_CLIENT_ID` unset) and none is
planned. The OAuth path stays in the code and is used only when an app is configured.

## What changes

| Area | Today (OAuth) | Browser mode |
|---|---|---|
| Connect an account | Reddit consent screen → token | Create the profile first → owner signs in to reddit.com over VNC → `profile.whoami` reads the identity from the logged-in browser |
| Post a comment / DM | Reddit API; browser only as fallback | Straight to the browser action (`action.submitComment` / `action.sendDm`) through the existing approval gate |
| Post a new thread (`post` drafts) | Reddit API | Not supported in browser mode: refused with a clear reason, never sent |
| Find conversations (`reddit.poll`) | App token (client credentials) | The public Atom feed (`/r/<sub>/new/.rss`) fetched by the worker through `REDDIT_READ_PROXY_URL` (anonymous `new.json` returns 403) |
| Profile → node | Manual (`register-node --assign`) | Assigned at creation to the least-loaded online node in the workspace that has room (`maxProfiles`); changeable on the Browsers screen |
| Proxy | Per profile, saved on the Browsers screen | Same. Production profile 1 uses a Decodo ISP port not used by the ERP fleet |

Rules that do not change: a post only from an approved Draft with an `approverMemberId` (the gate in
`assertPublishable` and in the gateway's `approvalGate`); every RedditAccount / BrowserSession transition writes an
AuditEvent; no secrets in logs, job payloads or results.

## Data

- `AccountAuthMode` enum in `packages/shared/src/enums.ts` and Prisma: `oauth` | `browser`.
  `RedditAccount.authMode` (default `oauth`), `RedditAccount.identifiedAt DateTime?`.
- A browser-mode account is created **before** the identity is known: `username` = `pending-<short id>`,
  `redditId` = `pending:<account id>` (keeps `@@unique([workspaceId, redditId])`), `identifiedAt = null`.
  An account with `identifiedAt = null` is never publishable and never dispatched for actions
  (`assertPublishable` and the gateway's gate both refuse: "account not signed in yet").
- Audit actions: `account.connect_started` (pending row + profile created), `account.connected` (identity read;
  meta `{ username, authMode: 'browser' }`), `profile.node_assigned` (from/to node).

## Commands and jobs

- New node command `profile.whoami { profileId }` → result `{ outcome: 'ok', data: { loggedIn: false } }` or
  `{ loggedIn: true, name, id, totalKarma, createdUtc }`. The agent reads `https://www.reddit.com/api/me.json`
  inside the profile's own browser context (its cookies, its proxy). Never logs the body.
- New BrowserJob kind `profile.whoami` on `browser.<node>`. The gateway starts the profile if needed, sends the
  command and, on `loggedIn: true`, calls `accounts.completeBrowserIdentity`. Refuses when the username is
  already connected in the workspace.
- The web app enqueues `profile.start` and `profile.whoami` jobs on the node's queue (it already has `REDIS_URL`);
  results land in the DB and the page re-reads them. No new HTTP endpoint on the gateway.

## Flow in the UI

1. `/accounts/connect`: when no Reddit app is configured (or the user picks it), the flow shows
   **Connect through the browser**. Step 1 collects owner, role label, disclosure line and limits; submit calls
   `accounts.startBrowserConnect` (pending account + profile + node assignment + optional proxy) and enqueues
   `profile.start`.
2. Redirect to `/browsers/<profileId>/session?login=1`: a take-over session opens on reddit.com/login with the
   banner "Sign in to Reddit in this window, then press **I'm signed in**".
3. **I'm signed in** enqueues `profile.whoami`; the page polls until the account shows a username (or shows
   "Not signed in yet" for `loggedIn: false`). Then hand back and go to `/accounts`.

## Tasks

| Task | Owns | Needs |
|---|---|---|
| **B1** data + protocol | `packages/shared/src/{enums,node-protocol,queues}.ts`, Prisma schema + migration, `packages/db/src/repos/{accounts,nodes,browsers}.ts` + tests, `packages/agents` gate change | — |
| **B2** agent whoami | `apps/node-agent/src/actions/whoami.ts`, wiring in `actions/index.ts`, tests | B1 |
| **B3** worker | `apps/worker/src/gateway/{dispatch,outcomes}.ts` (whoami job), `queues/post-publish.ts` (browser-first), `queues/reddit-poll.ts` + `reddit/client.ts` (public JSON via proxy), tests with recorded fixtures | B1 |
| **B4** web | `apps/web/components/accounts/**`, `apps/web/app/(app)/accounts/connect/**`, `apps/web/lib/actions/{accounts,browsers}.ts`, `apps/web/components/browsers/**`, `apps/web/app/(app)/browsers/**`, a server-only enqueue helper; T30 scope (node column, live status, pause reason, Admin resume, assign node, start/stop) | B1 |

Production steps after merge (coordinator): `ANTHROPIC_API_KEY` on web + worker; `REDDIT_READ_PROXY_URL` on worker;
create the Decodo proxy for profile 1 from the homelab console's credentials without printing them; deploy web,
worker, gateway and the node agent; walk the flow in the UI.
