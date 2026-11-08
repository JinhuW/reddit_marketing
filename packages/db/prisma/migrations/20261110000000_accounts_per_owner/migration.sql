-- One person may own several Reddit accounts (docs/DECISIONS.md 2026-11-08). The `one_voice_per_thread` block rule
-- in packages/agents/src/rules.ts keeps two accounts of the same person out of the same thread.

-- DropIndex
DROP INDEX "RedditAccount_ownerMemberId_key";

-- CreateIndex
CREATE INDEX "RedditAccount_ownerMemberId_idx" ON "RedditAccount"("ownerMemberId");
