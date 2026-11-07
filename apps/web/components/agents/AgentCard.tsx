import { Avatar } from '@/components/ui/avatar';
import type { AgentCard as Card } from '@threadline/db/repos/agents';
import { fmtMoney } from '@threadline/shared';
import Link from 'next/link';

export function AgentCard({ a, selected }: { a: Card; selected: boolean }) {
  const subs = a.subreddits.length ? a.subreddits.map((s) => `r/${s}`).join(', ') : 'DMs only';
  return (
    <Link
      href={`/agents?id=${a.id}`}
      aria-current={selected ? 'true' : undefined}
      data-testid="agent-card"
      className={`flex flex-col gap-3 rounded-panel border bg-surface p-4 text-left ${selected ? 'border-ink' : 'border-line hover:border-line-strong'}`}
    >
      <div className="flex items-center gap-3">
        <Avatar name={a.name} label={a.name[0]} color={a.color} size={40} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[15px] font-semibold">{a.name}</div>
          <div className="muted truncate text-[12.5px]">
            {a.roleTitle}
            {a.focus ? ` · ${a.focus}` : ''}
          </div>
        </div>
        <span className={`chip ${a.status === 'active' ? 'chip-ok' : 'chip-mid'}`}>
          {a.status === 'active' ? 'Active' : 'Paused'}
        </span>
      </div>
      <div className="muted text-[12.5px] leading-normal">
        Drafts for <b className="font-medium text-ink">{a.account ? `u/${a.account}` : 'no account yet'}</b> ·{' '}
        {subs}
      </div>
      <div className="grid grid-cols-4 gap-2 border-t border-line-soft pt-3">
        <Stat v={String(a.drafts30d)} l="Drafts · 30d" />
        <Stat v={a.approvalRate === null ? '—' : `${Math.round(a.approvalRate * 100)}%`} l="Approved" />
        <Stat v={String(a.leads)} l="Leads" />
        <Stat v={fmtMoney(a.revenueCents)} l="Revenue" />
      </div>
    </Link>
  );
}

function Stat({ v, l }: { v: string; l: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <b className="num text-base font-semibold tracking-[-0.01em]">{v}</b>
      <span className="text-[11.5px] text-muted">{l}</span>
    </div>
  );
}
