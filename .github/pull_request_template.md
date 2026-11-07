## Summary

<!-- What changes and why. Link the milestone task from docs/PLAN.md §8. -->

## Milestone

<!-- e.g. M3 · post.publish via API -->

## Checklist

- [ ] PR title is a Conventional Commit (`feat(scope): …`, `fix(scope): …`); add `!` for breaking changes
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass; Playwright updated for changed flows
- [ ] New or changed rules in `packages/agents/src/rules.ts` have pass and fail tests; no block rule weakened
- [ ] Schema change has a migration (`pnpm db:migrate`) and `pnpm --filter @threadline/db migrate:check` passes
- [ ] `.env.example` updated if config changed
- [ ] Choices the plan left open are noted in `docs/DECISIONS.md`
- [ ] Screens match their artboard at 1440 wide (screenshot attached)

## Release notes

<!-- Optional. Anything operators must do on deploy (migrations, new env vars, data backfills). -->
