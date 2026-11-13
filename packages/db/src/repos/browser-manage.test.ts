/** Integration: the profile list of the Browsers screen (docs/plans/0004-browser-parity.md, phase 1). */
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { testWorkspace } from '../testing/fixtures';
import * as browsers from './browsers';

afterAll(() => prisma.$disconnect());

const audits = (workspaceId: string, action: string) =>
  prisma.auditEvent.findMany({ where: { workspaceId, action }, orderBy: { at: 'asc' } });

describe('browsers.searchProfiles', () => {
  it('filters by text, number, group, tag and status, sorts and pages', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const me = await ws.member('Ana Lima');
      const g = await browsers.createGroup(ws.id, me.id, '  Shop   accounts ');
      expect(g.name).toBe('Shop accounts');
      const hot = await browsers.createTag(ws.id, me.id, 'warm', 'amber');
      const a = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: me.id, name: 'Alpha' });
      const b = await browsers.createBrowser({
        workspaceId: ws.id,
        actorMemberId: me.id,
        name: 'Bravo',
        groupId: g.id,
        tagIds: [hot.id],
        notes: 'bought in March',
      });
      const c = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: me.id, name: 'Charlie' });
      await browsers.createBrowser({ workspaceId: other.id, actorMemberId: (await other.member()).id });
      await browsers.setStatus(ws.id, c.profileId, 'running');

      const names = async (f: browsers.ProfileFilter) =>
        (await browsers.searchProfiles(ws.id, f)).rows.map((r) => r.name);
      expect(await names({})).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect((await browsers.searchProfiles(ws.id)).rows.map((r) => r.serial)).toEqual([1, 2, 3]);
      expect(await names({ q: 'brav' })).toEqual(['Bravo']);
      expect(await names({ q: 'march' })).toEqual(['Bravo']);
      expect(await names({ q: '#3' })).toEqual(['Charlie']);
      expect(await names({ groupId: g.id })).toEqual(['Bravo']);
      expect(await names({ groupId: 'none' })).toEqual(['Alpha', 'Charlie']);
      expect(await names({ tagId: hot.id })).toEqual(['Bravo']);
      expect(await names({ status: 'running' })).toEqual(['Charlie']);
      expect(await names({ status: 'nonsense' })).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect(await names({ sort: 'name', dir: 'desc' })).toEqual(['Charlie', 'Bravo', 'Alpha']);

      const page2 = await browsers.searchProfiles(ws.id, { pageSize: 2, page: 2 });
      expect(page2).toMatchObject({ total: 3, pages: 2, page: 2 });
      expect(page2.rows.map((r) => r.name)).toEqual(['Charlie']);
      // A page past the end shows the last page instead of nothing.
      expect((await browsers.searchProfiles(ws.id, { pageSize: 2, page: 9 })).page).toBe(2);

      expect(await browsers.listGroups(ws.id)).toEqual([
        { id: g.id, name: 'Shop accounts', profileCount: 1, memberIds: [] },
      ]);
      expect(await browsers.listTags(ws.id)).toEqual([
        { id: hot.id, name: 'warm', color: 'amber', profileCount: 1 },
      ]);
      await expect(browsers.createGroup(ws.id, me.id, 'shop accounts ')).resolves.toBeTruthy();
      await expect(browsers.createGroup(ws.id, me.id, 'Shop accounts')).rejects.toThrow(/already exists/);
      await expect(browsers.createTag(ws.id, me.id, 'x', 'pink')).rejects.toThrow(/color/);
      expect(a.profileId).not.toBe(b.profileId);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});

describe('browsers.updateProfileMeta', () => {
  it('changes name, notes, group and tags, audits only real changes, and stays in the workspace', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const me = await ws.member();
      const g = await browsers.createGroup(ws.id, me.id, 'G1');
      const t1 = await browsers.createTag(ws.id, me.id, 't1');
      const t2 = await browsers.createTag(ws.id, me.id, 't2');
      const foreignTag = await browsers.createTag(other.id, (await other.member()).id, 'far');
      const { profileId } = await browsers.createBrowser({
        workspaceId: ws.id,
        actorMemberId: me.id,
        name: 'One',
      });

      expect(
        await browsers.updateProfileMeta(ws.id, profileId, me.id, {
          name: ' Uno ',
          notes: 'hello',
          groupId: g.id,
          tagIds: [t1.id],
        }),
      ).toEqual({ changed: ['name', 'notes', 'group', 'tags'] });
      expect(
        await browsers.updateProfileMeta(ws.id, profileId, me.id, { name: 'Uno', notes: 'hello' }),
      ).toEqual({
        changed: [],
      });
      await browsers.updateProfileMeta(ws.id, profileId, me.id, {
        addTagIds: [t2.id],
        removeTagIds: [t1.id],
      });
      const row = await browsers.getProfile(ws.id, profileId);
      expect(row).toMatchObject({ name: 'Uno', notes: 'hello', group: { name: 'G1' } });
      expect(row?.tags.map((t) => t.name)).toEqual(['t2']);

      await expect(
        browsers.updateProfileMeta(ws.id, profileId, me.id, { addTagIds: [foreignTag.id] }),
      ).rejects.toThrow(/Tag not found/);
      await expect(browsers.updateProfileMeta(other.id, profileId, me.id, { name: 'x' })).rejects.toThrow(
        /Browser not found/,
      );
      expect(await audits(ws.id, 'profile.updated')).toHaveLength(2);

      // Deleting the group or the tag leaves the browser, ungrouped and untagged.
      await browsers.deleteGroup(ws.id, me.id, g.id);
      await browsers.deleteTag(ws.id, me.id, t2.id);
      const after = await browsers.getProfile(ws.id, profileId);
      expect(after?.group).toBeNull();
      expect(after?.tags).toEqual([]);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});

describe('browsers.cloneProfile', () => {
  it('copies the settings, never the account, cookies or seed', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member('Ana Lima');
      const g = await browsers.createGroup(ws.id, me.id, 'G');
      const tag = await browsers.createTag(ws.id, me.id, 't');
      const px = await prisma.proxy.create({
        data: { workspaceId: ws.id, provider: 'Own', protocol: 'http', host: 'h.test', port: 1 },
      });
      const src = await browsers.createBrowser({
        workspaceId: ws.id,
        actorMemberId: me.id,
        name: 'Source',
        fingerprint: { os: 'macOS 15', screen: '1440x900', tz: 'Europe/Lisbon', locale: 'pt-PT' },
        proxyId: px.id,
        startUrl: 'https://www.reddit.com/r/startups/',
        cookiesEnc: 'enc:cookies',
        groupId: g.id,
        tagIds: [tag.id],
        notes: 'n',
      });
      // An older browser with the macOS persona: its clone is a new browser and gets today's persona.
      await prisma.browserProfile.update({
        where: { id: src.profileId },
        data: { cloakGpu: 'nvidia', cloakPersona: 'macos' },
      });

      const made = await browsers.cloneProfile(ws.id, src.profileId, me.id);
      const [s, c] = await Promise.all([
        prisma.browserProfile.findUniqueOrThrow({ where: { id: src.profileId }, include: { tags: true } }),
        prisma.browserProfile.findUniqueOrThrow({ where: { id: made.profileId }, include: { tags: true } }),
      ]);
      expect(c).toMatchObject({
        name: 'Source (copy)',
        serial: 2,
        proxyId: px.id,
        startUrl: s.startUrl,
        groupId: g.id,
        notes: 'n',
        cloakPersona: 'windows',
        cloakGpu: 'nvidia',
        accountId: null,
        cookiesEnc: null,
        cookiesVolume: `tl-profile-${made.profileId}`,
      });
      expect(c.tags.map((t) => t.id)).toEqual([tag.id]);
      expect(c.cloakSeed).not.toBeNull();
      expect(c.cloakSeed).not.toBe(s.cloakSeed);
      const fp = c.fingerprint as browsers.Fingerprint;
      expect(fp).toMatchObject({ os: 'macOS 15', screen: '1440x900', tz: 'Europe/Lisbon', locale: 'pt-PT' });
      expect(fp.cloakSalt).not.toBe((s.fingerprint as browsers.Fingerprint).cloakSalt);
      expect(await audits(ws.id, 'profile.cloned')).toHaveLength(1);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('browsers trash: trashProfile / restoreProfile / purgeProfile', () => {
  it('hides a trashed browser from every read and from dispatch, and restores it whole', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const node = await ws.node();
      const { profileId, accountId } = await ws.profileOn(node.id);
      await browsers.setStatus(ws.id, profileId, 'running');

      expect(await browsers.trashProfile(ws.id, profileId, me.id)).toMatchObject({ nodeId: node.id });
      expect(await browsers.getProfile(ws.id, profileId)).toBeNull();
      expect(await browsers.listProfiles(ws.id)).toEqual([]);
      expect((await browsers.searchProfiles(ws.id)).total).toBe(0);
      expect((await browsers.searchProfiles(ws.id, { trashed: true })).rows.map((r) => r.id)).toEqual([
        profileId,
      ]);
      expect(await browsers.getProfileForDispatch(ws.id, profileId)).toBeNull();
      expect(await browsers.getSignInForDispatch(ws.id, profileId)).toBeNull();
      // Only stop / remove may still load it.
      expect(await browsers.getProfileForDispatch(ws.id, profileId, { includeTrashed: true })).toMatchObject({
        trashed: true,
      });
      const trashed = await browsers.getProfile(ws.id, profileId, { trashed: true });
      expect(trashed).toMatchObject({ accountId, status: 'idle', deletedByMemberId: me.id });
      await expect(browsers.trashProfile(ws.id, profileId, me.id)).rejects.toThrow(/not found/);
      await expect(browsers.updateProfileMeta(ws.id, profileId, me.id, { name: 'x' })).rejects.toThrow(
        /not found/,
      );

      await browsers.restoreProfile(ws.id, profileId, me.id);
      expect(await browsers.getProfile(ws.id, profileId)).toMatchObject({ accountId, nodeId: node.id });
      expect(await browsers.getProfileForDispatch(ws.id, profileId)).toMatchObject({ trashed: false });
      await expect(browsers.restoreProfile(ws.id, profileId, me.id)).rejects.toThrow(/not found/);
      expect(await audits(ws.id, 'profile.trashed')).toHaveLength(1);
      expect(await audits(ws.id, 'profile.restored')).toHaveLength(1);
    } finally {
      await ws.cleanup();
    }
  });

  it('refuses while a person controls the browser; ends an agent session', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const { profileId } = await ws.profileOn(null);
      const human = await prisma.browserSession.create({
        data: { workspaceId: ws.id, profileId, driver: 'human', startedByMemberId: me.id },
      });
      await expect(browsers.trashProfile(ws.id, profileId, me.id)).rejects.toThrow(/Hand it back/);
      await prisma.browserSession.update({ where: { id: human.id }, data: { endedAt: new Date() } });
      const agent = await prisma.browserSession.create({
        data: { workspaceId: ws.id, profileId, driver: 'agent' },
      });
      await browsers.trashProfile(ws.id, profileId, me.id);
      expect(
        (await prisma.browserSession.findUniqueOrThrow({ where: { id: agent.id } })).endedAt,
      ).not.toBeNull();
    } finally {
      await ws.cleanup();
    }
  });

  it('purge keeps a tombstone (audit rows are append-only) and frees the account', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const node = await ws.node();
      const { profileId, accountId } = await ws.profileOn(node.id);
      await browsers.startHumanSession({
        workspaceId: ws.id,
        profileId,
        memberId: (await prisma.redditAccount.findUniqueOrThrow({ where: { id: accountId } })).ownerMemberId,
        memberName: 'Owner',
        reason: 'check',
      });
      await prisma.browserSession.updateMany({ where: { profileId }, data: { endedAt: new Date() } });

      // Live browsers are never purged.
      expect(await browsers.purgeProfile(ws.id, profileId, me.id)).toEqual({ purged: false });
      await browsers.trashProfile(ws.id, profileId, me.id);
      expect(await browsers.trashedProfileNode(ws.id, profileId)).toMatchObject({
        node: { name: node.name },
      });
      expect(await browsers.purgeProfile(ws.id, profileId, null)).toEqual({ purged: true });
      expect(await browsers.purgeProfile(ws.id, profileId, null)).toEqual({ purged: false });

      const row = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
      expect(row).toMatchObject({ accountId: null, nodeId: null, proxyId: null, cookiesEnc: null });
      expect(row.purgedAt).not.toBeNull();
      expect((await browsers.searchProfiles(ws.id, { trashed: true })).total).toBe(0);
      expect(await browsers.getProfile(ws.id, profileId, { trashed: true })).toBeNull();
      expect(await browsers.getProfileForDispatch(ws.id, profileId, { includeTrashed: true })).toBeNull();
      await expect(browsers.restoreProfile(ws.id, profileId, me.id)).rejects.toThrow(/not found/);
      // The account can go into another browser again.
      expect((await browsers.listAssignableAccounts(ws.id)).map((a) => a.id)).toContain(accountId);
      // The session and its audit rows are still there.
      expect(await prisma.browserSession.count({ where: { profileId } })).toBeGreaterThan(0);
    } finally {
      await ws.cleanup();
    }
  });

  it('listPurgeDue returns only browsers trashed more than 30 days ago', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const old = (await ws.profileOn(null)).profileId;
      const fresh = (await ws.profileOn(null)).profileId;
      await browsers.trashProfile(ws.id, old, me.id);
      await browsers.trashProfile(ws.id, fresh, me.id);
      await prisma.browserProfile.update({
        where: { id: old },
        data: { deletedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) },
      });
      const due = (await browsers.listPurgeDue()).filter((p) => p.workspaceId === ws.id).map((p) => p.id);
      expect(due).toEqual([old]);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('browsers.resetProfileData', () => {
  it('gives the browser a new seed with the same GPU and the persona of a new browser', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const { profileId } = await browsers.createBrowser({
        workspaceId: ws.id,
        actorMemberId: me.id,
        fingerprint: { os: 'macOS 15' },
      });
      await prisma.browserProfile.update({
        where: { id: profileId },
        data: { cloakGpu: 'amd', cloakPersona: 'macos', cookiesImportedAt: new Date() },
      });
      const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
      expect(await browsers.resetProfileData(ws.id, profileId, me.id)).toEqual({ reset: true });
      const after = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
      expect(after.cloakSeed).not.toBeNull();
      expect(after.cloakSeed).not.toBe(before.cloakSeed);
      expect(after).toMatchObject({ cloakPersona: 'windows', cloakGpu: 'amd', cookiesImportedAt: null });
      expect(await audits(ws.id, 'profile.data_reset')).toHaveLength(1);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('browsers.updateFingerprint / dispatch', () => {
  const settings = {
    screen: '1600x900',
    tzMode: 'proxy' as const,
    tz: 'America/New_York',
    localeMode: 'proxy' as const,
    locale: 'en-US',
    cpu: 8,
    memoryGb: 4,
    webrtc: 'replace' as const,
    noise: false,
  };

  it('stores the settings, and a start carries them with the proxy place resolved', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const { profileId } = await browsers.createBrowser({
        workspaceId: ws.id,
        actorMemberId: me.id,
        fingerprint: { os: 'Windows 11', screen: '1920x1080', tz: 'America/New_York', locale: 'en-US' },
      });
      // Untouched profile: nothing optional is sent, exactly as before plan 0004.
      const plain = await browsers.getProfileForDispatch(ws.id, profileId);
      expect(plain).toMatchObject({
        tz: 'America/New_York',
        locale: 'en-US',
        screen: '1920x1080',
        device: {},
      });

      const px = await prisma.proxy.create({
        data: {
          workspaceId: ws.id,
          provider: 'Own',
          protocol: 'http',
          host: 'h.test',
          port: 1,
          lastTest: { ok: true, ip: '203.0.113.9', timeZone: 'Europe/Lisbon', country: 'PT' },
        },
      });
      await browsers.attachProxy(ws.id, profileId, px.id, me.id);
      const r = await browsers.updateFingerprint(ws.id, profileId, me.id, settings);
      expect(r.changed.sort()).toEqual(
        ['cpu', 'localeMode', 'memoryGb', 'noise', 'screen', 'tzMode', 'webrtc'].sort(),
      );
      expect(await browsers.updateFingerprint(ws.id, profileId, me.id, settings)).toEqual({ changed: [] });

      const d = await browsers.getProfileForDispatch(ws.id, profileId);
      expect(d).toMatchObject({
        tz: 'Europe/Lisbon',
        locale: 'pt-PT',
        screen: '1600x900',
        device: { cpu: 8, memoryGb: 4, noise: false, webrtc: { mode: 'replace', ip: '203.0.113.9' } },
      });
      // The seed and what it was derived from are untouched.
      const row = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
      expect((row.fingerprint as browsers.Fingerprint).cloakSalt).toBeTruthy();
      expect(await audits(ws.id, 'profile.fingerprint_updated')).toHaveLength(1);

      // "From seed" again removes the override instead of storing null.
      await browsers.updateFingerprint(ws.id, profileId, me.id, { ...settings, cpu: null, memoryGb: null });
      expect((await browsers.getProfileForDispatch(ws.id, profileId))?.device).toEqual({
        noise: false,
        webrtc: { mode: 'replace', ip: '203.0.113.9' },
      });
    } finally {
      await ws.cleanup();
    }
  });

  it('never lets WebRTC be real behind a proxy', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const { profileId } = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: me.id });
      const real = {
        ...settings,
        tzMode: 'custom' as const,
        localeMode: 'custom' as const,
        webrtc: 'real' as const,
      };
      // No proxy: allowed.
      await browsers.updateFingerprint(ws.id, profileId, me.id, real);
      expect((await browsers.getProfileForDispatch(ws.id, profileId))?.device.webrtc).toEqual({
        mode: 'real',
      });
      // A proxy attached afterwards: dispatch falls back to the safe mode on its own.
      const px = await prisma.proxy.create({
        data: { workspaceId: ws.id, provider: 'Own', protocol: 'socks5', host: 'h.test', port: 1 },
      });
      await browsers.attachProxy(ws.id, profileId, px.id, me.id);
      expect((await browsers.getProfileForDispatch(ws.id, profileId))?.device.webrtc).toEqual({
        mode: 'disable_udp',
      });
      // And the form refuses to save it.
      await expect(browsers.updateFingerprint(ws.id, profileId, me.id, { ...real, cpu: 2 })).rejects.toThrow(
        /own address/,
      );
    } finally {
      await ws.cleanup();
    }
  });

  it('a GPU picked for the next fingerprint applies at the data reset', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const { profileId } = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: me.id });
      await expect(browsers.setNextGpu(ws.id, profileId, 'voodoo')).rejects.toThrow(/GPU/);
      await browsers.setNextGpu(ws.id, profileId, 'nvidia');
      const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
      expect(before.cloakGpu).toBe('intel'); // locked until the reset
      await browsers.resetProfileData(ws.id, profileId, me.id);
      const after = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
      expect(after.cloakGpu).toBe('nvidia');
      expect((after.fingerprint as browsers.Fingerprint).nextGpu).toBeUndefined();
    } finally {
      await ws.cleanup();
    }
  });
});

describe('extra start tabs (plan 0004 phase 4)', () => {
  it('stores up to nine http(s) addresses, dedupes, and sends them with the sign-in', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const { profileId } = await browsers.createBrowser({
        workspaceId: ws.id,
        actorMemberId: me.id,
        startUrl: 'https://www.reddit.com/r/startups/',
        extraStartUrls: [
          'https://mail.example.com',
          ' https://mail.example.com/ ',
          'https://shop.example.com/a',
        ],
      });
      expect((await browsers.getSignInForDispatch(ws.id, profileId))?.extraStartUrls).toEqual([
        'https://mail.example.com/',
        'https://shop.example.com/a',
      ]);
      expect(
        await browsers.updateBrowserSettings(ws.id, profileId, me.id, {
          extraStartUrls: ['https://one.example/'],
        }),
      ).toEqual({ changed: ['extraStartUrls'] });
      expect(
        await browsers.updateBrowserSettings(ws.id, profileId, me.id, {
          extraStartUrls: ['https://one.example/'],
        }),
      ).toEqual({ changed: [] });
      await expect(
        browsers.updateBrowserSettings(ws.id, profileId, me.id, { extraStartUrls: ['javascript:alert(1)'] }),
      ).rejects.toThrow(/http/);
      const ten = Array.from({ length: 10 }, (_, i) => `https://t${i}.example/`);
      await expect(
        browsers.updateBrowserSettings(ws.id, profileId, me.id, { extraStartUrls: ten }),
      ).rejects.toThrow(/At most 9/);
      // A clone opens the same tabs.
      const copy = await browsers.cloneProfile(ws.id, profileId, me.id);
      expect((await browsers.getSignInForDispatch(ws.id, copy.profileId))?.extraStartUrls).toEqual([
        'https://one.example/',
      ]);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('group access (plan 0004 phase 5)', () => {
  it('lets a member manage a group’s browsers without ever controlling them', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const admin = await ws.member('Admin');
      const helper = await ws.member('Helper');
      const outsider = await ws.member('Outsider');
      const foreign = await other.member();
      const g = await browsers.createGroup(ws.id, admin.id, 'Shops');
      const { profileId } = await ws.profileOn(null); // holds another member's account
      await browsers.updateProfileMeta(ws.id, profileId, admin.id, { groupId: g.id });
      const as = (m: { id: string }, role = 'editor') => ({ id: m.id, role });
      const load = async () => (await browsers.getProfile(ws.id, profileId))!;

      expect(browsers.canManageProfile(as(helper), await load())).toBe(false);
      expect(await browsers.setGroupMembers(ws.id, admin.id, g.id, [helper.id])).toEqual({
        added: 1,
        removed: 0,
      });
      expect(await browsers.setGroupMembers(ws.id, admin.id, g.id, [helper.id])).toEqual({
        added: 0,
        removed: 0,
      });
      const row = await load();
      expect(browsers.canManageProfile(as(helper), row)).toBe(true);
      // Managing is not controlling: no take-over, cookies, account or delete.
      expect(browsers.canControlProfile(as(helper), row)).toBe(false);
      expect(browsers.canManageProfile(as(outsider), row)).toBe(false);
      // A viewer changes nothing, even with access.
      expect(browsers.canManageProfile(as(helper, 'viewer'), row)).toBe(false);
      expect((await browsers.listGroups(ws.id))[0]?.memberIds).toEqual([helper.id]);

      await expect(browsers.setGroupMembers(ws.id, admin.id, g.id, [foreign.id])).rejects.toThrow(
        /Member not found/,
      );
      await expect(browsers.setGroupMembers(other.id, foreign.id, g.id, [])).rejects.toThrow(
        /Group not found/,
      );

      // Out of the group, or access taken away: back to nothing.
      await browsers.updateProfileMeta(ws.id, profileId, admin.id, { groupId: null });
      expect(browsers.canManageProfile(as(helper), await load())).toBe(false);
      await browsers.updateProfileMeta(ws.id, profileId, admin.id, { groupId: g.id });
      expect(await browsers.setGroupMembers(ws.id, admin.id, g.id, [])).toEqual({ added: 0, removed: 1 });
      expect(browsers.canManageProfile(as(helper), await load())).toBe(false);
      expect(await audits(ws.id, 'browser_group.access_changed')).toHaveLength(2);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});
