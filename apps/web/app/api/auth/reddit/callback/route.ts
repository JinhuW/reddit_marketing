import {
  PENDING_COOKIE,
  PENDING_TTL_S,
  STATE_COOKIE,
  exchangeCode,
  fetchMe,
  sealPending,
} from '@/lib/reddit-oauth';
import { getCurrentMember } from '@/lib/session';
import { accounts } from '@threadline/db';
import { encrypt } from '@threadline/shared/crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Reddit redirects here. Verifies state, exchanges the code, reads the identity and keeps the encrypted
 * refresh token in a short-lived encrypted cookie until the owner finishes steps 2–4 (finishConnect).
 * Tokens are never logged or returned.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/accounts/connect?${q}`, req.url));
    res.cookies.delete({ name: STATE_COOKIE, path: '/api/auth/reddit' });
    return res;
  };
  const me = await getCurrentMember();
  if (!me) return NextResponse.redirect(new URL('/login', req.url));
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  const state = url.searchParams.get('state');
  if (url.searchParams.get('error')) return back('error=denied');
  if (!expected || !state || state !== expected) return back('error=state');
  const code = url.searchParams.get('code');
  if (!code) return back('error=denied');
  if ((await accounts.accountRoom(me.workspaceId)).full) return back('error=plan_full');
  try {
    const token = await exchangeCode(code);
    const who = await fetchMe(token.access_token);
    const sealed = sealPending({
      memberId: me.id,
      username: who.name,
      redditId: `t2_${who.id}`,
      karma: who.total_karma ?? (who.link_karma ?? 0) + (who.comment_karma ?? 0),
      createdUtc: who.created_utc,
      refreshEnc: encrypt(token.refresh_token),
      scopes: token.scope.split(/[\s,]+/).filter(Boolean),
      exp: Date.now() + PENDING_TTL_S * 1000,
    });
    const res = back('step=2');
    res.cookies.set(PENDING_COOKIE, sealed, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.url.startsWith('https'),
      path: '/',
      maxAge: PENDING_TTL_S,
    });
    return res;
  } catch {
    return back('error=reddit');
  }
}
