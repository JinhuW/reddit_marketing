import { BREAKDOWNS, type BreakdownBy, type BreakdownRow } from '@threadline/db/repos/analytics';
import { fmtInt, fmtMoney } from '@threadline/shared';
import { SegLinks } from './Seg';

export function BreakdownTable({
  by,
  rows,
  hrefFor,
}: {
  by: BreakdownBy;
  rows: BreakdownRow[];
  hrefFor: (by: BreakdownBy) => string;
}) {
  const label = BREAKDOWNS.find((b) => b.key === by)?.label ?? 'Subreddit';
  return (
    <section className="panel min-w-0">
      <div className="sect-h flex-wrap">
        <h2>Breakdown</h2>
        <div className="flex-1" />
        <SegLinks
          label="Break down by"
          items={BREAKDOWNS.map((b) => ({
            key: b.key,
            label: b.label,
            href: hrefFor(b.key),
            active: b.key === by,
          }))}
        />
      </div>
      <div className="relative overflow-x-auto px-2 pt-1 pb-1.5">
        <table className="tbl" data-testid="breakdown">
          <thead>
            <tr>
              <th>{label}</th>
              <th className="!text-right">Replies</th>
              <th className="!text-right">Clicks ↓</th>
              <th className="!text-right">Signups</th>
              <th className="!text-right">Customers</th>
              <th className="!text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing attributed in this period.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.name} className="row-hover">
                <td className="max-w-[240px] truncate font-medium" title={r.name}>
                  {r.name}
                </td>
                <td className="text-right">{fmtInt(r.replies)}</td>
                <td className="text-right">{fmtInt(r.clicks)}</td>
                <td className="text-right">{fmtInt(r.signups)}</td>
                <td className="text-right">{fmtInt(r.customers)}</td>
                <td className="text-right font-semibold">{fmtMoney(r.revenueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
