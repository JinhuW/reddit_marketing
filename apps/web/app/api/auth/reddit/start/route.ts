import { randomBytes } from 'node:crypto';
import { STATE_COOKIE, authorizeUrl, redditConfigured } from '@/lib/reddit-oauth';
import { getCurrentMember } from '@/lib/session';
import { accounts } from '@threadline/db';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Step 1 of the connect flow: redirect to Reddit's consent screen. */
export async function GET(req: Request) {
  const back = (error: string) => NextResponse.redirect(new URL(`/accounts/connect?error=${error}`, req.url));
  const me = await getCurrentMember();
  if (!me) return NextResponse.redirect(new URL('/login', req.url));
  if (me.role === 'viewer') return back('forbidden');
  if ((await accounts.accountRoom(me.workspaceId)).full) return back('plan_full');
  if (!redditConfigured()) return back('not_configured');
  const state = randomBytes(24).toString('base64url');
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.url.startsWith('https'),
    path: '/api/auth/reddit',
    maxAge: 600,
  });
  return res;
}
