/**
 * Integration: browser node repos against the real (seeded) Postgres. Each test node gets a unique
 * name and is removed afterwards (audit rows reference it by id only, so they can stay).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
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
