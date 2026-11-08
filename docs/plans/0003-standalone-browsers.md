# Plan 0003 · Standalone browsers, accounts assigned to them

Status: in progress (2026-11-08). Owner decision: a browser profile is created on its own and a Reddit account is
assigned to it afterwards, the way anti-detect browser tools do it (platform, username, password, 2FA secret, start
tab, cookie import). Until now `BrowserProfile.accountId` was required and every browser was born inside the
account connect flow.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Accounts per browser | **0 or 1 at a time.** An account is in at most one browser. Unassign, then assign another. | Two Reddit identities on one device and IP is a ban-linkage signal; dispatch stays unambiguous. |
| Stored password / 2FA secret | **Auto sign-in.** Encrypted with `APP_ENCRYPTION_KEY` on the account. `profile.signIn` fills reddit.com/login and the TOTP code; a captcha or check → `needs_human` and the owner takes over over VNC. | The owner no longer has to type credentials into VNC for every new browser. |
| Start tab and cookies | **Both, on the browser.** `startUrl` opens on every sign-in run; pasted cookie JSON is encrypted, imported on the next `profile.signIn`, then cleared. | Matches the 标签页 / Cookie fields; cookies stay at rest only until the profile's own volume holds them. |
| Who controls an unassigned browser | Admins and the member who created it (`createdByMemberId`). With an account: admins and the account owner (unchanged). | Keeps the VNC guard meaningful for browsers with no account. |
| Deleting an account | The browser stays (`onDelete: SetNull`). | The browser is its own thing now. |
| Identity safety | Unchanged: `completeBrowserIdentity` refuses a browser signed in as someone other than the assigned, identified account. A browser whose cookie jar still holds the previous account is therefore refused for the next one until signed out over VNC. | No silent identity swaps. |

Unchanged rules: a post only from an approved Draft with an `approverMemberId`; an account without a browser, or
not identified, is never dispatched; every Draft / Lead / RedditAccount / BrowserSession transition writes an
AuditEvent; secrets never in logs, job payloads, results or audit meta.

## Data

- `BrowserProfile.accountId String? @unique` (relation `onDelete: SetNull`), `createdByMemberId String?`,
  `startUrl String?`, `cookiesEnc String?`, `cookiesImportedAt DateTime?`.
- `RedditAccount.loginPasswordEnc String?`, `totpSecretEnc String?`.
- Audit actions: `profile.created`, `profile.account_assigned`, `profile.account_unassigned`,
  `profile.settings_updated` (start URL / cookies; meta never holds the cookie values),
  `account.credentials_updated` (meta: which fields changed, never values).
- Cookie JSON: the Cookie-Editor / AdsPower export (array of `{ name, value, domain, path?, expirationDate? |
  expires?, httpOnly?, secure?, sameSite? }`), validated and normalized by `BrowserCookies` in
  `packages/shared/src/cookies.ts`.

## Commands and jobs

- Node command `profile.signIn { profileId, startUrl, cookies?, credentials? { username, password, totpSecret? } }`
  → result data = `WhoamiData`. The agent: imports cookies (`context.addCookies`), reads `me.json`; when nobody is
  signed in and credentials are given, fills the login form (+ TOTP), reads `me.json` again; then leaves a tab on
  `startUrl` open for the live view. Walls → `needs_human` with the tab kept.
- BrowserJob `profile.signIn { workspaceId, profileId }`. The gateway loads secrets with the GATEWAY-ONLY
  `browsers.getSignInForDispatch` (the only decrypt of account credentials and cookies), starts the profile if
  needed, sends the command, then: cookies imported → `browsers.markCookiesImported` (clears `cookiesEnc`);
  `loggedIn: true` with an assigned browser-mode account → `accounts.completeBrowserIdentity`.

## UI

- `/browsers`: **New browser** (name, node auto-picked, proxy: saved or none, start URL, cookies). Rows without an
  account read "No account".
- Browser editor: **Account** section: assign an existing account that has no browser, or **Add account**
  (platform reddit.com, username, password, 2FA secret), unassign; **Start tab** and **Cookie** fields;
  **Sign in now** enqueues `profile.signIn`.
- `/accounts/connect` (browser mode) keeps working: it now creates a browser and assigns the new pending account
  to it in the same transaction.

## Tasks

| Task | Owns |
|---|---|
| **S1** data + protocol | Prisma schema + migration, `packages/shared` (enums, node-protocol, queues, cookies), `packages/db/src/repos/{browsers,accounts}.ts` + tests |
| **S2** agent sign-in | `apps/node-agent/src/actions/{sign-in,totp}.ts` + wiring + tests |
| **S3** gateway | `apps/worker/src/gateway/**` (`profile.signIn` job, nullable account everywhere) + tests |
| **S4** web | `apps/web/**` browsers + accounts screens, server actions, e2e |
