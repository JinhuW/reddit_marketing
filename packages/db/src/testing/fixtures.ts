/**
 * Test-only fixtures for the repo integration tests: a throwaway workspace with its own members, so a test
 * never depends on (or disturbs) the seeded Acme rows. Not exported from the package.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '../client';

export const uniq = (p = 't00') => `${p}-${randomBytes(4).toString('hex')}`;

export interface TestWorkspace {
  id: string;
  slug: string;
  /** adds a member (role editor) with a fresh user */
  member(name?: string | null): Promise<{ id: string; userId: string }>;
  /** an ONLINE (or given status) node of this workspace */
  node(opts?: {
    name?: string;
    status?: 'online' | 'offline' | 'draining';
    maxProfiles?: number;
  }): Promise<{ id: string; name: string }>;
  /** an OAuth-style identified account with a profile, optionally on a node */
  profileOn(nodeId: string | null): Promise<{ accountId: string; profileId: string }>;
  cleanup(): Promise<void>;
}

export async function testWorkspace(): Promise<TestWorkspace> {
  const slug = uniq('t00-ws');
  const ws = await prisma.workspace.create({ data: { name: 'Test', slug } });
  const nodeIds: string[] = [];

  const member: TestWorkspace['member'] = async (name = 'Test Person') => {
    const u = await prisma.user.create({ data: { email: `${uniq()}@test.local`, name } });
    const m = await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, userId: u.id, role: 'editor' },
    });
    return { id: m.id, userId: u.id };
  };

  return {
    id: ws.id,
    slug,
    member,
    async node(opts = {}) {
      const n = await prisma.browserNode.create({
        data: {
          workspaceId: ws.id,
          name: opts.name ?? uniq(),
          tokenHash: randomBytes(32).toString('hex'),
          status: opts.status ?? 'online',
          maxProfiles: opts.maxProfiles ?? 8,
        },
        select: { id: true, name: true },
      });
      nodeIds.push(n.id);
      return n;
    },
    async profileOn(nodeId) {
      const m = await member();
      const id = uniq('acct');
      const a = await prisma.redditAccount.create({
        data: {
          workspaceId: ws.id,
          ownerMemberId: m.id,
          username: id,
          redditId: `t2_${id}`,
          disclosureLine: 'Disclosure: test',
          identifiedAt: new Date(),
        },
      });
      const p = await prisma.browserProfile.create({
        data: {
          workspaceId: ws.id,
          accountId: a.id,
          name: 'Test · Chrome',
          nodeId,
          serial: (await prisma.browserProfile.count({ where: { workspaceId: ws.id } })) + 1,
        },
      });
      return { accountId: a.id, profileId: p.id };
    },
    async cleanup() {
      // AuditEvent is append-only (DB trigger) and references the workspace and its accounts, so the
      // workspace, members and accounts stay (slug `t00-ws-…`, no other test reads them). Nodes are
      // removed: their names are global and the gateway runs a queue worker per online node.
      await prisma.browserProfile.updateMany({ where: { workspaceId: ws.id }, data: { nodeId: null } });
      await prisma.browserNode.deleteMany({ where: { id: { in: nodeIds } } });
    },
  };
}
