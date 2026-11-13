# Plan 0004 · Browsers page: the core of an anti-detect browser manager

Status: in progress (2026-11-12). Owner request: the Browsers page should offer the same core features as AdsPower.
Its site, help center and Local API docs were surveyed on 2026-11-12 and compared with what Threadline had.

AdsPower's core is six things. Threadline had the third and a thin slice of the others:

1. Profile list: search, filters, groups, tags, quick edit, bulk actions, trash.
2. New / Edit Profile with an editable fingerprint.
3. One isolated browser per profile (CloakBrowser container, VNC take-over, cookie import, auto sign-in).
4. Proxy manager: saved list, bulk add, check, random assignment.
5. Cookie import and export, clearing browser data.
6. Bulk create, import and export.

## Decisions

| Question | Decision | Why |
|---|---|---|
| RPA builder, Local API / MCP, user-facing CDP endpoint, AI agent | **Not built.** | A general automation path could post to Reddit without an approved Draft and an `approverMemberId`. |
| Synchronizer | Not built. | Needs input mirroring across separate VNC containers; a separate module in AdsPower too. |
| Extensions, group-level member permissions, sharing a profile across workspaces | Later. | Second tier; none blocks the six core areas. |
| Firefox kernel, mobile personas, cloud data sync, proxy store, billing | Not built. | Engine or commercial features. |
| Status column | Follows the node: heartbeats list the running profiles; start/stop results update it at once. | It was only ever written by the seed. |
| Connection test | Runs in the profile's own browser (`profile.testProxy`); the agent also times the request, looks up where the exit IP is and checks reddit.com through the proxy. | "Test now" was a stub. The place feeds "match proxy IP" in phase 2. |
| Trash | Soft delete, 30 days, account stays bound, dispatch refuses a trashed profile. Purge removes the container and volume on the node. | Restore brings everything back; nothing can post from a deleted browser. |
| Purged browser | The row stays as a tombstone (`purgedAt`), stripped of account, proxy, node, cookies, notes and tags. | Audit rows point at its sessions and `AuditEvent` is append-only, so the row cannot be deleted. |
| Browser count | No plan limit on browsers (the plan limits accounts); one bulk action or clone run touches at most 100. | A browser without an account posts nothing. |
| Seed / GPU after first launch | Changeable only together with "reset browser data". | The volume locks them (`checkFingerprintLock`): a device that changes hardware under the same cookies is a tell. |
| OS persona | Not a choice: every new, cloned or reset browser is `windows` (DECISIONS 2026-11-09). | The image ships Windows-metric fonts and `CloakGpu` has no Apple value, so a macOS or Linux persona contradicts itself. |
| WebRTC "real" | Never offered while a proxy is set; the save is refused, dispatch falls back to `disable_udp`, and the image ignores it behind a proxy. | It would show the node's home IP. |
| Existing browsers | New flags are sent only for a setting a person changed. | A launch-flag change on a browser Reddit already knows is a device change. |
| Pool rights | Editors add, edit, check and delete unused proxies; only an admin deletes one that browsers use. | Taking a proxy away changes other people's browsers. |
| Same proxy twice | A proxy is host + port + username: pasting a list again adds nothing. | Vendors hand out many logins on one gateway host:port. |
| Proxy change-IP URL, pool checks | Called from the node agent, never from the web app. | The URL is user input: no server-side request from Railway. |

Unchanged rules: a post only from an approved Draft with an `approverMemberId`; every Draft / Lead / RedditAccount /
BrowserSession transition writes an AuditEvent; secrets never in logs, job payloads, results or audit meta.

## Phases

### Phase 0 · Status and connection test are real
- [x] `browsers.setStatus`, `browsers.syncNodeRunning`: the gateway syncs on node online / heartbeat / offline /
      `container.exited`, and on `profile.start` / `profile.stop` results; a start refused for good shows `error`.
- [x] "Test now" queues `profile.testProxy`; the gateway stores `Proxy.lastTest` (`browsers.recordProxyTest`),
      failures included. `TestProxyData` gains optional `latencyMs`, `redditOk`, `geo`.
- [x] `session.log` is a declared `AuditAction`.

### Phase 1 · Profile list
- [x] Schema: `BrowserGroup`, `BrowserTag`, and on `BrowserProfile` `groupId`, `notes`, `serial`, `deletedAt`,
      `deletedByMemberId`, `purgedAt`.
- [x] Repo (`packages/db/src/repos/browser-manage.ts`): `searchProfiles` (filter, sort, page); groups and tags;
      `updateProfileMeta`; `cloneProfile`; `trashProfile` / `restoreProfile` / `purgeProfile`;
      `resetProfileData`. The bulk action checks permission per browser (`lib/actions/browser-list.ts`).
- [x] Node command `profile.remove` (job field `after`: `purge` or `reset`); `trash.purge` job every 6 hours.
- [x] UI: search, group / tag / status filters, sortable headers, paging, column chooser, checkboxes and a bulk
      bar (start, stop, move, tag, set proxy, clone, delete), Trash view with restore and delete for good,
      notes edited in the row, per-row Start / Stop, group / tags / notes and Delete in the drawer.

### Phase 2 · Editable fingerprint
- [x] Spike: the CloakBrowser README's flag table (2026-11-12) lists `--fingerprint-hardware-concurrency`,
      `--fingerprint-device-memory`, `--fingerprint-noise`, `--fingerprint-webrtc-ip`, timezone, locale and screen
      flags; GPU vendors are Intel and NVIDIA. It advises keeping the seed as the source of identity, so canvas,
      WebGL, audio, fonts and client rects stay seed-derived and are shown as fixed.
- [x] `FingerprintSettings` (packages/shared/src/fingerprint.ts) and the drawer form: screen, time zone and
      language (custom or "match proxy IP", resolved from the last connection test at every start), CPU cores,
      memory, WebRTC (proxy only / replace with the proxy IP / real without a proxy), noise on or off.
- [x] "New fingerprint": new seed and optionally another GPU vendor, after the node deleted the browser's data
      (`profile.remove`, `after: reset`); needs a ticked confirmation.
- [x] `profile.start` carries optional `cpu`, `memoryGb`, `noise`, `webrtc`; the agent passes them as `FP_*` env
      and the image turns them into flags. An untouched browser starts exactly as before.
- [ ] Not built: a geolocation setting. A per-page CDP override does not cover tabs a person opens over VNC,
      and a browser-wide one needs a check on an x86 node. Chrome's default (ask) stays.

### Phase 3 · Proxy pool
- [x] `/browsers/proxies` (the artboard's "Proxy pool" button): list with the last check, search, add one, bulk
      add by paste (`packages/shared/src/proxy-parse.ts`), edit, delete, bulk Check and Change IP, name, notes.
- [x] Node commands `proxy.check` (no browser needed; any online node of the workspace) and `proxy.rotate`
      (calls the change-IP link from the node; only http(s) links that resolve to public addresses).
- [x] "Random proxy no browser uses yet" on New browser (`browsers.pickUnusedProxy`).
- [ ] Not built: HTTPS and SSH proxy types. Both need a TLS or SSH hop in the agent's own proxy requests and in
      the CDP proxy sign-in, and a check on a node; HTTP and SOCKS5 cover what the pool holds today.

### Phase 4 · Cookies, data, bulk create
- [ ] Cookie export (`profile.exportCookies`), Netscape and `name=value` import.
- [ ] `profile.clearData`; "Clear session" in the drawer and the bulk bar.
- [ ] Up to 10 start tabs.
- [ ] Quick create N; CSV import / export of profiles (no secrets in an export); at most 100 per run.

## Rollout

New protocol fields are optional, so an older node agent keeps working. Each phase that touches
`apps/node-agent` or `apps/browser-profile` needs the agent / image redeployed on the browser nodes.
