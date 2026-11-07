import { requireMember } from '@/lib/session';
import { settings } from '@threadline/db';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Audit log' };

const TONE = { ok: 'chip-ok', mid: 'chip-mid', hot: 'chip-hot', line: 'chip-line', bad: 'chip-bad' } as const;
const when = (d: Date) =>
  `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const me = await requireMember();
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const data = await settings.auditPage(me.workspaceId, page);
  return (
    <section className="panel" aria-labelledby="audit-h">
      <div className="sect-h">
        <h2 id="audit-h">Audit log</h2>
        <span className="muted text-xs">Every posted item, with who approved it and from which account</span>
        <div className="flex-1" />
        <a className="btn btn-ghost !h-7" href="/api/audit/export" download>
          Export CSV
        </a>
      </div>
      <div className="overflow-x-auto px-2 pt-1 pb-1.5">
        <table className="tbl" data-testid="audit-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Item</th>
              <th>Agent</th>
              <th>Approved by</th>
              <th>Posted from</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((a) => (
              <tr key={a.id}>
                <td className="muted num whitespace-nowrap">{when(a.at)}</td>
                <td>
                  <span className={`chip ${TONE[a.tone]}`}>{a.label}</span>
                </td>
                <td className="max-w-[340px] truncate" title={a.item}>
                  {a.item}
                </td>
                <td>{a.agent}</td>
                <td className="font-medium">{a.by}</td>
                <td className="muted">{a.from}</td>
              </tr>
            ))}
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing logged yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {data.pages > 1 ? (
        <nav
          aria-label="Audit log pages"
          className="flex items-center gap-2 border-t border-line-soft px-[18px] py-3 text-[12.5px]"
        >
          <span className="muted">
            Page {data.page} of {data.pages} · {data.total} events
          </span>
          <div className="flex-1" />
          {data.page > 1 ? (
            <Link className="btn !h-7" href={`/settings/audit?page=${data.page - 1}`}>
              Newer
            </Link>
          ) : null}
          {data.page < data.pages ? (
            <Link className="btn !h-7" href={`/settings/audit?page=${data.page + 1}`}>
              Older
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
