-- Plan 0004 phase 3: proxy pool fields. Additive only.

-- AlterTable
ALTER TABLE "Proxy" ADD COLUMN     "label" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "refreshUrlEnc" TEXT;
