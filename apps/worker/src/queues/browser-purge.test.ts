/** Integration: trash.purge against Postgres with an in-memory node queue (no Redis). */
import { randomBytes } from 'node:crypto';
import { browsers, prisma } from '@threadline/db';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryBrowserQueues } from './browser-health';
import { browserPurge } from './browser-purge';

afterAll(() => prisma.$disconnect());

const DAY = 24 * 3600_000;
const uniq = (p: string) => `${p}-${randomBytes(4).toString('hex')}`;

/** A throwaway workspace: one member, nodes and account-less browsers. Nodes are removed afterwards. */
async function testWorkspace() {
  const ws = await prisma.workspace.create({ data: { name: 'Purge test', slug: uniq('t04-ws') } });
  const nodeIds: string[] = [];
  return {
    id: ws.id,
    async member() {
      const u = await prisma.user.create({
        data: { email: `${uniq('t04')}@test.local`, name: 'Test Person' },
      });
      return prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role: 'admin' } });
    },
    async node(status: 'online' | 'offline' = 'online') {
      const n = await prisma.browserNode.create({
        data: { workspaceId: ws.id, name: uniq('t04'), tokenHash: uniq('hash'), status },
      });
      nodeIds.push(n.id);
      return n;
    },
    async profileOn(nodeId: string | null) {
      const serial = (await prisma.browserProfile.count({ where: { workspaceId: ws.id } })) + 1;
      const p = await prisma.browserProfile.create({
        data: { workspaceId: ws.id, name: `Browser ${serial}`, serial, nodeId },
      });
      return p.id;
    },
    async cleanup() {
      await prisma.browserProfile.updateMany({ where: { workspaceId: ws.id }, data: { nodeId: null } });
      await prisma.browserNode.deleteMany({ where: { id: { in: nodeIds } } });
    },
  };
}

describe('trash.purge', () => {
  it('removes old trash through the node, purges node-less browsers itself, waits for offline nodes', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const online = await ws.node();
      const offline = await ws.node('offline');
      const onNode = await ws.profileOn(online.id);
      const noNode = await ws.profileOn(null);
      const onOffline = await ws.profileOn(offline.id);
      const fresh = await ws.profileOn(online.id);
      for (const id of [onNode, noNode, onOffline, fresh]) await browsers.trashProfile(ws.id, id, me.id);
      await prisma.browserProfile.updateMany({
        where: { id: { in: [onNode, noNode, onOffline] } },
        data: { deletedAt: new Date(Date.now() - 31 * DAY) },
      });

      const q = memoryBrowserQueues();
      const mine = async () => (await browsers.listPurgeDue()).filter((p) => p.workspaceId === ws.id);
      expect(await mine()).toHaveLength(3);
      await browserPurge(undefined, { browser: q });

      // The node-less one is gone at once; the others still wait for their node.
      const purgedAt = async (id: string) =>
        (await prisma.browserProfile.findUniqueOrThrow({ where: { id } })).purgedAt;
      expect(await purgedAt(noNode)).not.toBeNull();
      expect(await purgedAt(onNode)).toBeNull();
      expect(await purgedAt(onOffline)).toBeNull();
      expect(await purgedAt(fresh)).toBeNull();
      const jobsOn = (node: string) => [...q.jobs.values()].filter((e) => e.node === node).map((e) => e.job);
      expect(jobsOn(online.name)).toEqual([
        { kind: 'profile.remove', workspaceId: ws.id, profileId: onNode, then: 'purge' },
      ]);
      expect(jobsOn(offline.name)).toEqual([]);

      // Same day again: nothing is queued twice.
      await browserPurge(undefined, { browser: q });
      expect(jobsOn(online.name)).toHaveLength(1);
    } finally {
      await ws.cleanup();
    }
  });
});
