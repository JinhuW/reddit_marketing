import type { performance } from '@threadline/db/repos/agents';
import { fmtMoney } from '@threadline/shared';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  scheduled: 'Scheduled',
  posted: 'Posted',
  rejected: 'Rejected',
  failed: 'Failed',
};

export function PerformanceCharts({ p }: { p: Awaited<ReturnType<typeof performance>> }) {
  const stats = [
    ['Drafts', String(p.drafts)],
    ['Approval rate', p.approvalRate === null ? '—' : `${Math.round(p.approvalRate * 100)}%`],
    ['Avg. edits', p.avgEdits.toFixed(1)],
    ['Replies posted', String(p.replies)],
    ['Leads', String(p.leads)],
    ['Clicks', p.clicks.toLocaleString('en-US')],
    ['Revenue', fmtMoney(p.revenueCents)],
  ];
  const max = Math.max(1, ...p.byStatus.map((s) => s.n));
  return (
    <div className="flex flex-col gap-5 p-[18px]">
      <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([l, v]) => (
          <div key={l} className="flex flex-col gap-0.5 rounded-card border border-line-soft px-3.5 py-3">
            <dt className="text-[11.5px] text-muted">{l}</dt>
            <dd className="num m-0 text-lg font-semibold tracking-[-0.01em]">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-2">
        <div className="text-[12.5px] font-semibold">Drafts by status</div>
        {p.byStatus.length === 0 ? <div className="muted text-[13px]">No drafts yet.</div> : null}
        {p.byStatus.map((s) => (
          <div
            key={s.status}
            className="grid grid-cols-[96px_minmax(0,1fr)_40px] items-center gap-3 text-[13px]"
          >
            <span>{STATUS_LABEL[s.status] ?? s.status}</span>
            <div className="h-[18px] overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(s.n / max) * 100}%`,
                  background: s.status === 'rejected' ? 'var(--bad)' : 'var(--ink)',
                }}
              />
            </div>
            <span className="num text-right">{s.n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
