-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "subredditId" TEXT;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_subredditId_fkey" FOREIGN KEY ("subredditId") REFERENCES "Subreddit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
