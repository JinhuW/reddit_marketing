/**
 * Integration: browser node repos against the real (seeded) Postgres. Each test node gets a unique
 * name and is removed afterwards (audit rows reference it by id only, so they can stay).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { testWorkspace, uniq as uniqName } from '../testing/fixtures';
import * as nodes from './nodes';

let workspaceId = '';
const created: string[] = [];
const uniq = () => `t00-${randomBytes(4).toString('hex')}`;
const token = () => randomBytes(24).toString('base64url');

beforeAll(async () => {
  workspaceId = (await prisma.workspace.findUniqueOrThrow({ where: { slug: 'acme' } })).id;
});
afterAll(async () => {
  await prisma.browserNode.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

async function fresh(t = token()) {
  const n = await nodes.register({ workspaceId, name: uniq(), token: t, seatsLimit: 5 });
  created.push(n.id);
  return { n, t };
}

describe('nodes.register / verifyToken', () => {
  it('stores only the sha256 of the token', async () => {
    const { n, t } = await fresh();
    const row = await prisma.browserNode.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.tokenHash).toBe(nodes.hashToken(t));
    expect(row.tokenHash).not.toContain(t);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.status).toBe('offline');
    expect(n).not.toHaveProperty('tokenHash');
  });

  it('verifies by hash: right token passes, wrong or unknown fails', async () => {
    const { n, t } = await fresh();
    const ok = await nodes.verifyToken(n.name, t);
    expect(ok?.id).toBe(n.id);
    expect(ok).not.toHaveProperty('tokenHash');
    expect(await nodes.verifyToken(n.name, `${t}x`)).toBeNull();
    expect(await nodes.verifyToken(n.name, '')).toBeNull();
    expect(await nodes.verifyToken('no-such-node-t00', t)).toBeNull();
    expect(await nodes.verifyToken('Not A Name', t)).toBeNull();
  });

  it("does not accept another node's token", async () => {
    const a = await fresh();
    const b = await fresh();
    expect(await nodes.verifyToken(a.n.name, b.t)).toBeNull();
  });

  it('re-registering rotates the token', async () => {
    const { n, t } = await fresh();
    const t2 = token();
    await nodes.register({ workspaceId, name: n.name, token: t2 });
    expect(await nodes.verifyToken(n.name, t)).toBeNull();
    expect((await nodes.verifyToken(n.name, t2))?.id).toBe(n.id);
  });

  it('refuses a name another workspace already uses (names are the global queue and login)', async () => {
    const { n, t } = await fresh();
    const other = await prisma.workspace.create({ data: { name: 'Other', slug: `t00-${uniq()}` } });
    try {
      await expect(nodes.register({ workspaceId: other.id, name: n.name, token: token() })).rejects.toThrow(
        /another workspace/,
      );
      expect(await nodes.verifyToken(n.name, t)).not.toBeNull();
    } finally {
      await prisma.workspace.delete({ where: { id: other.id } });
    }
  });

  it('refuses short tokens and bad names', async () => {
    await expect(nodes.register({ workspaceId, name: uniq(), token: 'short' })).rejects.toThrow();
    await expect(nodes.register({ workspaceId, name: 'Bad Name', token: token() })).rejects.toThrow();
  });

  it('seed has browser-1 for dev', async () => {
    const n = await nodes.getByName(workspaceId, 'browser-1');
    expect(n).not.toBeNull();
    const profiles = await prisma.browserProfile.count({ where: { nodeId: n!.id } });
    expect(profiles).toBeGreaterThan(0);
  });
});

describe('nodes status', () => {
  const audits = (id: string) =>
    prisma.auditEvent.findMany({
      where: { targetType: 'BrowserNode', targetId: id },
      orderBy: { at: 'asc' },
    });

  it('markOnline / markOffline write node.online / node.offline once per transition', async () => {
    const { n } = await fresh();
    const hello = {
      agentVersion: '0.1.0',
      imageDigest: 'sha256:abc',
      maxProfiles: 6,
      seats: { inUse: 1, limit: 5 },
    };
    const on = await nodes.markOnline(n.id, hello);
    expect(on.status).toBe('online');
    expect(on.maxProfiles).toBe(6);
    expect(on.seatsInUse).toBe(1);
    expect(on.lastSeenAt).toBeInstanceOf(Date);
    await nodes.markOnline(n.id, hello); // reconnect while still online: no second row
    expect((await nodes.listOnline(workspaceId)).map((x) => x.id)).toContain(n.id);

    await nodes.markOffline(n.id, 'heartbeat timeout');
    await nodes.markOffline(n.id, 'socket closed'); // already offline: no second row
    expect((await nodes.listOnline()).map((x) => x.id)).not.toContain(n.id);

    const rows = await audits(n.id);
    expect(rows.map((r) => r.action)).toEqual(['node.online', 'node.offline']);
    expect(rows[1]!.meta).toMatchObject({ reason: 'heartbeat timeout', from: 'online' });
    expect(rows.every((r) => r.actorMemberId === null && r.workspaceId === workspaceId)).toBe(true);
  });

  it('recordHeartbeat updates seats and last seen without audit rows', async () => {
    const { n } = await fresh();
    const at = new Date('2026-11-07T12:00:00Z');
    const r = await nodes.recordHeartbeat(n.id, { inUse: 3, limit: null }, at);
    expect(r).toMatchObject({ seatsInUse: 3, seatsLimit: null, lastSeenAt: at });
    expect(await audits(n.id)).toEqual([]);
  });
});

describe('nodes.registerInWorkspace', () => {
  it('registers by slug and assigns only profiles without a node, only when asked', async () => {
    const profile = await prisma.browserProfile.findFirstOrThrow({
      where: { workspaceId, nodeId: { not: null } },
    });
    const others = await prisma.browserProfile.findMany({
      where: { workspaceId, nodeId: { not: null }, id: { not: profile.id } },
      select: { id: true, nodeId: true },
    });
    await prisma.browserProfile.update({ where: { id: profile.id }, data: { nodeId: null } });
    try {
      const plain = await nodes.registerInWorkspace({ workspaceSlug: 'acme', name: uniq(), token: token() });
      created.push(plain.node.id);
      expect(plain.assignedProfiles).toBe(0);

      const { node, assignedProfiles } = await nodes.registerInWorkspace({
        workspaceSlug: 'acme',
        name: uniq(),
        token: token(),
        assignUnassignedProfiles: true,
      });
      created.push(node.id);
      expect(assignedProfiles).toBe(1);
      expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id: profile.id } })).nodeId).toBe(
        node.id,
      );
      for (const o of others)
        expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id: o.id } })).nodeId).toBe(
          o.nodeId,
        );
    } finally {
      await prisma.browserProfile.update({ where: { id: profile.id }, data: { nodeId: profile.nodeId } });
    }
  });

  it('refuses an unknown workspace', async () => {
    await expect(
      nodes.registerInWorkspace({ workspaceSlug: 'no-such-ws', name: uniq(), token: token() }),
    ).rejects.toThrow(/no workspace/);
  });
});

describe('nodes.pickForProfile', () => {
  it('picks the least-loaded online node with room; ties by name; null when none', async () => {
    const ws = await testWorkspace();
    try {
      expect(await nodes.pickForProfile(ws.id)).toBeNull();
      // offline and draining nodes never get new profiles, even when empty
      await ws.node({ name: uniqName('a-off'), status: 'offline' });
      await ws.node({ name: uniqName('a-drain'), status: 'draining' });
      expect(await nodes.pickForProfile(ws.id)).toBeNull();

      const base = uniqName('n');
      const full = await ws.node({ name: `${base}-a-full`, maxProfiles: 1 });
      await ws.profileOn(full.id);
      expect(await nodes.pickForProfile(ws.id)).toBeNull(); // the only online node is full

      const busy = await ws.node({ name: `${base}-b-busy`, maxProfiles: 8 });
      await ws.profileOn(busy.id);
      await ws.profileOn(busy.id);
      const light = await ws.node({ name: `${base}-c-light`, maxProfiles: 8 });
      await ws.profileOn(light.id);
      expect((await nodes.pickForProfile(ws.id))?.id).toBe(light.id);

      // equal load: the name that sorts first wins
      const twin = await ws.node({ name: `${base}-b-twin`, maxProfiles: 8 });
      await ws.profileOn(twin.id);
      const pick = await nodes.pickForProfile(ws.id);
      expect(pick?.id).toBe(twin.id);
      expect(pick).not.toHaveProperty('tokenHash');
      expect(pick).not.toHaveProperty('_count');

      // unassigned profiles do not count against any node
      await ws.profileOn(null);
      expect((await nodes.pickForProfile(ws.id))?.id).toBe(twin.id);
    } finally {
      await ws.cleanup();
    }
  });

  it('never picks a node of another workspace', async () => {
    const a = await testWorkspace();
    const b = await testWorkspace();
    try {
      await b.node();
      expect(await nodes.pickForProfile(a.id)).toBeNull();
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
