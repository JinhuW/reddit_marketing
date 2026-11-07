import type { ReactNode } from 'react';

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="min-w-[240px] flex-1">
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">{title}</h1>
        {sub ? <div className="muted mt-1 text-[13px]">{sub}</div> : null}
      </div>
      {actions}
    </div>
  );
}
