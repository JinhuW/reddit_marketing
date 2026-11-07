import type { Kpi } from '@threadline/db/repos/analytics';
import { fmtInt, fmtMoney } from '@threadline/shared';

export function fmtKpi(k: Pick<Kpi, 'value' | 'money' | 'key'>) {
  if (!k.money) return fmtInt(Math.round(k.value));
  if (k.key === 'rpr') return `$${(k.value / 100).toFixed(2)}`;
  return fmtMoney(k.value);
}

export function KpiRow({ kpis, periodLabel }: { kpis: Kpi[]; periodLabel: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {kpis.map((k) => {
        const up = k.delta !== null && k.delta >= 0;
        return (
          <div key={k.key} className="panel flex min-w-0 flex-col gap-1.5 px-4 py-3.5" data-kpi={k.key}>
            <div className="muted text-xs">{k.label}</div>
            <div className="num text-2xl leading-none font-semibold tracking-[-0.02em]">{fmtKpi(k)}</div>
            <div className="muted text-[11.5px]">
              {k.delta === null ? (
                <span>—</span>
              ) : (
                <span className={`font-semibold ${up ? 'text-ok' : 'text-bad'}`}>
                  {up ? '+' : '−'}
                  {Math.abs(Math.round(k.delta * 100))}%
                </span>
              )}{' '}
              vs prior {periodLabel}
            </div>
          </div>
        );
      })}
    </div>
  );
}
