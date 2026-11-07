import type { Prisma } from '@prisma/client';
// Repository functions for the Opportunities screen (docs/PLAN.md §7 row 2).
import type { Intent, OpportunityStatus } from '@threadline/shared';
import { prisma } from '../client';

export interface OpportunityFilters {
  group?: string | null;
  subreddits?: string[];
  intents?: Intent[];
  minScore?: number;
  sinceDays?: number;
  statuses?: OpportunityStatus[];
  q?: string | null;
}

function where(workspaceId: string, f: OpportunityFilters): Prisma.OpportunityWhereInput {
  const and: Prisma.OpportunityWhereInput[] = [{ workspaceId }];
  if (f.group) and.push({ keywordGroupId: f.group });
  if (f.subreddits?.length) and.push({ post: { subreddit: { name: { in: f.subreddits } } } });
  if (f.intents?.length) and.push({ intent: { in: f.intents } });
  if (f.minScore) and.push({ score: { gte: f.minScore } });
  if (f.sinceDays) and.push({ createdAt: { gte: new Date(Date.now() - f.sinceDays * 86_400_000) } });
  if (f.statuses?.length) and.push({ status: { in: f.statuses } });
  if (f.q?.trim()) {
    const q = f.q.trim();
    and.push({
      OR: [
        { post: { title: { contains: q, mode: 'insensitive' } } },
        { post: { body: { contains: q, mode: 'insensitive' } } },
        { post: { authorUsername: { contains: q.replace(/^u\//, ''), mode: 'insensitive' } } },
        { reason: { contains: q, mode: 'insensitive' } },
      ],
    });
  }
  return { AND: and };
}

export async function list(workspaceId: string, f: OpportunityFilters, take = 50) {
  const w = where(workspaceId, f);
  const [rows, total] = await Promise.all([
    prisma.opportunity.findMany({
      where: w,
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take,
      include: {
        post: {
          select: {
            title: true,
            body: true,
            authorUsername: true,
            upvotes: true,
            comments: true,
            postedAt: true,
            subreddit: { select: { name: true, linkRule: true } },
          },
        },
      },
    }),
    prisma.opportunity.count({ where: w }),
  ]);
  return {
    total,
    items: rows.map((o) => ({
      id: o.id,
      score: o.score,
      level: o.level,
      status: o.status,
      intent: o.intent,
      reason: o.reason,
      matchedKeyword: o.matchedKeyword,
      title: o.post.title,
      body: o.post.body,
      author: o.post.authorUsername,
      upvotes: o.post.upvotes,
      comments: o.post.comments,
      postedAt: o.post.postedAt,
      subreddit: o.post.subreddit.name,
      linkRule: o.post.subreddit.linkRule,
    })),
  };
}

export type OpportunityListItem = Awaited<ReturnType<typeof list>>['items'][number];

/** Approval rate over all decided drafts for an agent. */
export async function agentApprovalRate(agentId: string) {
  const g = await prisma.draft.groupBy({ by: ['status'], where: { agentId }, _count: { _all: true } });
  const n = (s: string[]) => g.filter((x) => s.includes(x.status)).reduce((a, x) => a + x._count._all, 0);
  const ok = n(['approved', 'scheduled', 'posted']);
  const decided = ok + n(['rejected']);
  return decided ? ok / decided : null;
}

export async function get(workspaceId: string, id: string) {
  const o = await prisma.opportunity.findFirst({
    where: { id, workspaceId },
    include: {
      post: { include: { subreddit: true } },
      keywordGroup: { select: { name: true } },
      suggestedAgent: {
        include: {
          account: { select: { username: true, roleLabel: true } },
          approver: { include: { user: { select: { name: true } } } },
        },
      },
    },
  });
  if (!o) return null;
  const a = o.suggestedAgent;
  const persona = (a?.persona ?? {}) as { subreddits?: string[]; focus?: string };
  return {
    id: o.id,
    score: o.score,
    level: o.level,
    status: o.status,
    intent: o.intent,
    reason: o.reason,
    competitors: o.competitorMentions,
    group: o.keywordGroup?.name ?? null,
    post: {
      title: o.post.title,
      body: o.post.body,
      url: o.post.url,
      author: o.post.authorUsername,
      upvotes: o.post.upvotes,
      comments: o.post.comments,
      postedAt: o.post.postedAt,
      subreddit: o.post.subreddit.name,
      topComments: (Array.isArray(o.post.topComments) ? o.post.topComments : []) as {
        author: string;
        body: string;
        score: number;
      }[],
    },
    agent: a
      ? {
          id: a.id,
          name: a.name,
          role: a.roleTitle,
          color: a.color,
          coversSub: persona.subreddits?.includes(o.post.subreddit.name) ?? false,
          approvalRate: await agentApprovalRate(a.id),
          account: a.account ? { username: a.account.username, roleLabel: a.account.roleLabel } : null,
          approver: a.approver?.user.name ?? null,
        }
      : null,
  };
}
export type OpportunityDetail = NonNullable<Awaited<ReturnType<typeof get>>>;

export async function filterOptions(workspaceId: string) {
  const [groups, subreddits, agents] = await Promise.all([
    prisma.keywordGroup.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.subreddit.findMany({
      where: { workspaceId },
      select: { name: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.agent.findMany({
      where: { workspaceId },
      select: { id: true, name: true, color: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { groups, subreddits: subreddits.map((s) => s.name), agents };
}

export async function summary(workspaceId: string) {
  const [newToday, subs, groups] = await Promise.all([
    prisma.opportunity.count({
      where: { workspaceId, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    }),
    prisma.subreddit.count({ where: { workspaceId } }),
    prisma.keywordGroup.count({ where: { workspaceId } }),
  ]);
  return { newToday, subs, groups };
}

/** Only ids that belong to the workspace — guards bulk actions against foreign ids. */
export async function ownedIds(workspaceId: string, ids: string[]) {
  const rows = await prisma.opportunity.findMany({
    where: { workspaceId, id: { in: ids } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export function setStatus(workspaceId: string, ids: string[], status: OpportunityStatus) {
  return prisma.opportunity.updateMany({ where: { workspaceId, id: { in: ids } }, data: { status } });
}

export function assignAgent(workspaceId: string, ids: string[], agentId: string) {
  return prisma.opportunity.updateMany({
    where: { workspaceId, id: { in: ids } },
    data: { suggestedAgentId: agentId },
  });
}

export async function agentInWorkspace(workspaceId: string, agentId: string) {
  return prisma.agent.findFirst({ where: { workspaceId, id: agentId }, select: { id: true, name: true } });
}

export async function newIds(workspaceId: string) {
  const rows = await prisma.opportunity.findMany({
    where: { workspaceId, status: 'new' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function draftCount(opportunityId: string) {
  return prisma.draft.count({ where: { opportunityId } });
}
