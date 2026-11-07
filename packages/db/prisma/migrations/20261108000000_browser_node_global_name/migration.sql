-- Node names are global: they name the browser.<name> queue and the gateway login (X-Node-Name).
-- DropIndex
DROP INDEX "BrowserNode_workspaceId_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "BrowserNode_name_key" ON "BrowserNode"("name");

-- CreateIndex
CREATE INDEX "BrowserNode_workspaceId_idx" ON "BrowserNode"("workspaceId");
