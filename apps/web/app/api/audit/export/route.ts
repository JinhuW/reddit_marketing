import { getCurrentMember } from '@/lib/session';
import { settings } from '@threadline/db';

export const dynamic = 'force-dynamic';

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // quote, and neutralise spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Full audit log as CSV (excludes per-step session logs). Any member may export; viewers are read-only, not blind. */
export async function GET() {
  const me = await getCurrentMember();
  if (!me) return new Response('Unauthorized', { status: 401 });
  const lines = [
    ['when', 'action', 'label', 'item', 'agent', 'approved_by', 'posted_from', 'disclosure'].join(','),
  ];
  for (let page = 1; ; page++) {
    const data = await settings.auditPage(me.workspaceId, page, 500);
    for (const r of data.rows)
      lines.push(
        [r.at.toISOString(), r.action, r.label, r.item, r.agent, r.by, r.from, r.disclosure ?? '']
          .map(cell)
          .join(','),
      );
    if (page >= data.pages) break;
  }
  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${me.workspace.slug}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
