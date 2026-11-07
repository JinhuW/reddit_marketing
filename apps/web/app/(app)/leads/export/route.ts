import { parseLeadParams } from '@/components/leads/params';
import { getCurrentMember } from '@/lib/session';
import { leads } from '@threadline/db';
import { LEAD_STAGE_LABEL } from '@threadline/shared';

export const dynamic = 'force-dynamic';

/** RFC 4180 field: quote when needed, double inner quotes, and defuse spreadsheet formulas. */
function cell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export of the current Leads table view (same saved view and sort). */
export async function GET(req: Request) {
  const me = await getCurrentMember();
  if (!me) return new Response('Unauthorized', { status: 401 });
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const p = parseLeadParams(sp);
  const rows = await leads.table(me.workspaceId, {
    view: p.saved,
    sort: p.sort,
    dir: p.dir,
    meMemberId: me.id,
  });
  const header = [
    'username',
    'first_seen_thread',
    'subreddits',
    'stage',
    'intent',
    'agent',
    'owner',
    'last_touch',
    'clicks',
    'signup_email',
    'deal_value_usd',
    'revenue_usd',
    'tags',
  ];
  const lines = rows.map((r) =>
    [
      `u/${r.username}`,
      r.firstThread,
      r.subreddits.map((s) => `r/${s}`).join(' '),
      LEAD_STAGE_LABEL[r.stage],
      r.intentScore,
      r.agent?.name,
      r.owner?.name,
      r.lastActivityAt.toISOString(),
      r.clicks,
      r.signupEmail,
      (r.dealValueCents / 100).toFixed(2),
      (r.revenueCents / 100).toFixed(2),
      r.tags.join('; '),
    ]
      .map(cell)
      .join(','),
  );
  const csv = `${[header.join(','), ...lines].join('\r\n')}\r\n`;
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="threadline-leads-${p.saved}-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
