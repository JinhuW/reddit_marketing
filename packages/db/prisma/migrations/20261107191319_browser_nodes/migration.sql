-- CreateEnum
CREATE TYPE "BrowserNodeStatus" AS ENUM ('online', 'offline', 'draining');

-- CreateEnum
CREATE TYPE "PauseReason" AS ENUM ('needs_human', 'license_denied', 'node_offline', 'proxy_failed', 'manual');

-- AlterTable
ALTER TABLE "BrowserProfile" ADD COLUMN     "cloakGpu" TEXT,
ADD COLUMN     "cloakPersona" TEXT,
ADD COLUMN     "cloakSeed" INTEGER,
ADD COLUMN     "nodeId" TEXT;

-- AlterTable
ALTER TABLE "RedditAccount" ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedReason" "PauseReason";

-- CreateTable
CREATE TABLE "BrowserNode" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "BrowserNodeStatus" NOT NULL DEFAULT 'offline',
    "agentVersion" TEXT,
    "imageDigest" TEXT,
    "seatsInUse" INTEGER NOT NULL DEFAULT 0,
    "seatsLimit" INTEGER,
    "maxProfiles" INTEGER NOT NULL DEFAULT 8,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserNode_workspaceId_name_key" ON "BrowserNode"("workspaceId", "name");

-- AddForeignKey
ALTER TABLE "BrowserProfile" ADD CONSTRAINT "BrowserProfile_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "BrowserNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserNode" ADD CONSTRAINT "BrowserNode_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
