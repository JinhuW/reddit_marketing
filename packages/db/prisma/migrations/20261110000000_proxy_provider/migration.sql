-- Workspace proxy providers (e.g. Decodo ISP): one host + one set of credentials for a range of ports.
-- A Proxy with providerId takes host, protocol and credentials from its provider at dispatch time.
-- No backfill: existing Proxy rows stay standalone.

-- AlterTable
ALTER TABLE "Proxy" ADD COLUMN     "providerId" TEXT;

-- CreateTable
CREATE TABLE "ProxyProvider" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "ProxyProtocol" NOT NULL DEFAULT 'http',
    "host" TEXT NOT NULL,
    "usernameEnc" TEXT,
    "passwordEnc" TEXT,
    "portFrom" INTEGER,
    "portTo" INTEGER,
    "region" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxyProvider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProxyProvider_workspaceId_name_key" ON "ProxyProvider"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Proxy_providerId_idx" ON "Proxy"("providerId");

-- AddForeignKey
ALTER TABLE "Proxy" ADD CONSTRAINT "Proxy_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProxyProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProxyProvider" ADD CONSTRAINT "ProxyProvider_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
