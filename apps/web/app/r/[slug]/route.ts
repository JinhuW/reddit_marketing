import { allow, clientIp } from '@/lib/rate-limit';
import { VID_COOKIE, VID_RE, hashIp, newVisitorId } from '@/lib/visitor';
import { prisma } from '@threadline/db';
import { type UtmParams, withUtm } from '@threadline/shared';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Tracked short link: logs a ClickEvent, sets the first-party tl_vid cookie, 302s with UTMs. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ip = clientIp(req);
  const link = await prisma.trackedLink.findUnique({ where: { slug } });
  if (!link) return new NextResponse('Link not found', { status: 404 });

  const cookie = req.headers.get('cookie') ?? '';
  const existing = cookie.match(/(?:^|;\s*)tl_vid=([^;]+)/)?.[1];
  const vid = existing && VID_RE.test(existing) ? existing : newVisitorId();

  // Rate-limited clicks still redirect; they are just not counted.
  if (await allow(`click:${ip}`, 30, 60)) {
    await prisma.$transaction([
      prisma.clickEvent.create({
        data: {
          workspaceId: link.workspaceId,
          trackedLinkId: link.id,
          visitorId: vid,
          ipHash: hashIp(ip),
          ua: req.headers.get('user-agent')?.slice(0, 300) ?? null,
          referer: req.headers.get('referer')?.slice(0, 500) ?? null,
        },
      }),
      prisma.trackedLink.update({ where: { id: link.id }, data: { clicks: { increment: 1 } } }),
    ]);
  }

  const { utm_source, utm_medium, utm_campaign, utm_content, utm_term } = (link.utm ??
    {}) as Partial<UtmParams>;
  const dest = withUtm(link.destinationUrl, {
    utm_source: utm_source ?? 'reddit',
    utm_medium: utm_medium ?? link.medium,
    utm_campaign,
    utm_content,
    utm_term,
  });
  const res = NextResponse.redirect(dest, 302);
  if (vid !== existing)
    res.cookies.set(VID_COOKIE, vid, {
      maxAge: 365 * 86_400,
      sameSite: 'lax',
      path: '/',
      secure: req.url.startsWith('https'),
    });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
