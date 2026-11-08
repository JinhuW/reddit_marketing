# Reddit JSON fixtures

Response bodies the node agent's `profile.whoami` (plan 0002) reads from `/api/me.json` inside a profile's
browser. `apps/node-agent/src/actions/whoami.test.ts` serves them from a local HTTP server; nothing calls
reddit.com.

| File | What it stands for |
|---|---|
| `me-logged-in.json` | `me.json` for a signed-in session: `{ kind: 't2', data: {...} }`, trimmed to common fields |
| `me-logged-out.json` | `me.json` without a session: `{}` |

Scrubbing follows `../reddit-pages/README.md`: `testkit_*` usernames, made-up ids, no cookies or tokens. The
`modhash` is a placeholder; the test checks it never reaches the result or the logs.
