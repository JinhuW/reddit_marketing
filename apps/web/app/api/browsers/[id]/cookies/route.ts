import { cookieExportStatus } from '@/lib/browser-jobs';
import { getCurrentMember } from '@/lib/session';
import { audit, browsers } from '@threadline/db';
import { BrowserCookie, cookiesToJson, cookiesToNetscape } from '@threadline/shared';
import { decrypt } from '@threadline/shared/crypto';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/**
 * Downloads a finished cookie export (plan 0004 phase 4) as JSON or a Netscape cookies.txt file.
 * Only an admin, the account owner or the browser's creator gets it (the same rule as taking the browser over),
 * each download writes `profile.cookies_exported`, and the response is never cached. The cookies exist here only
 * for the length of this request: the queue holds them encrypted, for ten minutes.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentMember();
  if (!me) return new Response('Unauthorized', { status: 401 });
  const { id } = await ctx.params;
  const profile = await browsers.getProfile(me.workspaceId, id);
  if (!profile) return new Response('Not found', { status: 404 });
  if (!browsers.canControlProfile(me, profile)) return new Response('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const format = url.searchParams.get('format') === 'netscape' ? 'netscape' : 'json';
  const r = await cookieExportStatus(me.workspaceId, profile.id, url.searchParams.get('job') ?? '');
  if (r.state === 'pending') return new Response('The export is not ready yet.', { status: 425 });
  if (r.state !== 'done')
    return new Response('That export is no longer available. Export again.', { status: 410 });

  let cookies: BrowserCookie[];
  try {
    cookies = z.array(BrowserCookie).parse(JSON.parse(decrypt(r.enc)));
  } catch {
    return new Response('The export could not be read.', { status: 500 });
  }
  await audit.writeAudit({
    workspaceId: me.workspaceId,
    actorMemberId: me.id,
    action: 'profile.cookies_exported',
    targetType: 'BrowserProfile',
    targetId: profile.id,
    accountId: profile.accountId,
    // Count and format only: never a cookie name's value.
    meta: { item: `Cookies of ${profile.name} exported`, count: cookies.length, format },
  });
  const safe = profile.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'browser';
  return new Response(format === 'netscape' ? cookiesToNetscape(cookies) : cookiesToJson(cookies), {
    headers: {
      'content-type': format === 'netscape' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${safe}-cookies.${format === 'netscape' ? 'txt' : 'json'}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
