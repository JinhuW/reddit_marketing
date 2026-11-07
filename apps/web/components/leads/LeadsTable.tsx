import type { leads as leadsRepo } from '@threadline/db';
import { LEAD_STAGE_LABEL } from '@threadline/shared';
import Link from 'next/link';
import { lastTouch, money } from './format';

type Row = Awaited<ReturnType<typeof leadsRepo.table>>[number];
type SortKey = leadsRepo.SortKey;

const COLS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: 'username', label: 'Username' },
  { key: 'firstThread', label: 'First seen thread' },
  { key: 'subreddits', label: 'Subreddits' },
  { key: 'stage', label: 'Stage' },
  { key: 'intentScore', label: 'Intent', right: true },
  { key: 'agent', label: 'Agent' },
  { key: 'owner', label: 'Owner' },
  { key: 'lastActivityAt', label: 'Last touch' },
  { key: 'clicks', label: 'Clicks', right: true },
  { key: 'signupEmail', label: 'Signup email' },
  { key: 'revenueCents', label: 'Revenue', right: true },
  { key: 'tags', label: 'Tags' },
];

export function LeadsTable({
  rows,
  sort,
  dir,
  hrefFor,
  viewLabel,
  total,
}: {
  rows: Row[];
  sort: SortKey;
  dir: 'asc' | 'desc';
  hrefFor: (sort: SortKey, dir: 'asc' | 'desc') => string;
  viewLabel: string;
  total: number;
}) {
  return (
    <div className="panel overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            {COLS.map((c) => {
              const on = c.key === sort;
              const next = on && dir === 'asc' ? 'desc' : 'asc';
              return (
                <th
                  key={c.key}
                  aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={c.right ? '!text-right' : ''}
                >
                  <Link href={hrefFor(c.key, next)} scroll={false} className={on ? 'text-ink' : ''}>
                    {c.label}
                    {on ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </Link>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="row-hover">
              <td className="font-semibold whitespace-nowrap">
                <Link href={`/leads/${r.id}`} className="hover:text-accent">
                  u/{r.username}
                </Link>
              </td>
              <td className="muted max-w-[240px] truncate">{r.firstThread ?? '—'}</td>
              <td className="whitespace-nowrap">{r.subreddits.map((s) => `r/${s}`).join(', ') || '—'}</td>
              <td>
                <span className="chip chip-line">{LEAD_STAGE_LABEL[r.stage]}</span>
              </td>
              <td className="num text-right font-semibold">{r.intentScore}</td>
              <td>{r.agent?.name ?? '—'}</td>
              <td className="whitespace-nowrap">{r.owner?.name ?? '—'}</td>
              <td className="muted whitespace-nowrap">{lastTouch(r.lastActivityAt)}</td>
              <td className="num text-right">{r.clicks}</td>
              <td className="muted">{r.signupEmail ?? '—'}</td>
              <td className="num text-right font-semibold">{money(r.revenueCents)}</td>
              <td className="muted">{r.tags.join(', ') || '—'}</td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLS.length} className="muted py-8 text-center">
                No leads in this view.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="muted flex justify-between px-3.5 py-3 text-xs">
        <span>
          Showing {rows.length} of {total}
        </span>
        <span>Saved view: {viewLabel}</span>
      </div>
    </div>
  );
}
