import type { BreakdownRow } from '@threadline/db/repos/analytics';
import { fmtInt, fmtMoney } from '@threadline/shared';
import { LegendDot } from './Seg';

/**
 * "Where revenue came from": per subreddit, three segments for clicks → signups → paid.
 * Each segment is scaled against the largest value of its own stage so small stages stay visible.
 */
export function RevenueFlow({ rows }: { rows: BreakdownRow[] }) {
  const maxC = Math.max(1, ...rows.map((r) => r.clicks));
  const maxS = Math.max(1, ...rows.map((r) => r.signups));
  const maxP = Math.max(1, ...rows.map((r) => r.customers));
  const seg = (v: number, max: number, span: number) => (v ? Math.max(1.5, (v / max) * span) : 0);
  return (
    <section className="panel min-w-0">
      <div className="sect-h flex-wrap">
        <h2>Where revenue came from</h2>
        <span className="muted text-xs">Subreddit → click → signup → paid</span>
      </div>
      <div className="flex flex-col gap-2.5 px-[18px] pt-3.5 pb-4 text-[12.5px]">
        {rows.length === 0 ? <p className="muted m-0">No attributed traffic in this period yet.</p> : null}
        {rows.map((r) => (
          <div key={r.name} className="grid grid-cols-[130px_minmax(0,1fr)_64px] items-center gap-2.5">
            <span className="truncate font-medium" title={r.name}>
              {r.name}
            </span>
            <div
              className="flex h-[18px] gap-[3px]"
              role="img"
              aria-label={`${r.name}: ${fmtInt(r.clicks)} clicks, ${r.signups} signups, ${r.customers} paid`}
            >
              <div
                title={`${fmtInt(r.clicks)} clicks`}
                className="rounded-l-[6px] rounded-r-[2px] bg-line-strong"
                style={{ width: `${seg(r.clicks, maxC, 62)}%` }}
              />
              <div
                title={`${r.signups} signups`}
                className="rounded-[2px] bg-faint"
                style={{ width: `${seg(r.signups, maxS, 24)}%` }}
              />
              <div
                title={`${r.customers} paid`}
                className="rounded-l-[2px] rounded-r-[6px] bg-accent"
                style={{ width: `${seg(r.customers, maxP, 14)}%` }}
              />
            </div>
            <span className="num text-right font-semibold">{fmtMoney(r.revenueCents)}</span>
          </div>
        ))}
        <div className="mt-1 flex gap-3.5">
          <LegendDot color="var(--line-strong)">Clicks</LegendDot>
          <LegendDot color="var(--faint)">Signups</LegendDot>
          <LegendDot color="var(--accent)">Paid</LegendDot>
        </div>
      </div>
    </section>
  );
}
