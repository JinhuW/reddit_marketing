import { Prisma } from '@prisma/client';
// Repository functions for the Tracking screen (docs/PLAN.md §5 steps 1-2, §7 row 8):
// keyword groups, subreddit watchlist and share of voice.
import type { Intent, LinkRule, ModStatus } from '@threadline/shared';
import { prisma } from '../client';

const DAY = 86_400_000;

export interface AlertSettings {
  channel?: 'slack' | 'email' | 'none';
  target?: string;
  cadence?: 'instant' | 'hourly' | 'daily' | 'off';
}

export function alertLabel(a: AlertSettings | null | undefined): string {
  if (!a || !a.channel || a.channel === 'none' || a.cadence === 'off') return 'Off';
  if (a.channel === 'slack') return `Slack${a.target ? ` ${a.target}` : ''}, ${a.cadence ?? 'instant'}`;
  return `Email digest, ${a.cadence ?? 'daily'}`;
}

/** Keyword groups with 7-day opportunity volume and a daily series for the sparkline. */
export async function listKeywordGroups(workspaceId: string, now: Date = new Date()) {
  const since = new Date(Math.floor(now.getTime() / DAY) * DAY - 6 * DAY);
  const [groups, daily] = await Promise.all([
    prisma.keywordGroup.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { agent: { select: { id: true, name: true, color: true } } },
    }),
    prisma.$queryRaw<{ gid: string; day: Date; n: bigint }[]>(Prisma.sql`
      SELECT "keywordGroupId" AS gid, date_trunc('day', "createdAt") AS day, count(*) AS n
      FROM "Opportunity"
      WHERE "workspaceId" = ${workspaceId} AND "keywordGroupId" IS NOT NULL AND "createdAt" >= ${since}
      GROUP BY 1, 2`),
  ]);
  return groups.map((g) => {
    const series = new Array<number>(7).fill(0);
    for (const r of daily) {
      if (r.gid !== g.id) continue;
      const i = Math.floor((new Date(r.day).getTime() - since.getTime()) / DAY);
      if (i >= 0 && i < 7) series[i] = (series[i] ?? 0) + Number(r.n);
    }
    const alert = (g.alert ?? {}) as AlertSettings;
    return {
      id: g.id,
      name: g.name,
      intent: g.intent,
      include: g.include,
      exclude: g.exclude,
      competitor: g.competitor,
      subreddits: g.subreddits,
      alert,
      alertLabel: alertLabel(alert),
      agent: g.agent,
      volume: series.reduce((s, n) => s + n, 0),
      series,
    };
  });
}
export type KeywordGroupView = Awaited<ReturnType<typeof listKeywordGroups>>[number];

export interface KeywordGroupInput {
  name: string;
  intent: Intent;
  include: string[];
  exclude: string[];
  competitor: string[];
  subreddits: string[];
  alert: AlertSettings;
  agentId: string | null;
}

async function assertAgent(workspaceId: string, agentId: string | null) {
  if (agentId) await prisma.agent.findFirstOrThrow({ where: { id: agentId, workspaceId } });
}

export async function createKeywordGroup(workspaceId: string, input: KeywordGroupInput) {
  await assertAgent(workspaceId, input.agentId);
  return prisma.keywordGroup.create({ data: { workspaceId, ...input, alert: { ...input.alert } } });
}

export async function updateKeywordGroup(workspaceId: string, id: string, input: KeywordGroupInput) {
  await assertAgent(workspaceId, input.agentId);
  const res = await prisma.keywordGroup.updateMany({
    where: { id, workspaceId },
    data: { ...input, alert: { ...input.alert } },
  });
  if (res.count === 0) throw new Error('Keyword group not found');
}

export async function deleteKeywordGroup(workspaceId: string, id: string) {
  // Opportunities keep their history; the group link is cleared.
  await prisma.$transaction([
    prisma.opportunity.updateMany({
      where: { workspaceId, keywordGroupId: id },
      data: { keywordGroupId: null },
    }),
    prisma.keywordGroup.deleteMany({ where: { id, workspaceId } }),
  ]);
}

/** Subreddit watchlist with our best per-account karma in each sub. */
export async function listSubreddits(workspaceId: string) {
  const subs = await prisma.subreddit.findMany({
    where: { workspaceId },
    orderBy: { members: 'desc' },
    include: { accountStats: { select: { karma: true } } },
  });
  return subs
    .map((s) => ({
      id: s.id,
      name: s.name,
      members: s.members,
      activity: s.activity,
      selfPromoPolicy: s.selfPromoPolicy,
      linkRule: s.linkRule,
      modStatus: s.modStatus,
      notes: s.notes,
      minKarma: s.minKarma,
      minAccountAgeDays: s.minAccountAgeDays,
      karma: s.accountStats.length ? Math.max(...s.accountStats.map((a) => a.karma)) : null,
    }))
    .sort((a, b) => (b.karma ?? -1) - (a.karma ?? -1));
}
export type SubredditView = Awaited<ReturnType<typeof listSubreddits>>[number];

export interface SubredditInput {
  name: string;
  selfPromoPolicy: string | null;
  linkRule: LinkRule;
  modStatus: ModStatus;
  notes: string | null;
}

export const normalizeSubName = (n: string) => n.trim().replace(/^\/?r\//i, '');

export async function addSubreddit(workspaceId: string, input: SubredditInput) {
  return prisma.subreddit.create({ data: { workspaceId, ...input, name: normalizeSubName(input.name) } });
}

export async function updateSubreddit(workspaceId: string, id: string, input: Omit<SubredditInput, 'name'>) {
  const res = await prisma.subreddit.updateMany({ where: { id, workspaceId }, data: input });
  if (res.count === 0) throw new Error('Subreddit not found');
}

/**
 * Share of voice over the last `days`: posts whose title or body mention each competitor term
 * (from all keyword groups) vs. posts that mention our brand or where one of our replies was posted.
 */
export async function shareOfVoice(workspaceId: string, days = 30) {
  const since = new Date(Date.now() - days * DAY);
  const [groups, ws] = await Promise.all([
    prisma.keywordGroup.findMany({ where: { workspaceId }, select: { competitor: true } }),
    prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { name: true, settings: true },
    }),
  ]);
  const brand = ((ws.settings ?? {}) as { product?: string }).product ?? ws.name;
  const terms = [
    ...new Set(
      groups
        .flatMap((g) => g.competitor)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const mention = (term: string) =>
    prisma.post.count({
      where: {
        workspaceId,
        postedAt: { gte: since },
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { body: { contains: term, mode: 'insensitive' } },
        ],
      },
    });
  const [competitors, brandMentions] = await Promise.all([
    Promise.all(
      terms.map(async (t) => ({
        name: t[0]!.toUpperCase() + t.slice(1),
        count: await mention(t),
        us: false,
      })),
    ),
    prisma.post.count({
      where: {
        workspaceId,
        postedAt: { gte: since },
        OR: [
          { title: { contains: brand, mode: 'insensitive' } },
          { body: { contains: brand, mode: 'insensitive' } },
          { opportunity: { drafts: { some: { status: 'posted' } } } },
          { conversations: { some: { messages: { some: { direction: 'out' } } } } },
        ],
      },
    }),
  ]);
  const rows = [{ name: brand, count: brandMentions, us: true }, ...competitors].sort(
    (a, b) => Number(b.us) - Number(a.us) || b.count - a.count,
  );
  const total = rows.reduce((s, r) => s + r.count, 0);
  return { days, total, rows: rows.map((r) => ({ ...r, share: total ? r.count / total : 0 })) };
}

export async function trackingSummary(workspaceId: string) {
  const [groups, subs] = await Promise.all([
    prisma.keywordGroup.count({ where: { workspaceId } }),
    prisma.subreddit.count({ where: { workspaceId } }),
  ]);
  return { groups, subs };
}

export const agentOptions = (workspaceId: string) =>
  prisma.agent.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
