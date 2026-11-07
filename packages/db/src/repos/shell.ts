import { prisma } from '../client';

/** Plan limits (docs/PLAN.md §14: $69 / $200 / $499). Enforced in-app. */
export const PLAN_LIMITS = {
  starter: { repliesPerMonth: 100, agents: 1, accounts: 1 },
  pro: { repliesPerMonth: 500, agents: 5, accounts: 5 },
  agency: { repliesPerMonth: 2000, agents: 20, accounts: 20 },
} as const;

/** Counts for the sidebar badges, the bell and the plan usage card. */
export async function shellCounts(workspaceId: string, memberId: string) {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [newOpps, pendingDrafts, unreadConversations, unreadNotifications, repliesThisMonth, agents, ws] =
    await Promise.all([
      prisma.opportunity.count({ where: { workspaceId, status: 'new', createdAt: { gte: dayAgo } } }),
      prisma.draft.count({ where: { workspaceId, status: 'pending' } }),
      prisma.conversation.count({ where: { workspaceId, unread: true } }),
      prisma.notification.count({ where: { workspaceId, memberId, readAt: null } }),
      prisma.draft.count({ where: { workspaceId, status: 'posted', postedAt: { gte: monthStart } } }),
      prisma.agent.count({ where: { workspaceId } }),
      prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { plan: true } }),
    ]);
  const limits = PLAN_LIMITS[ws.plan];
  return {
    newOpps,
    pendingDrafts,
    unreadConversations,
    unreadNotifications,
    plan: ws.plan,
    usage: {
      replies: { used: repliesThisMonth, limit: limits.repliesPerMonth },
      agents: { used: agents, limit: limits.agents },
    },
  };
}
export type ShellCounts = Awaited<ReturnType<typeof shellCounts>>;
