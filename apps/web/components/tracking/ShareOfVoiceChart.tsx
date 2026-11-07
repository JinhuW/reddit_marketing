import { fmtPct } from '@threadline/shared';

/** Share of voice: threads mentioning us vs each competitor, as horizontal bars. */
export function ShareOfVoiceChart({
  data,
}: {
  data: { days: number; total: number; rows: { name: string; count: number; share: number; us: boolean }[] };
}) {
  const max = Math.max(1, ...data.rows.map((r) => r.count));
  return (
    <section className="panel min-w-0">
      <div className="sect-h flex-wrap">
        <h2>Share of voice</h2>
        <span className="muted text-xs">Threads mentioning each brand · last {data.days} days</span>
      </div>
      <div className="flex flex-col gap-2.5 px-[18px] pt-4 pb-4 text-[12.5px]">
        {data.total === 0 ? (
          <p className="muted m-0">No mentions yet. Add competitor terms to a keyword group.</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Mentions by brand">
          {data.rows.map((r) => (
            <li key={r.name} className="grid grid-cols-[96px_minmax(0,1fr)_76px] items-center gap-2.5">
              <span className={`truncate ${r.us ? 'font-semibold' : 'font-medium'}`}>{r.name}</span>
              <span className="h-3 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                <span
                  className={`block h-full rounded-full ${r.us ? 'bg-accent' : 'bg-faint'}`}
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </span>
              <span className="num text-right">
                <b className="font-semibold">{r.count}</b> <span className="muted">{fmtPct(r.share)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
