import { Icon } from '@/components/ui/icon';
import Link from 'next/link';

const PLAN_NAME = { starter: 'Starter plan', pro: 'Pro plan', agency: 'Agency plan' } as const;

export function PlanUsageCard({
  plan,
  usage,
}: {
  plan: keyof typeof PLAN_NAME;
  usage: { replies: { used: number; limit: number }; agents: { used: number; limit: number } };
}) {
  const rows = [
    { label: 'Replies posted', ...usage.replies },
    { label: 'Agents', ...usage.agents },
  ];
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-[14px] border border-line bg-surface px-3.5 py-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="clock" size={15} className="text-accent" />
        {PLAN_NAME[plan]}
      </div>
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-2">
          <div className="flex justify-between text-[11.5px] text-muted">
            <span>{r.label}</span>
            <span className="num font-medium text-ink">
              {r.used} / {r.limit}
            </span>
          </div>
          <div
            className="bar"
            role="meter"
            aria-label={r.label}
            aria-valuenow={r.used}
            aria-valuemin={0}
            aria-valuemax={r.limit}
          >
            <i style={{ width: `${Math.min(100, Math.round((r.used / r.limit) * 100))}%` }} />
          </div>
        </div>
      ))}
      <Link href="/settings/billing" className="mt-0.5 text-xs font-semibold text-accent">
        Manage plan
      </Link>
    </div>
  );
}
