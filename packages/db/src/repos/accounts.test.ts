/**
 * Integration: browser-mode connect (docs/plans/0002-browser-mode.md) against the real Postgres. Each test
 * builds a throwaway workspace (testing/fixtures) and removes it afterwards; the seeded-draft test restores
 * the one field it changes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { testWorkspace } from '../testing/fixtures';
import * as accounts from './accounts';
import * as drafts from './drafts';

afterAll(async () => {
  await prisma.$disconnect();
});

const base = {
  roleLabel: 'founder' as const,
  disclosureLine: 'Disclosure: I work on Acme',
  dailyPostLimit: 5,
  selfPromoMax: 10,
  fingerprint: { os: 'macOS 15', screen: '1512×982', tz: 'America/New_York', locale: 'en-US' },
};
const audits = (workspaceId: string) =>
  prisma.auditEvent.findMany({ where: { workspaceId }, orderBy: { at: 'asc' } });

describe('accounts.isIdentified', () => {
  it('is true only when identifiedAt is set', () => {
    expect(accounts.isIdentified({ identifiedAt: new Date() })).toBe(true);
    expect(accounts.isIdentified({ identifiedAt: '2026-11-07T00:00:00Z' })).toBe(true);
    expect(accounts.isIdentified({ identifiedAt: null })).toBe(false);
    expect(accounts.isIdentified({ identifiedAt: undefined })).toBe(false);
  });
});

describe('accounts.startBrowserConnect', () => {
  it('creates a pending browser account + profile with a cloak fingerprint, a node and the proxy', async () => {
    const ws = await testWorkspace();
    try {
      const owner = await ws.member('Jane Doe');
      const node = await ws.node();
      const px = await prisma.proxy.create({
        data: { workspaceId: ws.id, provider: 'Decodo', protocol: 'http', host: 'isp.test', port: 10001 },
      });
      const r = await accounts.startBrowserConnect({
        ...base,
        workspaceId: ws.id,
        ownerMemberId: owner.id,
        proxyId: px.id,
      });
      expect(r.node).toEqual({ id: node.id, name: node.name });

      const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: r.accountId } });
      expect(acc).toMatchObject({
        authMode: 'browser',
        identifiedAt: null,
        username: `pending-${acc.id.slice(-6)}`,
        redditId: `pending:${acc.id}`,
        oauthTokenEnc: null,
        ownerMemberId: owner.id,
        dailyPostLimit: 5,
      });
      expect(r.username).toBe(acc.username);
      expect(accounts.isIdentified(acc)).toBe(false);

      const prof = await prisma.browserProfile.findUniqueOrThrow({ where: { id: r.profileId } });
      expect(prof).toMatchObject({
        accountId: acc.id,
        name: 'Jane · Chrome',
        cookiesVolume: `tl-profile-${acc.id}`,
        nodeId: node.id,
        proxyId: px.id,
        cloakPersona: 'macos',
        cloakGpu: 'intel',
      });
      expect(prof.cloakSeed).toEqual(expect.any(Number));

      const rows = await audits(ws.id);
      expect(rows.map((a) => a.action).sort()).toEqual(
        [
          'account.connect_started',
          'profile.fingerprint_assigned',
          'profile.node_assigned',
          'profile.proxy_updated',
        ].sort(),
      );
      expect(rows.every((a) => a.actorMemberId === owner.id && a.accountId === acc.id)).toBe(true);
      expect(rows.find((a) => a.action === 'account.connect_started')!.meta).toMatchObject({
        authMode: 'browser',
        profileId: prof.id,
      });
      expect(rows.find((a) => a.action === 'profile.node_assigned')!.meta).toMatchObject({
        from: null,
        to: node.name,
      });

      const card = (await accounts.listCards(ws.id)).find((c) => c.id === acc.id)!;
      expect(card).toMatchObject({ authMode: 'browser', identified: false, connected: false });
    } finally {
      await ws.cleanup();
    }
  });

  it('leaves the profile unassigned (and writes no node_assigned) when no online node has room', async () => {
    const ws = await testWorkspace();
    try {
      await ws.node({ status: 'offline' });
      const full = await ws.node({ maxProfiles: 1 });
      await ws.profileOn(full.id);
      const owner = await ws.member('Sam');
      const r = await accounts.startBrowserConnect({ ...base, workspaceId: ws.id, ownerMemberId: owner.id });
      expect(r.node).toBeNull();
      expect(
        (await prisma.browserProfile.findUniqueOrThrow({ where: { id: r.profileId } })).nodeId,
      ).toBeNull();
      const actions = (await audits(ws.id)).map((a) => a.action);
      expect(actions).toContain('account.connect_started');
      expect(actions).not.toContain('profile.node_assigned');
    } finally {
      await ws.cleanup();
    }
  });

  it('refuses a second account for the same owner, a non-member owner and a foreign proxy, atomically', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const owner = await ws.member('Leo');
      await accounts.startBrowserConnect({ ...base, workspaceId: ws.id, ownerMemberId: owner.id });
      await expect(
        accounts.startBrowserConnect({ ...base, workspaceId: ws.id, ownerMemberId: owner.id }),
      ).rejects.toThrow(/already own/);

      const outsider = await other.member('Out Sider');
      await expect(
        accounts.startBrowserConnect({ ...base, workspaceId: ws.id, ownerMemberId: outsider.id }),
      ).rejects.toThrow(/not a member/);

      const foreign = await prisma.proxy.create({
        data: { workspaceId: other.id, provider: 'x', protocol: 'http', host: 'f.test', port: 1 },
      });
      const m2 = await ws.member('Kim');
      await expect(
        accounts.startBrowserConnect({
          ...base,
          workspaceId: ws.id,
          ownerMemberId: m2.id,
          proxyId: foreign.id,
        }),
      ).rejects.toThrow(/Proxy not found/);

      expect(await prisma.redditAccount.count({ where: { workspaceId: ws.id } })).toBe(1);
      expect(await prisma.browserProfile.count({ where: { workspaceId: ws.id } })).toBe(1);
      expect(
        await prisma.auditEvent.count({ where: { workspaceId: ws.id, action: 'account.connect_started' } }),
      ).toBe(1);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});

describe('accounts.completeBrowserIdentity', () => {
  const who = { name: 'jane_from_acme', id: '1a2b3c', totalKarma: 4210, createdUtc: 1_546_300_800 };

  it('sets the identity, writes account.connected once, and is idempotent for the same id', async () => {
    const ws = await testWorkspace();
    try {
      const owner = await ws.member('Jane Doe');
      const { accountId, username: pending } = await accounts.startBrowserConnect({
        ...base,
        workspaceId: ws.id,
        ownerMemberId: owner.id,
      });
      const r = await accounts.completeBrowserIdentity(ws.id, accountId, who);
      expect(r).toEqual({ changed: true, username: 'jane_from_acme' });
      const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: accountId } });
      expect(acc).toMatchObject({
        username: 'jane_from_acme',
        redditId: 't2_1a2b3c',
        karma: 4210,
        accountCreatedAt: new Date(1_546_300_800_000),
        authMode: 'browser',
      });
      expect(acc.identifiedAt).toBeInstanceOf(Date);
      expect(accounts.isIdentified(acc)).toBe(true);

      expect(await accounts.completeBrowserIdentity(ws.id, accountId, { ...who, totalKarma: 1 })).toEqual({
        changed: false,
        username: 'jane_from_acme',
      });
      const connected = (await audits(ws.id)).filter((a) => a.action === 'account.connected');
      expect(connected).toHaveLength(1);
      expect(connected[0]!.meta).toMatchObject({
        username: 'jane_from_acme',
        authMode: 'browser',
        previous: pending,
      });
      const card = (await accounts.listCards(ws.id)).find((c) => c.id === accountId)!;
      expect(card).toMatchObject({ identified: true, connected: true, username: 'jane_from_acme' });
    } finally {
      await ws.cleanup();
    }
  });

  it('keeps karma and age when me.json did not return them', async () => {
    const ws = await testWorkspace();
    try {
      const owner = await ws.member('Kim');
      const { accountId } = await accounts.startBrowserConnect({
        ...base,
        workspaceId: ws.id,
        ownerMemberId: owner.id,
      });
      await accounts.completeBrowserIdentity(ws.id, accountId, { name: 'kim_k', id: 'z9' });
      const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: accountId } });
      expect(acc).toMatchObject({ username: 'kim_k', redditId: 't2_z9', karma: 0, accountCreatedAt: null });
    } finally {
      await ws.cleanup();
    }
  });

  it('refuses an identity another account of the workspace already has, and a different user later', async () => {
    const ws = await testWorkspace();
    try {
      const a = await ws.member('A');
      const b = await ws.member('B');
      const first = await accounts.startBrowserConnect({ ...base, workspaceId: ws.id, ownerMemberId: a.id });
      const second = await accounts.startBrowserConnect({ ...base, workspaceId: ws.id, ownerMemberId: b.id });
      await accounts.completeBrowserIdentity(ws.id, first.accountId, who);

      await expect(accounts.completeBrowserIdentity(ws.id, second.accountId, who)).rejects.toBeInstanceOf(
        accounts.AccountConflictError,
      );
      // same username, different case and id: still the same Reddit user name, refused
      await expect(
        accounts.completeBrowserIdentity(ws.id, second.accountId, { name: 'JANE_FROM_ACME', id: 'ffff' }),
      ).rejects.toThrow(/already connected/);
      const still = await prisma.redditAccount.findUniqueOrThrow({ where: { id: second.accountId } });
      expect(still.identifiedAt).toBeNull();
      expect(still.username).toBe(second.username);

      // the first account's browser now shows somebody else: refused, identity unchanged
      await expect(
        accounts.completeBrowserIdentity(ws.id, first.accountId, { name: 'someone_else', id: 'abc' }),
      ).rejects.toThrow(/signed in as u\/someone_else/);
      expect(
        (await prisma.redditAccount.findUniqueOrThrow({ where: { id: first.accountId } })).redditId,
      ).toBe('t2_1a2b3c');
    } finally {
      await ws.cleanup();
    }
  });

  it('refuses OAuth accounts, other workspaces and malformed identities', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const { accountId: oauthId } = await ws.profileOn(null);
      await expect(accounts.completeBrowserIdentity(ws.id, oauthId, who)).rejects.toThrow(/browser-mode/);
      const owner = await ws.member('C');
      const { accountId } = await accounts.startBrowserConnect({
        ...base,
        workspaceId: ws.id,
        ownerMemberId: owner.id,
      });
      await expect(accounts.completeBrowserIdentity(other.id, accountId, who)).rejects.toThrow(/not found/);
      await expect(
        accounts.completeBrowserIdentity(ws.id, accountId, { name: 'jane', id: 't2_1a2b3c' }),
      ).rejects.toThrow(/invalid Reddit account id/);
      await expect(
        accounts.completeBrowserIdentity(ws.id, accountId, { name: 'has space', id: '1a' }),
      ).rejects.toThrow(/invalid Reddit username/);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});

describe('publish gate: unidentified accounts', () => {
  it('drafts.evaluate fails account_eligible (block) while the account is not signed in', async () => {
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { slug: 'acme' } });
    const d0 = await prisma.draft.findFirstOrThrow({
      where: { workspaceId: ws.id },
      orderBy: { createdAt: 'asc' },
    });
    const before = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d0.accountId } });
    expect(before.identifiedAt).not.toBeNull();
    try {
      await prisma.redditAccount.update({ where: { id: d0.accountId }, data: { identifiedAt: null } });
      const d = (await drafts.get(ws.id, d0.id))!;
      const check = (await drafts.evaluate(d)).find((c) => c.key === 'account_eligible')!;
      expect(check).toMatchObject({ level: 'block', passed: false });
      expect(check.detail).toMatch(/not signed in yet/);
    } finally {
      await prisma.redditAccount.update({
        where: { id: d0.accountId },
        data: { identifiedAt: before.identifiedAt },
      });
    }
    const d = (await drafts.get(ws.id, d0.id))!;
    const check = (await drafts.evaluate(d)).find((c) => c.key === 'account_eligible')!;
    expect(check.detail).not.toMatch(/not signed in yet/);
  });
});
