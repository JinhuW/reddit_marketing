# Releasing Threadline

Threadline ships as one product with one version (the root `package.json`). Releases are cut by
[release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org)
on `main`. Nobody edits `CHANGELOG.md` or bumps versions by hand.

## Versioning

[Semantic Versioning](https://semver.org). While we are pre-1.0 (`0.y.z`):

| Change | Commit | Version bump |
|---|---|---|
| Bug fix | `fix(scope): …` | patch `0.1.0 → 0.1.1` |
| New feature | `feat(scope): …` | minor `0.1.0 → 0.2.0` |
| Breaking change (API, schema migration that needs operator action, env var renamed, removed route) | `feat(scope)!: …` or a `BREAKING CHANGE:` footer | minor while 0.x, major from 1.0 |

`1.0.0` is cut deliberately when v1's goals in docs/PLAN.md §1 are met (end-to-end loop live on Reddit), by
adding `Release-As: 1.0.0` to a commit body.

## Day to day

1. **Branch** from `main`: `feat/approvals-schedule`, `fix/worker-retry`.
2. **Commit** with Conventional Commits. Types: `feat`, `fix`, `perf`, `security`, `revert` (appear in the
   changelog) and `refactor`, `docs`, `test`, `build`, `ci`, `chore` (hidden). Scope = the area:
   `approvals`, `worker`, `db`, `agents`, `leads`, `analytics`, `browsers`, `settings`, `shell`, `tracking`, `auth`.
3. **Open a PR** using the template. The PR title must itself be a Conventional Commit; the `PR title` check
   enforces it.
4. **Merge with squash** (the default). The PR title becomes the commit on `main` and therefore the changelog line,
   so write it for a reader of release notes: `feat(approvals): schedule approved drafts for later`.
   Large multi-part PRs whose commits are each meaningful may be rebase-merged instead.

## Cutting a release

1. Every push to `main` runs `.github/workflows/release.yml`. release-please keeps one open PR titled
   `chore: release x.y.z` that bumps `package.json`, `.release-please-manifest.json` and prepends the new
   section to `CHANGELOG.md`.
2. Review that PR: check the notes read well and that anything operators must do (migrations, new env vars)
   is called out. Edit the release PR's changelog text if needed before merging.
3. **Merge the release PR.** release-please tags `vX.Y.Z` and publishes a GitHub Release with the same notes.
4. **Deploy the tag** (docs/PLAN.md §12): on the server
   `git fetch --tags && git checkout vX.Y.Z && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d`
   — the web container runs `prisma migrate deploy` on start. Take a `pg_dump` first when the release has a
   migration.

Release cadence: whenever `main` has user-visible changes worth shipping, at least at the end of each
milestone in docs/PLAN.md §8. A milestone is "released" when its acceptance criteria pass on the deployed tag.

## Hotfixes

Fix on a branch from `main` with a `fix(scope): …` PR, merge, then merge the release PR that release-please opens
immediately. If `main` already holds unreleased work that must not ship, branch `hotfix/x.y.z` from the last
tag, cherry-pick the fix, and tag `vX.Y.(Z+1)` manually with a matching `CHANGELOG.md` entry; then merge the
hotfix branch back into `main`.

## Database migrations

- Every schema change ships its migration in the same PR; CI fails on drift (`migrate:check`).
- A migration that needs downtime, a backfill or a manual step is a breaking change: use `!` and describe the
  step in the PR's "Release notes" section so it lands in the changelog.
- Never edit a migration that has been released; add a new one.

## One-time repository settings

- Default branch: `main`. Protect it: require the `CI` and `PR title` checks, require a PR, allow squash and rebase
  merges only.
- Settings → Actions → General → Workflow permissions: "Read and write", and allow GitHub Actions to create and
  approve pull requests (release-please opens the release PR).
