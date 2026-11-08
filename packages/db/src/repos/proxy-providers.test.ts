/**
 * Integration: workspace proxy providers (Settings → Proxies) in the browsers repo, against the real Postgres.
 * Every test runs in its own throwaway workspace.
 */
import { randomBytes } from 'node:crypto';
import { encrypt } from '@threadline/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { type TestWorkspace, testWorkspace } from '../testing/fixtures';
import * as accounts from './accounts';
import * as browsers from './browsers';

beforeAll(() => {
  if (!process.env.APP_ENCRYPTION_KEY) process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});
afterAll(() => prisma.$disconnect());

const spaces: TestWorkspace[] = [];
async function ws() {
  const w = await testWorkspace();
  spaces.push(w);
  return w;
}
afterAll(async () => {
  for (const w of spaces) await w.cleanup();
});

const decodo = (over: Partial<browsers.ProviderInput> = {}): browsers.ProviderInput => ({
  name: 'Decodo',
  protocol: 'http',
  host: 'isp.decodo.test',
  portFrom: 10001,
  portTo: 10010,
  region: 'US',
  usernameEnc: encrypt('user-t00-secret'),
  passwordEnc: encrypt('pass-t00-secret'),
  ...over,
});

describe('browsers.saveProvider / listProviders', () => {
  it('never returns credentials; shows the saved flags and the ports in use', async () => {
    const w = await ws();
    const admin = await w.member('Admin');
    const { id, created } = await browsers.saveProvider(w.id, admin.id, decodo());
    expect(created).toBe(true);
    const { profileId } = await w.profileOn(null);
    await browsers.assignProviderPort(w.id, profileId, id, 10006, admin.id);

    const list = await browsers.listProviders(w.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'Decodo',
      host: 'isp.decodo.test',
      portFrom: 10001,
      portTo: 10010,
      hasCredentials: true,
      hasUsername: true,
      hasPassword: true,
      portsInUse: [{ port: 10006, profileId, profileName: 'Test · Chrome' }],
    });
    const wire = JSON.stringify(list);
    expect(wire).not.toMatch(/usernameEnc|passwordEnc|t00-secret/);
    const row = await prisma.proxyProvider.findUniqueOrThrow({ where: { id } });
    expect(wire).not.toContain(row.passwordEnc!);
    expect(await browsers.listProviders((await ws()).id)).toEqual([]);

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'settings.proxy_provider_saved', targetId: id },
    });
    expect(JSON.stringify(audit.meta)).not.toMatch(/t00-secret/);
    expect(audit.meta).toMatchObject({ created: true, name: 'Decodo', credentialsChanged: true });
  });

  it('empty credentials keep the saved values; a name clash and a bad range are refused', async () => {
    const w = await ws();
    const admin = await w.member('Admin');
    const { id } = await browsers.saveProvider(w.id, admin.id, decodo());
    const before = await prisma.proxyProvider.findUniqueOrThrow({ where: { id } });
    await browsers.saveProvider(w.id, admin.id, {
      ...decodo({ usernameEnc: undefined, passwordEnc: undefined }),
      id,
      host: 'isp2.decodo.test',
    });
    const after = await prisma.proxyProvider.findUniqueOrThrow({ where: { id } });
    expect(after.host).toBe('isp2.decodo.test');
    expect(after.usernameEnc).toBe(before.usernameEnc);
    expect(after.passwordEnc).toBe(before.passwordEnc);

    await expect(browsers.saveProvider(w.id, admin.id, decodo())).rejects.toThrow(/already exists/);
    await expect(
      browsers.saveProvider(w.id, admin.id, decodo({ name: 'B', portFrom: 10, portTo: 5 })),
    ).rejects.toThrow(/range/);
    await expect(
      browsers.saveProvider(w.id, admin.id, decodo({ name: 'C', portFrom: 10, portTo: null })),
    ).rejects.toThrow(/both ends/);
  });

  it('refuses to narrow the range past a port in use', async () => {
    const w = await ws();
    const admin = await w.member('Admin');
    const { id } = await browsers.saveProvider(w.id, admin.id, decodo());
    const { profileId } = await w.profileOn(null);
    await browsers.assignProviderPort(w.id, profileId, id, 10008, admin.id);
    await expect(
      browsers.saveProvider(w.id, admin.id, { ...decodo(), id, portFrom: 10001, portTo: 10005 }),
    ).rejects.toThrow(/Port 10008 is used/);
  });
});

describe('browsers.assignProviderPort', () => {
  it('creates one port row, attaches it, audits provider + port (no credentials)', async () => {
    const w = await ws();
    const admin = await w.member('Admin');
    const { id } = await browsers.saveProvider(w.id, admin.id, decodo());
    const { profileId, accountId } = await w.profileOn(null);
    const r = await browsers.assignProviderPort(w.id, profileId, id, 10006, admin.id);
    expect(r.changed).toBe(true);
    expect(await browsers.assignProviderPort(w.id, profileId, id, 10006, admin.id)).toEqual({
      proxyId: r.proxyId,
      changed: false,
    });
    const px = await prisma.proxy.findUniqueOrThrow({ where: { id: r.proxyId } });
    expect(px).toMatchObject({ providerId: id, port: 10006, usernameEnc: null, passwordEnc: null });

    const rows = await prisma.auditEvent.findMany({
      where: { action: 'profile.proxy_updated', targetId: profileId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(accountId);
    expect(rows[0]!.meta).toMatchObject({ provider: 'Decodo', port: 10006, providerId: id });
    expect(JSON.stringify(rows[0]!.meta)).not.toMatch(/secret|Enc/);

    // Moving to another port drops the unused row.
    const r2 = await browsers.assignProviderPort(w.id, profileId, id, 10007, admin.id);
    expect(await prisma.proxy.findUnique({ where: { id: r.proxyId } })).toBeNull();
    expect(r2.proxyId).not.toBe(r.proxyId);
  });

  it('refuses a port outside the range and one another profile uses (incl. a standalone row)', async () => {
    const w = await ws();
    const admin = await w.member('Admin');
    const { id } = await browsers.saveProvider(w.id, admin.id, decodo());
    const a = await w.profileOn(null);
    const b = await w.profileOn(null);
    await expect(browsers.assignProviderPort(w.id, a.profileId, id, 10011, admin.id)).rejects.toThrow(
      /outside Decodo’s range 10001–10010/,
    );
    await browsers.assignProviderPort(w.id, a.profileId, id, 10002, admin.id);
    await expect(browsers.assignProviderPort(w.id, b.profileId, id, 10002, admin.id)).rejects.toThrow(
      /already used by/,
    );
    // A standalone proxy on the same host:port (add-proxy CLI) counts as used too.
    const cli = await prisma.proxy.create({
      data: { workspaceId: w.id, provider: 'Decodo', protocol: 'http', host: 'isp.decodo.test', port: 10003 },
    });
    await prisma.browserProfile.update({ where: { id: b.profileId }, data: { proxyId: cli.id } });
    const c = await w.profileOn(null);
    await expect(browsers.assignProviderPort(w.id, c.profileId, id, 10003, admin.id)).rejects.toThrow(
      /already used by/,
    );
    // ...but its own profile can move onto the provider at that port.
    await browsers.assignProviderPort(w.id, b.profileId, id, 10003, admin.id);
    const used = (await browsers.listProviders(w.id))[0]!.portsInUse.map((u) => u.port);
    expect(used).toEqual([10002, 10003]);
  });

  it('accepts any port when the provider has no range; refuses a foreign provider', async () => {
    const w = await ws();
    const other = await ws();
    const admin = await w.member('Admin');
    const { id } = await browsers.saveProvider(w.id, admin.id, decodo({ portFrom: null, portTo: null }));
    const { profileId } = await w.profileOn(null);
    await browsers.assignProviderPort(w.id, profileId, id, 22225, admin.id);
    const oAdmin = await other.member('Admin');
    const foreign = await browsers.saveProvider(other.id, oAdmin.id, decodo());
    await expect(browsers.assignProviderPort(w.id, profileId, foreign.id, 10001, admin.id)).rejects.toThrow(
      /not found/,
    );
  });
});

describe('getProfileForDispatch with a provider', () => {
  it('takes host, protocol and credentials from the provider; a new password reaches dispatch', async () => {
    const w = await ws();
    const admin = await w.member('Admin');
    const { id } = await browsers.saveProvider(w.id, admin.id, decodo());
    const { profileId } = await w.profileOn(null);
    const { proxyId } = await browsers.assignProviderPort(w.id, profileId, id, 10006, admin.id);
    // Stale values on the row itself are ignored.
    await prisma.proxy.update({
      where: { id: proxyId },
      data: {
        host: 'stale.test',
        protocol: 'socks5',
        usernameEnc: encrypt('row-user'),
        passwordEnc: encrypt('row-pass'),
      },
    });

    const d1 = await browsers.getProfileForDispatch(w.id, profileId);
    expect(d1!.proxy).toEqual({
      protocol: 'http',
      host: 'isp.decodo.test',
      port: 10006,
      username: 'user-t00-secret',
      password: 'pass-t00-secret',
    });

    await browsers.saveProvider(w.id, admin.id, {
      ...decodo({ usernameEnc: undefined, passwordEnc: encrypt('new-t00-pass') }),
      id,
      protocol: 'socks5',
      host: 'gate.decodo.test',
    });
    const d2 = await browsers.getProfileForDispatch(w.id, profileId);
    expect(d2!.proxy).toEqual({
      protocol: 'socks5',
      host: 'gate.decodo.test',
      port: 10006,
      username: 'user-t00-secret',
      password: 'new-t00-pass',
    });
  });
});

describe('browsers.deleteProvider', () => {
  it('refuses while a profile uses it, then deletes it with its unused rows', async () => {
    const w = await ws();
    const admin = await w.member('Admin');
    const { id } = await browsers.saveProvider(w.id, admin.id, decodo());
    const { profileId } = await w.profileOn(null);
    await browsers.assignProviderPort(w.id, profileId, id, 10006, admin.id);
    await expect(browsers.deleteProvider(w.id, admin.id, id)).rejects.toThrow(/used by 1 profile/);

    // A custom proxy replaces the provider port; the port row goes, the provider can be deleted.
    await browsers.saveProxy(w.id, profileId, admin.id, {
      provider: 'Own server',
      protocol: 'http',
      host: 'own.test',
      port: 8080,
      sticky: true,
      region: null,
    });
    expect(await prisma.proxy.count({ where: { providerId: id } })).toBe(0);
    await browsers.deleteProvider(w.id, admin.id, id);
    expect(await prisma.proxyProvider.findUnique({ where: { id } })).toBeNull();
    expect(
      await prisma.auditEvent.count({ where: { action: 'settings.proxy_provider_deleted', targetId: id } }),
    ).toBe(1);
    const own = await prisma.browserProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { proxy: true },
    });
    expect(own.proxy).toMatchObject({ host: 'own.test', port: 8080, providerId: null });
  });
});

describe('accounts.startBrowserConnect with a provider port', () => {
  it('puts the new profile on the provider port; a taken port rolls the whole connect back', async () => {
    const w = await ws();
    const owner = await w.member('Owner Person');
    const { id } = await browsers.saveProvider(w.id, owner.id, decodo());
    const base = {
      workspaceId: w.id,
      roleLabel: 'founder' as const,
      disclosureLine: 'Disclosure: test',
      dailyPostLimit: 3,
      selfPromoMax: 10,
      fingerprint: {},
    };
    const r = await accounts.startBrowserConnect({
      ...base,
      ownerMemberId: owner.id,
      providerPort: { providerId: id, port: 10004 },
    });
    const prof = await prisma.browserProfile.findUniqueOrThrow({
      where: { id: r.profileId },
      include: { proxy: true },
    });
    expect(prof.proxy).toMatchObject({ providerId: id, port: 10004 });

    const second = await w.member('Second Person');
    await expect(
      accounts.startBrowserConnect({
        ...base,
        ownerMemberId: second.id,
        providerPort: { providerId: id, port: 10004 },
      }),
    ).rejects.toThrow(/already used by/);
    expect(await prisma.redditAccount.count({ where: { ownerMemberId: second.id } })).toBe(0);
  });
});
