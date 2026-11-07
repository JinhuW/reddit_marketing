import type { MemberRole } from '@threadline/shared';
import { prisma } from '../client';

export type CurrentMember = NonNullable<Awaited<ReturnType<typeof findMembership>>>;

/** The member row for a user in a workspace (or their first workspace when none is given). */
export async function findMembership(userId: string, workspaceSlug?: string | null) {
  return prisma.workspaceMember.findFirst({
    where: { userId, ...(workspaceSlug ? { workspace: { slug: workspaceSlug } } : {}) },
    orderBy: { createdAt: 'asc' },
    include: { user: true, workspace: true, ownedAccount: { select: { id: true, username: true } } },
  });
}

export async function workspacesForUser(userId: string) {
  return prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: { select: { id: true, name: true, slug: true, plan: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

const RANK: Record<MemberRole, number> = { viewer: 0, editor: 1, approver: 2, admin: 3 };
export const roleAtLeast = (role: MemberRole, min: MemberRole) => RANK[role] >= RANK[min];

/** Approvers need both the role and the canApprove flag; Admins approve only if canApprove is set too. */
export const memberCanApprove = (m: { role: MemberRole; canApprove: boolean }) =>
  m.canApprove && roleAtLeast(m.role, 'approver');

export async function listMembers(workspaceId: string) {
  return prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: true, ownedAccount: { select: { username: true } } },
    orderBy: { createdAt: 'asc' },
  });
}
