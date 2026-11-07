import type { dashboard } from '@threadline/db';
import { fmtInt, fmtPct } from '@threadline/shared';

type Step = Awaited<ReturnType<typeof dashboard.funnel>>[number];

export function Funnel({ steps }: { steps: Step[] }) {
  return (
    <section className="panel" aria-labelledby="funnel-h">
      <div className="sect-h">
        <h2 id="funnel-h">Funnel</h2>
        <span className="muted text-xs">Unique people, last 30 days</span>
      </div>
      <div className="flex flex-col gap-2 px-[18px] pt-4 pb-[18px]">
        {steps.map((f, i) => (
          <div
            key={f.stage}
            className="grid grid-cols-[120px_minmax(0,1fr)_110px] items-center gap-3 text-[13px]"
          >
            <span className="font-medium">{f.stage}</span>
            <div className="h-[22px] overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(f.n ? 1.5 : 0, f.width * 100)}%`,
                  background: i === steps.length - 1 ? 'var(--accent)' : 'var(--ink)',
                }}
              />
            </div>
            <span className="num text-right whitespace-nowrap">
              <b className="font-semibold">{fmtInt(f.n)}</b>{' '}
              <span className="muted">{f.rate === null ? '' : fmtPct(f.rate)}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
