import { Sparkline } from '@/components/ui/sparkline';
import type { dashboard } from '@threadline/db';
import { fmtInt, fmtMoney } from '@threadline/shared';

type Kpi = Awaited<ReturnType<typeof dashboard.kpis>>[number];

export function KpiTile({ k }: { k: Kpi }) {
  const chip = k.trend === 'up' ? 'chip-ok' : k.trend === 'down' ? 'chip-bad' : 'chip-mid';
  return (
    <div className="panel flex min-w-0 flex-col gap-2 px-4 py-3.5" data-testid={`kpi-${k.key}`}>
      <div className="muted text-xs leading-tight">{k.label}</div>
      <div className="flex items-baseline gap-2">
        <span className="num text-2xl leading-none font-semibold tracking-[-0.02em]">
          {k.money ? fmtMoney(k.value) : fmtInt(k.value)}
        </span>
        <span className={`chip ${chip}`}>{k.delta}</span>
      </div>
      <Sparkline values={k.spark} stroke={k.accent ? 'var(--accent)' : 'var(--ink)'} />
      <div className="muted text-[11.5px]">{k.period}</div>
    </div>
  );
}
