import { randomBytes } from 'node:crypto';
import type { MemberRole } from '@threadline/shared';
import { prisma } from '../client';

export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // Auth.js default

/**
 * Makes sure an ERP-verified person has a User and a membership. Existing memberships are left as they are
 * (an admin may have changed the role); a first sign-in joins `workspaceSlug`, or the oldest top-level
 * workspace, or a new "Recycle Servers" workspace when the database is empty.
 */
export async function ensureErpMember(input: {
  email: string;
  name: string;
  role: MemberRole;
  canApprove: boolean;
  workspaceSlug?: string | null;
}) {
  const email = input.email.toLowerCase();
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: input.name, emailVerified: new Date() },
  });
  const existing = await prisma.workspaceMember.findFirst({ where: { userId: user.id } });
  if (existing) return { user, member: existing, created: false };

  const ws =
    (input.workspaceSlug
      ? await prisma.workspace.findUnique({ where: { slug: input.workspaceSlug } })
      : null) ??
    (await prisma.workspace.findFirst({
      where: { parentWorkspaceId: null },
      orderBy: { createdAt: 'asc' },
    })) ??
    (await prisma.workspace.create({
      data: { name: 'Recycle Servers', slug: input.workspaceSlug || 'recycle-servers', plan: 'pro' },
    }));
  const member = await prisma.workspaceMember.create({
    data: { workspaceId: ws.id, userId: user.id, role: input.role, canApprove: input.canApprove },
  });
  return { user, member, created: true };
}

/** A database session row in the shape the Auth.js Prisma adapter reads. */
export async function createSession(userId: string) {
  const sessionToken = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SEC * 1000);
  await prisma.session.create({ data: { sessionToken, userId, expires } });
  return { sessionToken, expires };
}
