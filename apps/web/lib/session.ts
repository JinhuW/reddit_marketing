import 'server-only';
import { auth } from '@/auth';
import { members } from '@threadline/db';
import type { MemberRole } from '@threadline/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

export const WS_COOKIE = 'tl_ws';

/** Current signed-in member for the selected workspace, or null. Cached per request. */
export const getCurrentMember = cache(async () => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const slug = (await cookies()).get(WS_COOKIE)?.value ?? null;
  return (await members.findMembership(userId, slug)) ?? (await members.findMembership(userId));
});

/** For pages: redirects to /login when signed out. */
export async function requireMember() {
  const m = await getCurrentMember();
  if (!m) redirect('/login');
  return m;
}

export class ForbiddenError extends Error {
  constructor(message = 'You do not have permission to do that.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * For server actions and route handlers: role checks happen here, never only in the UI.
 * `approve` additionally requires the canApprove flag.
 */
export async function requireRole(min: MemberRole, opts: { approve?: boolean } = {}) {
  const m = await getCurrentMember();
  if (!m) throw new ForbiddenError('Sign in first.');
  if (!members.roleAtLeast(m.role, min)) throw new ForbiddenError();
  if (opts.approve && !members.memberCanApprove(m))
    throw new ForbiddenError('You are not an approver in this workspace.');
  return m;
}
