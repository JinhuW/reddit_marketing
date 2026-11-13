/** Integration: the proxy pool (docs/plans/0004-browser-parity.md, phase 3). */
import { randomBytes } from 'node:crypto';
import { encrypt } from '@threadline/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { testWorkspace } from '../testing/fixtures';
import * as browsers from './browsers';

beforeAll(() => {
  if (!process.env.APP_ENCRYPTION_KEY) process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});
afterAll(() => prisma.$disconnect());

const item = (over: Partial<browsers.NewProxy> & { password?: string } = {}): browsers.NewProxy => {
  const { password, ...rest } = over;
  const username = rest.username === undefined ? 'user-1' : rest.username;
  return {
    protocol: 'http',
    host: 'gate.pool.test',
    port: 7000,
    username,
    usernameEnc: username ? encrypt(username) : null,
    passwordEnc: encrypt(password ?? 'pool-secret-pass'),
    ...rest,
  };
};
const audits = (workspaceId: string, action: string) =>
  prisma.auditEvent.findMany({ where: { workspaceId, action } });

describe('browsers.addProxies', () => {
  it('adds each login on a shared gateway once, and never returns or audits a secret', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const me = await ws.member();
      const link = 'https://vendor.test/rotate?token=link-secret-token';
      const first = await browsers.addProxies(ws.id, me.id, [
        item({ label: '  US mobile 3 ', notes: 'bought in March', refreshUrlEnc: encrypt(link) }),
        item({ username: 'user-2' }),
        item({ username: 'user-2' }), // twice in one paste
        item({ username: null, host: 'plain.pool.test', port: 8080 }),
      ]);
      expect(first).toMatchObject({ added: 3, skipped: 1 });
      // The same list again adds nothing.
      expect(await browsers.addProxies(ws.id, me.id, [item(), item({ username: 'user-2' })])).toMatchObject({
        added: 0,
        skipped: 2,
      });
      // Another workspace has its own pool.
      expect((await browsers.addProxies(other.id, (await other.member()).id, [item()])).added).toBe(1);

      const list = await browsers.listProxies(ws.id);
      expect(list).toHaveLength(3);
      expect(list[0]).toMatchObject({
        label: 'US mobile 3',
        notes: 'bought in March',
        hasCredentials: true,
        hasRefreshUrl: true,
        profileCount: 0,
      });
      expect(list[2]).toMatchObject({ host: 'plain.pool.test', hasRefreshUrl: false });
      const wire = JSON.stringify([list, await audits(ws.id, 'proxy.created')]);
      for (const secret of ['pool-secret-pass', 'link-secret-token', 'user-2', 'Enc"'])
        expect(wire).not.toContain(secret);
      expect(await audits(ws.id, 'proxy.created')).toHaveLength(3);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});

describe('browsers.updateProxy', () => {
  it('keeps what is not sent, clears the last check when the exit changes, audits field names only', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const [id] = (await browsers.addProxies(ws.id, me.id, [item()])).ids;
      await browsers.recordProxyCheck(ws.id, id!, { ok: true, ip: '203.0.113.9', testedAt: 'now' });
      const before = await prisma.proxy.findUniqueOrThrow({ where: { id } });

      // A name and a note: nothing about the exit changed, so the check stays.
      expect(await browsers.updateProxy(ws.id, id!, me.id, { label: 'Renamed', notes: '' })).toEqual({
        changed: ['label'],
      });
      const renamed = await prisma.proxy.findUniqueOrThrow({ where: { id } });
      expect(renamed.passwordEnc).toBe(before.passwordEnc);
      expect(renamed.lastTest).toMatchObject({ ip: '203.0.113.9' });

      const r = await browsers.updateProxy(ws.id, id!, me.id, {
        port: 7001,
        passwordEnc: encrypt('new-secret-pass'),
        refreshUrlEnc: encrypt('https://vendor.test/r?token=t2'),
      });
      expect(r.changed.sort()).toEqual(['password', 'port', 'refreshUrl']);
      const moved = await prisma.proxy.findUniqueOrThrow({ where: { id } });
      expect(moved.lastTest).toEqual({});
      expect(moved.usernameEnc).toBe(before.usernameEnc);

      await browsers.updateProxy(ws.id, id!, me.id, {
        usernameEnc: null,
        passwordEnc: null,
        refreshUrlEnc: null,
      });
      expect((await browsers.listProxies(ws.id))[0]).toMatchObject({
        hasCredentials: false,
        hasRefreshUrl: false,
      });
      expect(await browsers.updateProxy(ws.id, id!, me.id, { label: 'Renamed' })).toEqual({ changed: [] });
      await expect(browsers.updateProxy(ws.id, 'nope', me.id, { label: 'x' })).rejects.toThrow(/not found/);
      expect(JSON.stringify(await audits(ws.id, 'proxy.updated'))).not.toMatch(/secret|token/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('browsers.deleteProxies / pickUnusedProxy', () => {
  it('keeps a proxy browsers use unless told to detach, and picks only unused ones', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const me = await ws.member();
      const [used, free] = (await browsers.addProxies(ws.id, me.id, [item(), item({ username: 'user-2' })]))
        .ids as [string, string];
      const [foreign] = (await browsers.addProxies(other.id, (await other.member()).id, [item()])).ids;
      const { profileId } = await ws.profileOn(null);
      await browsers.attachProxy(ws.id, profileId, used, me.id);

      expect(await browsers.pickUnusedProxy(ws.id)).toEqual({ id: free });
      expect(await browsers.deleteProxies(ws.id, me.id, [used, free, foreign!])).toEqual({
        deleted: 1,
        inUse: 1,
        detached: 0,
      });
      expect((await browsers.listProxies(ws.id)).map((p) => p.id)).toEqual([used]);
      expect(await prisma.proxy.count({ where: { id: foreign } })).toBe(1); // another workspace's proxy
      expect(await browsers.pickUnusedProxy(ws.id)).toBeNull();

      expect(await browsers.deleteProxies(ws.id, me.id, [used], { detach: true })).toEqual({
        deleted: 1,
        inUse: 0,
        detached: 1,
      });
      expect(
        (await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } })).proxyId,
      ).toBeNull();
      expect(await audits(ws.id, 'proxy.deleted')).toHaveLength(2);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});

describe('browsers.getProxyForDispatch / recordProxyCheck', () => {
  it('decrypts only for the gateway and stores a check on the proxy', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const me = await ws.member();
      const link = 'https://vendor.test/rotate?token=abc';
      const [id] = (await browsers.addProxies(ws.id, me.id, [item({ refreshUrlEnc: encrypt(link) })])).ids;
      expect(await browsers.getProxyForDispatch(ws.id, id!)).toEqual({
        id,
        spec: {
          protocol: 'http',
          host: 'gate.pool.test',
          port: 7000,
          username: 'user-1',
          password: 'pool-secret-pass',
        },
        refreshUrl: link,
      });
      expect(await browsers.getProxyForDispatch(other.id, id!)).toBeNull();

      expect(await browsers.recordProxyCheck(other.id, id!, { ok: true })).toEqual({ stored: false });
      await browsers.recordProxyCheck(ws.id, id!, { ok: true, ip: '203.0.113.9', latencyMs: 80 });
      await browsers.recordProxyCheck(ws.id, id!, { ok: false, error: 'proxy_auth_failed' });
      // A failed check replaces the earlier readings.
      expect((await browsers.listProxies(ws.id))[0]?.lastTest).toEqual({
        ok: false,
        error: 'proxy_auth_failed',
      });
      await browsers.recordProxyRotated(ws.id, id!, 200);
      expect(await audits(ws.id, 'proxy.rotated')).toHaveLength(1);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});
