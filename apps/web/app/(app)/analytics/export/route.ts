import { parseRange } from '@/lib/range';
import { getCurrentMember } from '@/lib/session';
import { analytics } from '@threadline/db';
import { BREAKDOWNS, type BreakdownBy } from '@threadline/db/repos/analytics';

export const dynamic = 'force-dynamic';

const csvCell = (v: string | number) => {
  const s = String(v);
  // neutralise spreadsheet formula injection and quote
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** CSV of the breakdown table for the selected range and dimension. */
export async function GET(req: Request) {
  const me = await getCurrentMember();
  if (!me) return new Response('Unauthorized', { status: 401 });
  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get('range') ?? undefined);
  const byParam = url.searchParams.get('by');
  const by = (BREAKDOWNS.some((b) => b.key === byParam) ? byParam : 'subreddit') as BreakdownBy;
  const rows = await analytics.breakdown(me.workspaceId, by, range.since);
  const header = [by, 'replies', 'clicks', 'signups', 'customers', 'revenue_usd'];
  const lines = [
    header.map(csvCell).join(','),
    ...rows.map((r) =>
      [r.name, r.replies, r.clicks, r.signups, r.customers, (r.revenueCents / 100).toFixed(2)]
        .map(csvCell)
        .join(','),
    ),
  ];
  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="threadline-${by}-${range.key}.csv"`,
    },
  });
}
