/** Integration: live profile status and stored connection tests (docs/plans/0004-browser-parity.md, phase 0). */
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { testWorkspace } from '../testing/fixtures';
import * as browsers from './browsers';

afterAll(() => prisma.$disconnect());

const statusOf = async (id: string) =>
  (await prisma.browserProfile.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

describe('browsers.syncNodeRunning / setStatus', () => {
  it('follows what the node reports and leaves other nodes and error states alone', async () => {
    const ws = await testWorkspace();
    try {
      const n1 = await ws.node();
      const n2 = await ws.node();
      const a = (await ws.profileOn(n1.id)).profileId;
      const b = (await ws.profileOn(n1.id)).profileId;
      const c = (await ws.profileOn(n1.id)).profileId;
      const other = (await ws.profileOn(n2.id)).profileId;
      await browsers.setStatus(ws.id, other, 'running');
      await browsers.setStatus(ws.id, c, 'error');

      await browsers.syncNodeRunning(n1.id, [a, b, other]);
      expect([await statusOf(a), await statusOf(b), await statusOf(c)]).toEqual([
        'running',
        'running',
        'error',
      ]);
      expect(await statusOf(other)).toBe('running');

      await browsers.syncNodeRunning(n1.id, [b]);
      expect([await statusOf(a), await statusOf(b), await statusOf(c)]).toEqual(['idle', 'running', 'error']);

      await browsers.syncNodeRunning(n1.id, []);
      expect(await statusOf(b)).toBe('idle');
      expect(await statusOf(other)).toBe('running');
    } finally {
      await ws.cleanup();
    }
  });

  it('setStatus stays inside the workspace', async () => {
    const ws = await testWorkspace();
    const foreign = await testWorkspace();
    try {
      const { profileId } = await ws.profileOn(null);
      await browsers.setStatus(foreign.id, profileId, 'running');
      expect(await statusOf(profileId)).toBe('idle');
    } finally {
      await ws.cleanup();
      await foreign.cleanup();
    }
  });
});

describe('browsers.recordProxyTest', () => {
  it('stores the test on the proxy and keeps its display hints', async () => {
    const ws = await testWorkspace();
    try {
      const px = await prisma.proxy.create({
        data: {
          workspaceId: ws.id,
          provider: 'Decodo',
          protocol: 'http',
          host: 'h.test',
          port: 1,
          lastTest: { kind: 'Residential', label: 'us-east', ip: '192.0.2.1', redditOk: true },
        },
      });
      const { profileId } = await ws.profileOn(null);
      expect(await browsers.recordProxyTest(ws.id, profileId, { ok: true, ip: '203.0.113.9' })).toEqual({
        stored: false,
      });
      await prisma.browserProfile.update({ where: { id: profileId }, data: { proxyId: px.id } });
      const failed = { ok: false, error: 'proxy_auth_failed', testedAt: '2026-11-12T10:00:00.000Z' };
      expect(await browsers.recordProxyTest(ws.id, profileId, failed)).toEqual({ stored: true });
      const row = await prisma.proxy.findUniqueOrThrow({ where: { id: px.id } });
      // A new test replaces the old readings: a failed test must not keep showing the earlier exit IP.
      expect(row.lastTest).toEqual({ kind: 'Residential', label: 'us-east', ...failed });
    } finally {
      await ws.cleanup();
    }
  });
});
