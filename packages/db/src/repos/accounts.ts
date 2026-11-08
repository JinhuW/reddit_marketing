import { Prisma } from '@prisma/client';
// Repository functions for the Accounts screen (docs/PLAN.md §7 row 9).
// Browser-mode connect (startBrowserConnect / completeBrowserIdentity): docs/plans/0002-browser-mode.md.
import { assertOneAccountPerMember } from '@threadline/agents';
import type { AccountAuthMode, AccountRoleLabel } from '@threadline/shared';
import { prisma } from '../client';
import { writeAudit } from './audit';
import { attachProxyTx, ensureCloakFingerprintTx } from './browsers';
import { pickForProfile } from './nodes';

/**
 * True once the account's Reddit identity is known (OAuth callback, or `profile.whoami` in browser mode).
 * An account that is not identified is never publishable and never dispatched for actions.
 */
export function isIdentified(account: { identifiedAt: Date | string | null | undefined }): boolean {
  return account.identifiedAt != null;
}

const DAY = 86_400_000;

/** Posting activity for an account: items posted today, and over the last 7 days (all / promotional). */
export async function activity(accountId: string, now = new Date()) {
  const since = new Date(now.getTime() - 7 * DAY);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const [today, week, promo] = await Promise.all([
    prisma.draft.count({ where: { accountId, status: 'posted', postedAt: { gte: startOfDay } } }),
    prisma.draft.count({ where: { accountId, status: 'posted', postedAt: { gte: since } } }),
    prisma.draft.count({
      where: { accountId, status: 'posted', postedAt: { gte: since }, promotional: true },
    }),
  ]);
  return { today, week, promo };
}

/** "3y 2m", "11m", "12d" */
export function accountAge(createdAt: Date | null, now = new Date()): string {
  if (!createdAt) return '—';
  const months =
    (now.getFullYear() - createdAt.getFullYear()) * 12 +
    (now.getMonth() - createdAt.getMonth()) -
    (now.getDate() < createdAt.getDate() ? 1 : 0);
  if (months < 1) return `${Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY))}d`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y ? `${y}y ${m}m` : `${m}m`;
}

export async function listCards(workspaceId: string, now = new Date()) {
  const accounts = await prisma.redditAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    include: {
      owner: { include: { user: { select: { name: true, email: true } } } },
      browserProfile: { select: { id: true } },
    },
  });
  return Promise.all(
    accounts.map(async (a) => {
      const act = await activity(a.id, now);
      return {
        id: a.id,
        username: a.username,
        ownerName: a.owner.user.name ?? a.owner.user.email,
        ownerMemberId: a.ownerMemberId,
        roleLabel: a.roleLabel,
        disclosureLine: a.disclosureLine,
        health: a.health,
        authMode: a.authMode as AccountAuthMode,
        identified: isIdentified(a),
        /** OAuth: a stored token. Browser mode: the identity was read from the signed-in profile. */
        connected: a.authMode === 'browser' ? isIdentified(a) : Boolean(a.oauthTokenEnc),
        karma: a.karma,
        age: accountAge(a.accountCreatedAt, now),
        postsThisWeek: act.week,
        postedToday: act.today,
        dailyPostLimit: a.dailyPostLimit,
        selfPromoPct: act.week ? Math.round((act.promo / act.week) * 100) : 0,
        selfPromoMax: a.selfPromoMax,
        browserProfileId: a.browserProfile?.id ?? null,
      };
    }),
  );
}
export type AccountCard = Awaited<ReturnType<typeof listCards>>[number];

export function findByOwner(ownerMemberId: string) {
  return prisma.redditAccount.findUnique({ where: { ownerMemberId }, select: { id: true, username: true } });
}

export interface ConnectInput {
  workspaceId: string;
  ownerMemberId: string;
  username: string;
  redditId: string;
  karma: number;
  accountCreatedAt: Date | null;
  oauthTokenEnc: string;
  scopes: string[];
  roleLabel: AccountRoleLabel;
  disclosureLine: string;
  dailyPostLimit: number;
  selfPromoMax: number;
  fingerprint: Prisma.InputJsonValue;
}

/** Creates RedditAccount + its BrowserProfile + AuditEvent in one transaction. */
export async function connect(input: ConnectInput) {
  return prisma.$transaction(async (tx) => {
    const account = await tx.redditAccount.create({
      data: {
        workspaceId: input.workspaceId,
        ownerMemberId: input.ownerMemberId,
        username: input.username,
        redditId: input.redditId,
        karma: input.karma,
        accountCreatedAt: input.accountCreatedAt,
        oauthTokenEnc: input.oauthTokenEnc,
        scopes: input.scopes,
        roleLabel: input.roleLabel,
        disclosureLine: input.disclosureLine,
        dailyPostLimit: input.dailyPostLimit,
        selfPromoMax: input.selfPromoMax,
        authMode: 'oauth',
        // the OAuth callback read the identity
        identifiedAt: new Date(),
      },
    });
    const owner = await tx.workspaceMember.findUniqueOrThrow({
      where: { id: input.ownerMemberId },
      include: { user: true },
    });
    await tx.browserProfile.create({
      data: {
        workspaceId: input.workspaceId,
        accountId: account.id,
        name: profileName(owner.user.name ?? input.username),
        fingerprint: input.fingerprint,
        cookiesVolume: `tl-profile-${account.id}`,
      },
    });
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: input.ownerMemberId,
        action: 'account.connected',
        targetType: 'RedditAccount',
        targetId: account.id,
        accountId: account.id,
        meta: { username: input.username, roleLabel: input.roleLabel, scopes: input.scopes },
      },
      tx,
    );
    return account;
  });
}

/** "Jane Doe" → "Jane · Chrome" (one profile per account, named after its owner). */
function profileName(ownerName: string): string {
  return `${ownerName.split(' ')[0]} · Chrome`;
}

/** The account refused: another account in the workspace already has this Reddit identity, or it changed. */
export class AccountConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountConflictError';
  }
}

export interface StartBrowserConnectInput {
  workspaceId: string;
  ownerMemberId: string;
  roleLabel: AccountRoleLabel;
  disclosureLine: string;
  dailyPostLimit: number;
  selfPromoMax: number;
  /** the owner's device as captured in the connect flow ({ os, screen, tz, locale, … }) */
  fingerprint: Prisma.InputJsonValue;
  /** an existing proxy of the workspace to attach to the new profile */
  proxyId?: string | null;
  /** who pressed the button; defaults to the owner */
  actorMemberId?: string;
}

export interface StartBrowserConnectResult {
  accountId: string;
  username: string;
  profileId: string;
  /** null when no online node had room: the profile waits for an assignment on the Browsers screen */
  node: { id: string; name: string } | null;
}

/**
 * Browser mode, step 1 (one transaction): a pending RedditAccount (`authMode` browser, `username`
 * `pending-<short id>`, `redditId` `pending:<account id>`, `identifiedAt` null, so it can never post), its
 * BrowserProfile with a CloakBrowser fingerprint, a node (least-loaded online node with room) and the
 * optional proxy. Audit: `account.connect_started`, `profile.fingerprint_assigned`, and
 * `profile.node_assigned` / `profile.proxy_updated` when a node / proxy was set.
 * Refuses when the owner already owns an account (one account per person).
 */
export async function startBrowserConnect(
  input: StartBrowserConnectInput,
): Promise<StartBrowserConnectResult> {
  const actor = input.actorMemberId ?? input.ownerMemberId;
  return prisma.$transaction(async (tx) => {
    const owner = await tx.workspaceMember.findFirst({
      where: { id: input.ownerMemberId, workspaceId: input.workspaceId },
      include: {
        user: { select: { name: true, email: true } },
        ownedAccount: { select: { username: true } },
      },
    });
    if (!owner) throw new Error('Owner is not a member of this workspace');
    assertOneAccountPerMember(owner.ownedAccount);
    if (input.proxyId) {
      const px = await tx.proxy.findFirst({
        where: { workspaceId: input.workspaceId, id: input.proxyId },
        select: { id: true },
      });
      if (!px) throw new Error('Proxy not found');
    }

    // The final username/redditId derive from the generated id: create with unique placeholders, then set them.
    const tmp = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const created = await tx.redditAccount.create({
      data: {
        workspaceId: input.workspaceId,
        ownerMemberId: input.ownerMemberId,
        username: tmp,
        redditId: `pending:${tmp}`,
        authMode: 'browser',
        identifiedAt: null,
        scopes: [],
        roleLabel: input.roleLabel,
        disclosureLine: input.disclosureLine,
        dailyPostLimit: input.dailyPostLimit,
        selfPromoMax: input.selfPromoMax,
      },
      select: { id: true },
    });
    // cuid: the last characters are the random block
    const account = await tx.redditAccount.update({
      where: { id: created.id },
      data: { username: `pending-${created.id.slice(-6)}`, redditId: `pending:${created.id}` },
      select: { id: true, username: true },
    });

    const profile = await tx.browserProfile.create({
      data: {
        workspaceId: input.workspaceId,
        accountId: account.id,
        name: profileName(owner.user.name ?? owner.user.email.split('@')[0] ?? 'Owner'),
        fingerprint: input.fingerprint,
        cookiesVolume: `tl-profile-${account.id}`,
      },
      select: { id: true },
    });
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: actor,
        action: 'account.connect_started',
        targetType: 'RedditAccount',
        targetId: account.id,
        accountId: account.id,
        meta: {
          item: `${account.username} waiting for sign-in`,
          authMode: 'browser',
          roleLabel: input.roleLabel,
          profileId: profile.id,
        },
      },
      tx,
    );
    await ensureCloakFingerprintTx(tx, {
      workspaceId: input.workspaceId,
      profileId: profile.id,
      actorMemberId: actor,
    });

    const node = await pickForProfile(input.workspaceId, tx);
    if (node) {
      await tx.browserProfile.update({ where: { id: profile.id }, data: { nodeId: node.id } });
      await writeAudit(
        {
          workspaceId: input.workspaceId,
          actorMemberId: actor,
          action: 'profile.node_assigned',
          targetType: 'BrowserProfile',
          targetId: profile.id,
          accountId: account.id,
          meta: {
            item: `New profile → ${node.name}`,
            from: null,
            to: node.name,
            fromNodeId: null,
            toNodeId: node.id,
          },
        },
        tx,
      );
    }
    if (input.proxyId) await attachProxyTx(tx, input.workspaceId, profile.id, input.proxyId, actor);

    return {
      accountId: account.id,
      username: account.username,
      profileId: profile.id,
      node: node ? { id: node.id, name: node.name } : null,
    };
  });
}

export interface BrowserIdentity {
  /** Reddit username, as `me.json` returns it */
  name: string;
  /** base-36 account id without the `t2_` prefix */
  id: string;
  totalKarma?: number;
  /** epoch seconds */
  createdUtc?: number;
}

/**
 * Browser mode, step 2: the gateway read the signed-in identity with `profile.whoami`. Sets username,
 * `redditId` (`t2_<id>`), karma, account age and `identifiedAt`; writes `account.connected`
 * { username, authMode: 'browser' }. Idempotent for the same identity (no second audit row). Refuses
 * (AccountConflictError) when another account of the workspace has that Reddit identity, or when the
 * account was already identified as a different Reddit user.
 */
export async function completeBrowserIdentity(
  workspaceId: string,
  accountId: string,
  who: BrowserIdentity,
  actorMemberId: string | null = null,
): Promise<{ changed: boolean; username: string }> {
  if (!/^[a-z0-9]{1,16}$/.test(who.id)) throw new Error('invalid Reddit account id');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(who.name)) throw new Error('invalid Reddit username');
  const redditId = `t2_${who.id}`;
  try {
    return await prisma.$transaction(async (tx) => {
      const acc = await tx.redditAccount.findFirst({
        where: { workspaceId, id: accountId },
        select: { id: true, authMode: true, identifiedAt: true, redditId: true, username: true },
      });
      if (!acc) throw new Error('Account not found');
      if (acc.authMode !== 'browser') throw new Error('Not a browser-mode account');
      if (acc.identifiedAt) {
        if (acc.redditId === redditId) return { changed: false, username: acc.username };
        throw new AccountConflictError(
          `This profile is signed in as u/${who.name}, but the account is u/${acc.username}.`,
        );
      }
      const other = await tx.redditAccount.findFirst({
        where: {
          workspaceId,
          id: { not: acc.id },
          OR: [{ redditId }, { username: { equals: who.name, mode: 'insensitive' } }],
        },
        select: { id: true },
      });
      if (other) throw new AccountConflictError(`u/${who.name} is already connected in this workspace.`);
      const { count } = await tx.redditAccount.updateMany({
        where: { id: acc.id, identifiedAt: null },
        data: {
          username: who.name,
          redditId,
          ...(who.totalKarma !== undefined ? { karma: who.totalKarma } : {}),
          ...(who.createdUtc !== undefined ? { accountCreatedAt: new Date(who.createdUtc * 1000) } : {}),
          identifiedAt: new Date(),
        },
      });
      if (count === 0) {
        // a concurrent call identified it first
        const now = await tx.redditAccount.findUniqueOrThrow({
          where: { id: acc.id },
          select: { redditId: true, username: true },
        });
        if (now.redditId === redditId) return { changed: false, username: now.username };
        throw new AccountConflictError(
          `This profile is signed in as u/${who.name}, but the account is u/${now.username}.`,
        );
      }
      await writeAudit(
        {
          workspaceId,
          actorMemberId,
          action: 'account.connected',
          targetType: 'RedditAccount',
          targetId: acc.id,
          accountId: acc.id,
          meta: { username: who.name, authMode: 'browser', previous: acc.username },
        },
        tx,
      );
      return { changed: true, username: who.name };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw new AccountConflictError(`u/${who.name} is already connected in this workspace.`);
    throw e;
  }
}

export async function updateLimits(
  workspaceId: string,
  id: string,
  input: { dailyPostLimit: number; selfPromoMax: number; disclosureLine: string },
) {
  const a = await prisma.redditAccount.findFirst({ where: { workspaceId, id } });
  if (!a) throw new Error('Account not found');
  return prisma.redditAccount.update({ where: { id }, data: input });
}

/** Revokes our stored token and blocks the account; history (drafts, messages) is kept. */
export async function disconnect(workspaceId: string, id: string, actorMemberId: string) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.redditAccount.findFirst({ where: { workspaceId, id } });
    if (!a) throw new Error('Account not found');
    await tx.redditAccount.update({
      where: { id },
      data: { oauthTokenEnc: null, scopes: [], health: 'blocked' },
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'account.health_changed',
        targetType: 'RedditAccount',
        targetId: id,
        accountId: id,
        meta: { from: a.health, to: 'blocked', reason: 'disconnected' },
      },
      tx,
    );
  });
}

/** Members who can own a newly connected account (no account yet). */
export async function ownerOptions(workspaceId: string) {
  return prisma.workspaceMember.findMany({
    where: { workspaceId, ownedAccount: null },
    select: { id: true, user: { select: { name: true, email: true } } },
  });
}
