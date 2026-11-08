/**
 * Integration: browser-node functions of the browsers repo against the real (seeded) Postgres.
 * Tests reset the fields they touch on seeded rows first and restore them afterwards.
 */
import { randomBytes } from 'node:crypto';
import { encrypt } from '@threadline/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { testWorkspace, uniq } from '../testing/fixtures';
import * as browsers from './browsers';
import * as nodes from './nodes';

let workspaceId = '';
let profileId = '';
let accountId = '';
const createdNodes: string[] = [];

beforeAll(async () => {
  workspaceId = (await prisma.workspace.findUniqueOrThrow({ where: { slug: 'acme' } })).id;
  const p = await prisma.browserProfile.findFirstOrThrow({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  profileId = p.id;
  accountId = p.accountId;
  if (!process.env.APP_ENCRYPTION_KEY) process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});
afterAll(async () => {
  await prisma.redditAccount.update({
    where: { id: accountId },
    data: { pausedReason: null, pausedAt: null },
  });
  await prisma.browserNode.deleteMany({ where: { id: { in: createdNodes } } });
  await prisma.$disconnect();
});

const auditsFor = (action: string, targetId: string, since: Date) =>
  prisma.auditEvent.findMany({ where: { action, targetId, at: { gte: since } }, orderBy: { at: 'asc' } });

describe('browsers.ensureCloakFingerprint', () => {
  it('assigns once, writes profile.fingerprint_assigned once, and never changes on later calls', async () => {
    await prisma.browserProfile.update({
      where: { id: profileId },
      data: { cloakSeed: null, cloakPersona: null, cloakGpu: null },
    });
    const since = new Date();
    const first = await browsers.ensureCloakFingerprint({ workspaceId, profileId });
    expect(first.assigned).toBe(true);
    expect(Number.isInteger(first.seed)).toBe(true);
    expect(first.seed).toBeGreaterThanOrEqual(0);
    expect(first.seed).toBeLessThan(2 ** 31);

    const second = await browsers.ensureCloakFingerprint({
      workspaceId,
      profileId,
      persona: 'linux',
      gpu: 'amd',
    });
    expect(second).toEqual({ ...first, assigned: false });

    const row = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(row.cloakSeed).toBe(first.seed);
    const salt = (row.fingerprint as browsers.Fingerprint).cloakSalt!;
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(browsers.deriveCloakSeed(profileId, salt)).toBe(first.seed);

    const rows = await auditsFor('profile.fingerprint_assigned', profileId, since);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(accountId);
  });

  it('two concurrent first calls agree on one seed', async () => {
    await prisma.browserProfile.update({ where: { id: profileId }, data: { cloakSeed: null } });
    const [a, b] = await Promise.all([
      browsers.ensureCloakFingerprint({ workspaceId, profileId }),
      browsers.ensureCloakFingerprint({ workspaceId, profileId }),
    ]);
    expect(a.seed).toBe(b.seed);
    expect([a.assigned, b.assigned].filter(Boolean)).toHaveLength(1);
  });

  it('derives persona from the captured OS', () => {
    expect(browsers.personaFromOs('macOS 15')).toBe('macos');
    expect(browsers.personaFromOs('Windows 11')).toBe('windows');
    expect(browsers.personaFromOs('Ubuntu 24.04')).toBe('linux');
    expect(browsers.personaFromOs(undefined)).toBe('windows');
  });

  it('different salts give different seeds for one profile', () => {
    expect(browsers.deriveCloakSeed('p', 'a')).not.toBe(browsers.deriveCloakSeed('p', 'b'));
  });
});

describe('browsers.pauseAccount / resumeAccount', () => {
  it('pause writes account.paused; a second pause keeps the first reason and writes nothing', async () => {
    await prisma.redditAccount.update({
      where: { id: accountId },
      data: { pausedReason: null, pausedAt: null },
    });
    const since = new Date();
    const r1 = await browsers.pauseAccount({
      workspaceId,
      accountId,
      reason: 'needs_human',
      detail: 'captcha',
    });
    expect(r1).toEqual({ changed: true, reason: 'needs_human' });
    const r2 = await browsers.pauseAccount({ workspaceId, accountId, reason: 'node_offline' });
    expect(r2).toEqual({ changed: false, reason: 'needs_human' });

    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.pausedReason).toBe('needs_human');
    expect(acc.pausedAt).toBeInstanceOf(Date);

    const rows = await auditsFor('account.paused', accountId, since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'RedditAccount', accountId, actorMemberId: null });
    expect(rows[0]!.meta).toMatchObject({ reason: 'needs_human', detail: 'captcha' });
  });

  it('resume with onlyReasons leaves other pauses alone; plain resume clears and writes account.resumed', async () => {
    const since = new Date();
    const skip = await browsers.resumeAccount({ workspaceId, accountId, onlyReasons: ['node_offline'] });
    expect(skip).toEqual({ changed: false, was: 'needs_human' });
    expect(await auditsFor('account.resumed', accountId, since)).toHaveLength(0);

    const member = await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId, role: 'admin' } });
    const done = await browsers.resumeAccount({ workspaceId, accountId, actorMemberId: member.id });
    expect(done).toEqual({ changed: true, was: 'needs_human' });
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.pausedReason).toBeNull();
    expect(acc.pausedAt).toBeNull();

    const rows = await auditsFor('account.resumed', accountId, since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorMemberId: member.id });
    expect(await browsers.resumeAccount({ workspaceId, accountId })).toEqual({ changed: false, was: null });
  });

  it('refuses an account from another workspace', async () => {
    await expect(
      browsers.pauseAccount({ workspaceId: 'not-a-workspace', accountId, reason: 'manual' }),
    ).rejects.toThrow();
  });
});

describe('browsers.assignNode / getProfileForDispatch', () => {
  it('assigns a node in the same workspace only', async () => {
    const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
    const n = await nodes.register({
      workspaceId,
      name: `t00-${randomBytes(4).toString('hex')}`,
      token: 'x'.repeat(32),
    });
    createdNodes.push(n.id);
    expect(await browsers.assignNode(workspaceId, profileId, n.id)).toEqual({ id: profileId, nodeId: n.id });
    await expect(browsers.assignNode('not-a-workspace', profileId, n.id)).rejects.toThrow();
    await browsers.assignNode(workspaceId, profileId, before.nodeId);
  });

  it('returns decrypted proxy credentials, cloak fields and a normalized screen', async () => {
    const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
    const proxy = await prisma.proxy.create({
      data: {
        workspaceId,
        provider: 'test',
        protocol: 'socks5',
        host: 'proxy.test',
        port: 1080,
        usernameEnc: encrypt('user-t00'),
        passwordEnc: encrypt('pass-t00'),
      },
    });
    try {
      await prisma.browserProfile.update({ where: { id: profileId }, data: { proxyId: proxy.id } });
      await browsers.ensureCloakFingerprint({ workspaceId, profileId });
      const d = await browsers.getProfileForDispatch(workspaceId, profileId);
      expect(d).not.toBeNull();
      expect(d!.proxy).toEqual({
        protocol: 'socks5',
        host: 'proxy.test',
        port: 1080,
        username: 'user-t00',
        password: 'pass-t00',
      });
      expect(d!.cloak).toMatchObject({ seed: expect.any(Number) });
      expect(d!.screen).toMatch(/^\d+x\d+$/);
      expect(d!.account.id).toBe(accountId);
      expect(await browsers.getProfileForDispatch('not-a-workspace', profileId)).toBeNull();
    } finally {
      await prisma.browserProfile.update({ where: { id: profileId }, data: { proxyId: before.proxyId } });
      await prisma.proxy.delete({ where: { id: proxy.id } });
    }
  });

  it('a proxy with protocol none dispatches without a proxy', async () => {
    const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
    const proxy = await prisma.proxy.create({ data: { workspaceId, provider: 'none', protocol: 'none' } });
    try {
      await prisma.browserProfile.update({ where: { id: profileId }, data: { proxyId: proxy.id } });
      expect((await browsers.getProfileForDispatch(workspaceId, profileId))!.proxy).toBeNull();
    } finally {
      await prisma.browserProfile.update({ where: { id: profileId }, data: { proxyId: before.proxyId } });
      await prisma.proxy.delete({ where: { id: proxy.id } });
    }
  });
});

describe('browsers.assignNode audit', () => {
  it('writes profile.node_assigned { from, to } on each change, nothing when unchanged', async () => {
    const ws = await testWorkspace();
    try {
      const a = await ws.node({ name: uniq('t00-a') });
      const b = await ws.node({ name: uniq('t00-b') });
      const { profileId: pid } = await ws.profileOn(null);
      const actor = await ws.member('Admin Person');
      await browsers.assignNode(ws.id, pid, a.id, actor.id);
      await browsers.assignNode(ws.id, pid, a.id, actor.id); // unchanged: no row
      await browsers.assignNode(ws.id, pid, b.id);
      await browsers.assignNode(ws.id, pid, null);
      const rows = await prisma.auditEvent.findMany({
        where: { workspaceId: ws.id, action: 'profile.node_assigned', targetId: pid },
        orderBy: { at: 'asc' },
      });
      expect(rows.map((r) => r.meta)).toMatchObject([
        { from: null, to: a.name, toNodeId: a.id },
        { from: a.name, to: b.name, fromNodeId: a.id, toNodeId: b.id },
        { from: b.name, to: null, toNodeId: null },
      ]);
      expect(rows[0]!.actorMemberId).toBe(actor.id);
      expect(rows[1]!.actorMemberId).toBeNull();
      expect(rows.every((r) => r.targetType === 'BrowserProfile')).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("refuses another workspace's node and writes nothing", async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const n = await other.node();
      const { profileId: pid } = await ws.profileOn(null);
      await expect(browsers.assignNode(ws.id, pid, n.id)).rejects.toThrow();
      expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id: pid } })).nodeId).toBeNull();
      expect(
        await prisma.auditEvent.count({ where: { action: 'profile.node_assigned', targetId: pid } }),
      ).toBe(0);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});

describe('browsers.listProxies / attachProxy', () => {
  it('lists the workspace proxies without any encrypted field', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const withCreds = await prisma.proxy.create({
        data: {
          workspaceId: ws.id,
          provider: 'Decodo',
          protocol: 'http',
          host: 'isp.decodo.test',
          port: 10001,
          usernameEnc: encrypt('user-t00-secret'),
          passwordEnc: encrypt('pass-t00-secret'),
        },
      });
      await prisma.proxy.create({ data: { workspaceId: ws.id, provider: 'none', protocol: 'none' } });
      const { profileId: pid } = await ws.profileOn(null);
      await prisma.browserProfile.update({ where: { id: pid }, data: { proxyId: withCreds.id } });

      const list = await browsers.listProxies(ws.id);
      expect(list.map((p) => p.provider)).toEqual(['Decodo', 'none']);
      expect(list[0]).toMatchObject({
        host: 'isp.decodo.test',
        port: 10001,
        hasCredentials: true,
        profileCount: 1,
      });
      expect(list[1]).toMatchObject({ hasCredentials: false, profileCount: 0 });
      const wire = JSON.stringify(list);
      expect(wire).not.toMatch(/usernameEnc|passwordEnc|t00-secret/);
      expect(wire).not.toContain(withCreds.passwordEnc!);
      expect(await browsers.listProxies(other.id)).toEqual([]);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });

  it('attaches an existing proxy once (audit profile.proxy_updated), only within the workspace', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const px = await prisma.proxy.create({
        data: { workspaceId: ws.id, provider: 'Decodo', protocol: 'http', host: 'h.test', port: 1 },
      });
      const foreign = await prisma.proxy.create({
        data: { workspaceId: other.id, provider: 'x', protocol: 'http', host: 'f.test', port: 2 },
      });
      const { profileId: pid } = await ws.profileOn(null);
      expect(await browsers.attachProxy(ws.id, pid, px.id)).toEqual({ changed: true });
      expect(await browsers.attachProxy(ws.id, pid, px.id)).toEqual({ changed: false });
      expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id: pid } })).proxyId).toBe(px.id);
      await expect(browsers.attachProxy(ws.id, pid, foreign.id)).rejects.toThrow(/Proxy not found/);
      expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id: pid } })).proxyId).toBe(px.id);
      const rows = await prisma.auditEvent.findMany({
        where: { action: 'profile.proxy_updated', targetId: pid },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.meta).toMatchObject({ attachedProxyId: px.id, previousProxyId: null, host: 'h.test' });
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});

describe('browsers.normalizeLocale', () => {
  it('keeps one BCP 47 tag from a captured language list', () => {
    expect(browsers.normalizeLocale('en-US, en, zh-CN')).toBe('en-US');
    expect(browsers.normalizeLocale('de-DE;q=0.9,en')).toBe('de-DE');
    expect(browsers.normalizeLocale('fr')).toBe('fr');
  });
  it('falls back to en-US for missing or malformed values', () => {
    expect(browsers.normalizeLocale(undefined)).toBe('en-US');
    expect(browsers.normalizeLocale('')).toBe('en-US');
    expect(browsers.normalizeLocale('English (US)')).toBe('en-US');
  });
});
