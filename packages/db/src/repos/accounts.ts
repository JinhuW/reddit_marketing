import type { Prisma } from '@prisma/client';
// Repository functions for the Accounts screen (docs/PLAN.md §7 row 9).
import type { AccountRoleLabel } from '@threadline/shared';
import { prisma } from '../client';
import { writeAudit } from './audit';

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
        connected: Boolean(a.oauthTokenEnc),
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
      },
    });
    const owner = await tx.workspaceMember.findUniqueOrThrow({
      where: { id: input.ownerMemberId },
      include: { user: true },
    });
    const first = (owner.user.name ?? input.username).split(' ')[0];
    await tx.browserProfile.create({
      data: {
        workspaceId: input.workspaceId,
        accountId: account.id,
        name: `${first} · Chrome`,
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
