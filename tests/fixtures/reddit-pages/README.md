# Reddit page fixtures

Static pages that `@threadline/node-testkit`'s `startFakeCdpTarget()` serves to a real Chromium, so the node
agent's Playwright actions (T22) and the CI run of the browser-fallback flow (T34) can be tested without
touching reddit.com.

| File | What it stands for | Served at (fake site) |
|---|---|---|
| `thread.html` | a text post with two comments; collapsed top-level composer, Reply buttons | `/r/<sub>/comments/<id>/<slug>/` |
| `comment-box.html` | single-comment permalink with the reply composer open under `t1_kx1aa02` | `/r/<sub>/comments/<id>/<slug>/<comment>/` |
| `dm-compose.html` | the private message compose form (`to`, `subject`, `text`, `send`) | `/message/compose/` |
| `verification-wall.html` | "Verify it's you" one-time-code wall | `/account/verify/` (302 from content pages) |
| `login-wall.html` | log-in wall | `/login/` (302 from content pages) |
| `captcha-wall.html` | "Prove your humanity" challenge with a reCAPTCHA widget placeholder | in place of any content page |

## Provenance and scrubbing

These pages are hand-written reconstructions of the parts of Reddit's markup the actions touch (shreddit custom
elements, `thingid`/`parentid` attributes, composer slots, the compose form fields, the wall pages' titles and
inputs). They are not byte-for-byte captures: small inline scripts emulate submit behaviour against the fake site,
and everything else is stripped. Scrubbing rules, enforced by `packages/node-testkit/src/fixtures.test.ts`:

- usernames are `testkit_*`; subreddit is `r/testkit_sandbox`; ids are made up (`t3_1abc2de`, `t1_kx1aa0*`);
- email addresses only as masked `x****@example.com`;
- no cookies, tokens, CSRF values, tracking ids or analytics;
- no external scripts, styles, images or frames: the pages never reach the network.

When re-capturing from a live logged-in session (by hand, never in CI): save the page, cut it down to the
elements above, apply the same scrubbing, keep the ids the tests use, and run `pnpm --filter
@threadline/node-testkit test`.
