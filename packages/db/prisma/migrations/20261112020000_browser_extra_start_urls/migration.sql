-- Plan 0004 phase 4: more start tabs per browser. Additive only.

-- AlterTable
ALTER TABLE "BrowserProfile" ADD COLUMN     "extraStartUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
