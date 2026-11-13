import { parseListParams } from '@/components/browsers/list-params';
import { getCurrentMember } from '@/lib/session';
import { browsers } from '@threadline/db';
import { toCsv } from '@threadline/shared';

export const dynamic = 'force-dynamic';

/**
 * CSV export of the Browsers list as filtered (plan 0004 phase 4). The first six columns are the ones "Import
 * from CSV" reads, so an export can be edited and imported elsewhere. No secrets: no cookies, no proxy login, no
 * account password; the proxy is its host:port.
 */
export async function GET(req: Request) {
  const me = await getCurrentMember();
  if (!me) return new Response('Unauthorized', { status: 401 });
  const p = parseListParams(Object.fromEntries(new URL(req.url).searchParams));
  const rows: Awaited<ReturnType<typeof browsers.searchProfiles>>['rows'] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await browsers.searchProfiles(me.workspaceId, {
      q: p.q,
      groupId: p.group,
      tagId: p.tag,
      status: p.status,
      sort: p.sort,
      dir: p.dir,
      trashed: p.trash,
      page,
      pageSize: 200,
    });
    rows.push(...r.rows);
    if (page >= r.pages) break;
  }
  const csv = toCsv(
    ['name', 'group', 'tags', 'notes', 'start_url', 'proxy', 'number', 'account', 'status', 'created'],
    rows.map((r) => [
      r.name,
      r.group?.name,
      r.tags.map((t) => t.name).join(';'),
      r.notes,
      r.startUrl,
      r.proxy?.host ? `${r.proxy.host}:${r.proxy.port ?? ''}` : '',
      r.serial,
      r.account && !r.account.username.startsWith('pending-') ? `u/${r.account.username}` : '',
      r.status,
      r.createdAt.toISOString().slice(0, 10),
    ]),
  );
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="browsers-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
