// Repository functions for the Conversations screen (docs/PLAN.md §7 row 4).
import type { Prisma } from '@prisma/client';
import { prisma } from '../client';

export const TABS = ['all', 'unread', 'needs_reply', 'mine'] as const;
export type ConversationTab = (typeof TABS)[number];

export async function list(workspaceId: string, tab: ConversationTab, meMemberId: string) {
  const where: Prisma.ConversationWhereInput =
    tab === 'unread'
      ? { unread: true }
      : tab === 'needs_reply'
        ? { needsReply: true }
        : tab === 'mine'
          ? { lead: { ownerMemberId: meMemberId } }
          : {};
  const rows = await prisma.conversation.findMany({
    where: { workspaceId, ...where },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      lead: { include: { redditUser: { select: { username: true } } } },
      messages: { orderBy: { sentAt: 'desc' }, take: 1, select: { body: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    username: c.lead.redditUser.username,
    kind: c.kind,
    lastMessageAt: c.lastMessageAt,
    unread: c.unread,
    needsReply: c.needsReply,
    preview: c.messages[0]?.body ?? '',
    where: c.originReason,
  }));
}

export async function counts(workspaceId: string, meMemberId: string) {
  const [all, unread, needsReply, mine] = await Promise.all([
    prisma.conversation.count({ where: { workspaceId } }),
    prisma.conversation.count({ where: { workspaceId, unread: true } }),
    prisma.conversation.count({ where: { workspaceId, needsReply: true } }),
    prisma.conversation.count({ where: { workspaceId, lead: { ownerMemberId: meMemberId } } }),
  ]);
  return { all, unread, needs_reply: needsReply, mine };
}

/** One conversation with its thread, our messages' draft/approver provenance and the lead panel data. */
export async function get(workspaceId: string, id: string) {
  const c = await prisma.conversation.findFirst({
    where: { workspaceId, id },
    include: {
      post: { include: { subreddit: { select: { name: true } } } },
      lead: {
        include: {
          redditUser: { include: { firstSeenPost: { include: { subreddit: { select: { name: true } } } } } },
          owner: { include: { user: { select: { name: true, email: true } } } },
          agent: {
            select: {
              id: true,
              name: true,
              roleTitle: true,
              color: true,
              account: { select: { id: true, username: true } },
            },
          },
          tasks: { where: { done: false }, orderBy: { dueAt: 'asc' }, take: 2 },
          conversations: {
            select: { id: true, originReason: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          },
        },
      },
      messages: {
        orderBy: { sentAt: 'asc' },
        include: {
          account: { select: { username: true, roleLabel: true } },
          draft: {
            select: {
              agent: { select: { name: true } },
              approver: { include: { user: { select: { name: true } } } },
            },
          },
        },
      },
    },
  });
  if (!c) return null;
  const notes = (Array.isArray(c.lead.notes) ? c.lead.notes : []) as {
    by: string;
    at: string;
    body: string;
  }[];
  return { ...c, notes };
}

export const inboundCount = (workspaceId: string, conversationId: string) =>
  prisma.message.count({ where: { workspaceId, conversationId, direction: 'in' } });

export async function markRead(workspaceId: string, id: string) {
  await prisma.conversation.updateMany({ where: { workspaceId, id, unread: true }, data: { unread: false } });
}
