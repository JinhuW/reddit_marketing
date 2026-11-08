-- Standalone browsers (docs/plans/0003-standalone-browsers.md): a BrowserProfile exists without a RedditAccount;
-- an account is assigned to at most one browser. Account credentials and pending cookies are stored encrypted.

-- DropForeignKey
ALTER TABLE "BrowserProfile" DROP CONSTRAINT "BrowserProfile_accountId_fkey";

-- AlterTable
ALTER TABLE "BrowserProfile" ADD COLUMN     "cookiesEnc" TEXT,
ADD COLUMN     "cookiesImportedAt" TIMESTAMP(3),
ADD COLUMN     "createdByMemberId" TEXT,
ADD COLUMN     "startUrl" TEXT,
ALTER COLUMN "accountId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RedditAccount" ADD COLUMN     "loginPasswordEnc" TEXT,
ADD COLUMN     "totpSecretEnc" TEXT;

-- AddForeignKey
ALTER TABLE "BrowserProfile" ADD CONSTRAINT "BrowserProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "RedditAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserProfile" ADD CONSTRAINT "BrowserProfile_createdByMemberId_fkey" FOREIGN KEY ("createdByMemberId") REFERENCES "WorkspaceMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing profiles: their account's owner counts as the creator.
UPDATE "BrowserProfile" p SET "createdByMemberId" = a."ownerMemberId" FROM "RedditAccount" a WHERE a."id" = p."accountId" AND p."createdByMemberId" IS NULL;
