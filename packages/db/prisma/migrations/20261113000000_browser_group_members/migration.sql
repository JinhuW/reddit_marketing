-- Plan 0004 phase 5: members who may manage a group of browsers. Additive only.

-- CreateTable
CREATE TABLE "BrowserGroupMember" (
    "groupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrowserGroupMember_pkey" PRIMARY KEY ("groupId","memberId")
);

-- CreateIndex
CREATE INDEX "BrowserGroupMember_memberId_idx" ON "BrowserGroupMember"("memberId");

-- AddForeignKey
ALTER TABLE "BrowserGroupMember" ADD CONSTRAINT "BrowserGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BrowserGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserGroupMember" ADD CONSTRAINT "BrowserGroupMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "WorkspaceMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
