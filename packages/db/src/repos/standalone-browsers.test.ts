/**
 * Integration: standalone browsers and account assignment (docs/plans/0003-standalone-browsers.md), against the
 * real Postgres, in a throwaway workspace.
 */
import { randomBytes } from 'node:crypto';
import { encrypt } from '@threadline/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { type TestWorkspace, testWorkspace, uniq } from '../testing/fixtures';
import * as accounts from './accounts';
import * as browsers from './browsers';

let ws: TestWorkspace;
let admin: { id: string };
let editor: { id: string };

beforeAll(async () => {
  if (!process.env.APP_ENCRYPTION_KEY) process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  ws = await testWorkspace();
  admin = await ws.member('Ada Admin');
  await prisma.workspaceMember.update({ where: { id: admin.id }, data: { role: 'admin' } });
  editor = await ws.member('Eve Editor');
});
afterAll(async () => {
  await ws.cleanup();
  await prisma.$disconnect();
});

const audits = (action: string, targetId: string) =>
  prisma.auditEvent.findMany({ where: { workspaceId: ws.id, action, targetId } });

const COOKIES = JSON.stringify([{ name: 'reddit_session', value: 'v', domain: '.reddit.com', secure: true }]);

describe('createBrowser', () => {
  it('creates a browser with no account, a fingerprint, a node, start tab and pending cookies', async () => {
    const node = await ws.node();
    const r = await browsers.createBrowser({
      workspaceId: ws.id,
      actorMemberId: editor.id,
      startUrl: 'www.reddit.com/r/test',
      cookiesEnc: encrypt(COOKIES),
    });
    expect(r.name).toBe('Eve · Chrome');
    expect(r.node?.id).toBe(node.id);
    const p = await prisma.browserProfile.findUniqueOrThrow({ where: { id: r.profileId } });
    expect(p.accountId).toBeNull();
    expect(p.createdByMemberId).toBe(editor.id);
    expect(p.startUrl).toBe('https://www.reddit.com/r/test');
    expect(p.cloakSeed).not.toBeNull();
    expect(p.cookiesVolume).toBe(`tl-profile-${p.id}`);
    expect(await audits('profile.created', p.id)).toHaveLength(1);
    expect(await audits('profile.node_assigned', p.id)).toHaveLength(1);

    const second = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: editor.id });
    expect(second.name).toBe('Eve · Chrome 2');
  });

  it('refuses a non-http start tab', async () => {
    await expect(
      browsers.createBrowser({
        workspaceId: ws.id,
        actorMemberId: editor.id,
        startUrl: 'javascript:alert(1)',
      }),
    ).rejects.toThrow(browsers.BrowserAssignError);
  });
});

describe('canControlProfile', () => {
  it('lets the creator control an account-less browser, and the owner once an account is in it', () => {
    const me = { id: 'm1', role: 'editor' };
    expect(browsers.canControlProfile(me, { account: null, createdByMemberId: 'm1' })).toBe(true);
    expect(browsers.canControlProfile(me, { account: null, createdByMemberId: 'm2' })).toBe(false);
    expect(
      browsers.canControlProfile(me, { account: { ownerMemberId: 'm2' }, createdByMemberId: 'm1' }),
    ).toBe(false);
    expect(browsers.canControlProfile({ id: 'x', role: 'admin' }, { account: null })).toBe(true);
  });
});

describe('assign / unassign', () => {
  it('assigns an account without a browser, refuses a second one, unassigns, and moves it', async () => {
    const a = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: admin.id });
    const b = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: admin.id });
    const { accountId, profileId: legacyProfile } = await ws.profileOn(null);
    // the fixture account already has a browser
    await expect(browsers.assignAccount(ws.id, a.profileId, accountId, admin.id)).rejects.toThrow(
      /Unassign it there first/,
    );
    await browsers.unassignAccount(ws.id, legacyProfile, admin.id);
    expect(await audits('profile.account_unassigned', legacyProfile)).toHaveLength(1);

    expect(await browsers.assignAccount(ws.id, a.profileId, accountId, admin.id)).toEqual({ changed: true });
    expect(await browsers.assignAccount(ws.id, a.profileId, accountId, admin.id)).toEqual({ changed: false });
    const other = await ws.profileOn(null);
    await browsers.unassignAccount(ws.id, other.profileId, admin.id);
    await expect(browsers.assignAccount(ws.id, a.profileId, other.accountId, admin.id)).rejects.toThrow(
      /already has an account/,
    );
    expect(await audits('profile.account_assigned', a.profileId)).toHaveLength(1);

    // move: unassign from a, assign to b
    await browsers.unassignAccount(ws.id, a.profileId, admin.id);
    await browsers.assignAccount(ws.id, b.profileId, accountId, admin.id);
    const moved = await prisma.browserProfile.findUniqueOrThrow({ where: { id: b.profileId } });
    expect(moved.accountId).toBe(accountId);
    const assignable = await browsers.listAssignableAccounts(ws.id);
    expect(assignable.map((x) => x.id)).toContain(other.accountId);
    expect(assignable.map((x) => x.id)).not.toContain(accountId);
  });

  it('refuses while someone has control of the browser', async () => {
    const { accountId, profileId } = await ws.profileOn(null);
    await browsers.startHumanSession({
      workspaceId: ws.id,
      profileId,
      memberId: admin.id,
      memberName: 'Ada',
      reason: 'test',
    });
    await expect(browsers.unassignAccount(ws.id, profileId, admin.id)).rejects.toThrow(/has control/);
    expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } })).accountId).toBe(
      accountId,
    );
  });

  it('keeps the browser when its account is deleted', async () => {
    const { accountId, profileId } = await ws.profileOn(null);
    await prisma.redditAccount.update({ where: { id: accountId }, data: { health: 'blocked' } });
    await browsers.unassignAccount(ws.id, profileId, admin.id);
    const blockedTo = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: admin.id });
    await expect(browsers.assignAccount(ws.id, blockedTo.profileId, accountId, admin.id)).rejects.toThrow(
      /disconnected/,
    );
  });
});

describe('addBrowserAccount + getSignInForDispatch', () => {
  it('creates an unidentified account by name with encrypted credentials, in the browser', async () => {
    const b = await browsers.createBrowser({
      workspaceId: ws.id,
      actorMemberId: editor.id,
      cookiesEnc: encrypt(COOKIES),
    });
    const name = `tl_${randomBytes(3).toString('hex')}`;
    const { accountId } = await accounts.addBrowserAccount({
      workspaceId: ws.id,
      profileId: b.profileId,
      actorMemberId: editor.id,
      username: `u/${name}`,
      loginPasswordEnc: encrypt('KDZA%#US#25'),
      totpSecretEnc: encrypt('GDKI AX2L WCTA C3JC'),
    });
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc).toMatchObject({
      username: name,
      authMode: 'browser',
      identifiedAt: null,
      ownerMemberId: editor.id,
    });
    expect(acc.redditId).toBe(`pending:${accountId}`);
    expect(acc.loginPasswordEnc).not.toContain('KDZA');
    expect(await audits('account.credentials_updated', accountId)).toHaveLength(1);
    const meta = JSON.stringify((await audits('account.credentials_updated', accountId))[0]!.meta);
    expect(meta).not.toContain('KDZA');

    await expect(
      accounts.addBrowserAccount({
        workspaceId: ws.id,
        profileId: (await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: editor.id })).profileId,
        actorMemberId: editor.id,
        username: name.toUpperCase(),
      }),
    ).rejects.toThrow(/already in this workspace/);

    const d = await browsers.getSignInForDispatch(ws.id, b.profileId);
    expect(d).toMatchObject({
      startUrl: browsers.DEFAULT_START_URL,
      credentials: { username: name, password: 'KDZA%#US#25', totpSecret: 'GDKI AX2L WCTA C3JC' },
      account: { id: accountId, identifiedAt: null },
    });
    expect(d!.cookies).toHaveLength(1);

    // cookies pasted while the job ran stay pending
    await browsers.markCookiesImported(ws.id, b.profileId, 'not-what-was-sent');
    expect(
      (await prisma.browserProfile.findUniqueOrThrow({ where: { id: b.profileId } })).cookiesEnc,
    ).not.toBeNull();
    await browsers.markCookiesImported(ws.id, b.profileId, d!.cookiesEnc!);
    const after = await prisma.browserProfile.findUniqueOrThrow({ where: { id: b.profileId } });
    expect(after.cookiesEnc).toBeNull();
    expect(after.cookiesImportedAt).not.toBeNull();

    // signed in as someone else → refused; as the same name (any case) → identified
    await expect(
      accounts.completeBrowserIdentity(ws.id, accountId, { name: 'someone_else', id: 'abc1' }),
    ).rejects.toThrow(accounts.AccountConflictError);
    const ok = await accounts.completeBrowserIdentity(ws.id, accountId, {
      name: name.toUpperCase(),
      id: uniq('x')
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 12),
    });
    expect(ok.changed).toBe(true);

    // a connect-flow resume never picks up an account added by name
    expect(await accounts.findPendingByOwner(ws.id, editor.id)).toBeNull();
  });

  it('sends no credentials for an account-less browser or a pending placeholder', async () => {
    const b = await browsers.createBrowser({
      workspaceId: ws.id,
      actorMemberId: editor.id,
      startUrl: 'https://old.reddit.com',
    });
    expect(await browsers.getSignInForDispatch(ws.id, b.profileId)).toMatchObject({
      startUrl: 'https://old.reddit.com/',
      account: null,
      credentials: null,
      cookies: null,
    });
  });

  it('setCredentials changes and clears, auditing only which fields changed', async () => {
    const b = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: editor.id });
    const { accountId } = await accounts.addBrowserAccount({
      workspaceId: ws.id,
      profileId: b.profileId,
      actorMemberId: editor.id,
      username: `tl_${randomBytes(3).toString('hex')}`,
    });
    expect(await accounts.setCredentials(ws.id, accountId, editor.id, {})).toEqual({ changed: false });
    await accounts.setCredentials(ws.id, accountId, editor.id, { loginPasswordEnc: encrypt('pw') });
    await accounts.setCredentials(ws.id, accountId, editor.id, {
      loginPasswordEnc: null,
      totpSecretEnc: null,
    });
    const rows = await audits('account.credentials_updated', accountId);
    expect(rows.map((r) => r.meta)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ password: 'set' }),
        expect.objectContaining({ password: 'cleared', totp: 'cleared' }),
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe('updateBrowserSettings', () => {
  it('records which settings changed, never cookie values', async () => {
    const b = await browsers.createBrowser({ workspaceId: ws.id, actorMemberId: editor.id });
    const enc = encrypt(COOKIES);
    const r = await browsers.updateBrowserSettings(ws.id, b.profileId, editor.id, {
      name: 'Work',
      startUrl: 'https://www.reddit.com/r/saas',
      cookiesEnc: enc,
    });
    expect(r.changed).toEqual(['name', 'startUrl', 'cookies']);
    const [row] = await audits('profile.settings_updated', b.profileId);
    expect(JSON.stringify(row!.meta)).not.toContain(enc);
    expect(
      (await browsers.updateBrowserSettings(ws.id, b.profileId, editor.id, { name: 'Work' })).changed,
    ).toEqual([]);
  });
});
