-- Plan 0004 phase 1: groups, tags, notes, list numbers and trash for browser profiles. Additive only.

-- AlterTable
ALTER TABLE "BrowserProfile" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByMemberId" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "purgedAt" TIMESTAMP(3),
ADD COLUMN     "serial" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BrowserGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'gray',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrowserTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_BrowserProfileToBrowserTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BrowserProfileToBrowserTag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserGroup_workspaceId_name_key" ON "BrowserGroup"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserTag_workspaceId_name_key" ON "BrowserTag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "_BrowserProfileToBrowserTag_B_index" ON "_BrowserProfileToBrowserTag"("B");

-- CreateIndex
CREATE INDEX "BrowserProfile_workspaceId_deletedAt_idx" ON "BrowserProfile"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "BrowserProfile_groupId_idx" ON "BrowserProfile"("groupId");

-- AddForeignKey
ALTER TABLE "BrowserProfile" ADD CONSTRAINT "BrowserProfile_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BrowserGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserGroup" ADD CONSTRAINT "BrowserGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserTag" ADD CONSTRAINT "BrowserTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BrowserProfileToBrowserTag" ADD CONSTRAINT "_BrowserProfileToBrowserTag_A_fkey" FOREIGN KEY ("A") REFERENCES "BrowserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BrowserProfileToBrowserTag" ADD CONSTRAINT "_BrowserProfileToBrowserTag_B_fkey" FOREIGN KEY ("B") REFERENCES "BrowserTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Number the existing profiles per workspace, oldest first.
UPDATE "BrowserProfile" p SET "serial" = n.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "workspaceId" ORDER BY "createdAt", "id") AS rn
  FROM "BrowserProfile"
) n
WHERE p."id" = n."id";
