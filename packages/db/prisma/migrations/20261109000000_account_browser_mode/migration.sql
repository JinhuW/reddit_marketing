-- Browser mode (docs/plans/0002-browser-mode.md): how an account talks to Reddit, and when its identity was read.

-- CreateEnum
CREATE TYPE "AccountAuthMode" AS ENUM ('oauth', 'browser');

-- AlterTable
ALTER TABLE "RedditAccount" ADD COLUMN     "authMode" "AccountAuthMode" NOT NULL DEFAULT 'oauth',
ADD COLUMN     "identifiedAt" TIMESTAMP(3);

-- Backfill: every existing account was connected through OAuth, so its identity was known when it was created.
UPDATE "RedditAccount" SET "identifiedAt" = "createdAt" WHERE "identifiedAt" IS NULL;
