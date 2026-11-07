'use client';

import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { useLiveCounts } from '@/lib/use-live-counts';
import type { ShellCounts } from '@threadline/db/repos/shell';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PlanUsageCard } from './PlanUsageCard';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { NAV, activeNav } from './nav';

const COLLAPSE_KEY = 'tl.sidebar.closed';

export function Sidebar({
  initialCounts,
  me,
  workspaces,
  currentWorkspace,
}: {
  initialCounts: ShellCounts;
  me: { name: string; roleLabel: string };
  workspaces: { name: string; slug: string }[];
  currentWorkspace: { name: string; slug: string };
}) {
  const pathname = usePathname();
  const active = activeNav(pathname);
  const counts = useLiveCounts(initialCounts);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) setClosed(JSON.parse(raw));
    } catch {}
  }, []);
  const toggle = (id: string, open: boolean) => {
    const next = { ...closed, [id]: open };
    setClosed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {}
  };

  const badgeValue = (b?: string) => (b ? (counts as unknown as Record<string, number>)[b] : 0);

  if (collapsed) {
    return (
      <nav
        aria-label="Main"
        className="sticky top-0 flex h-screen w-[64px] flex-none flex-col items-center gap-1 border-r border-line bg-bg py-3"
      >
        <button
          type="button"
          className="ib mb-2"
          aria-label="Expand sidebar"
          onClick={() => setCollapsed(false)}
        >
          <Icon name="panel" />
        </button>
        {NAV.flatMap((g) => g.items).map((it) => (
          <Link
            key={it.id}
            href={it.href}
            aria-label={it.label}
            title={it.label}
            className={`grid h-9 w-9 place-items-center rounded-[10px] border ${active === it.id ? 'border-line bg-surface text-ink' : 'border-transparent text-ink-2 hover:bg-surface-3'}`}
          >
            <Icon name={it.icon} size={15} />
          </Link>
        ))}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Main"
      className="sticky top-0 flex h-screen w-[232px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-line bg-bg px-3 pt-3.5 pb-3 max-lg:hidden"
    >
      <div className="flex items-center gap-2 px-0.5 pb-2.5">
        <button type="button" className="ib" aria-label="Collapse sidebar" onClick={() => setCollapsed(true)}>
          <Icon name="panel" />
        </button>
        <span className="ml-1 grid h-7 w-7 place-items-center rounded-lg bg-accent text-white">
          <Icon name="logo" strokeWidth={1.9} />
        </span>
        <span className="flex-1 text-base font-bold tracking-[-0.01em]">Threadline</span>
        <Link
          href="/settings"
          className="ib relative !border-transparent !bg-transparent"
          aria-label={`Notifications, ${counts.unreadNotifications} unread`}
        >
          <Icon name="bell" />
          {counts.unreadNotifications > 0 ? (
            <span className="absolute top-[7px] right-2 h-[7px] w-[7px] rounded-full border-2 border-bg bg-accent" />
          ) : null}
        </Link>
      </div>

      <WorkspaceSwitcher workspaces={workspaces} current={currentWorkspace} />

      {NAV.map((g) => {
        const hasActive = g.items.some((i) => i.id === active);
        const open =
          closed[g.id] === undefined ? g.id === 'work' || g.id === 'crm' || hasActive : !closed[g.id];
        const groupBadge = g.id === 'work' ? counts.pendingDrafts : 0;
        return (
          <div key={g.id}>
            {g.dividerBefore ? <div className="mx-1 my-2 h-px bg-line" /> : null}
            <button
              type="button"
              className="flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13.5px] font-semibold text-ink hover:bg-surface-3"
              aria-expanded={open}
              onClick={() => toggle(g.id, open)}
            >
              <Icon name={g.icon} />
              <span>{g.label}</span>
              {!open && groupBadge ? (
                <span className="badge ml-1.5 !bg-accent-soft !text-accent">{groupBadge}</span>
              ) : null}
              <Icon name={open ? 'chevUp' : 'chevDown'} size={14} className="ml-auto text-faint" />
            </button>
            {open ? (
              <div className="relative flex flex-col gap-0.5 pt-0.5 pb-1.5 pl-[18px] before:absolute before:top-1 before:bottom-2 before:left-[17px] before:w-px before:bg-line">
                {g.items.map((it) => {
                  const on = it.id === active;
                  const n = badgeValue(it.badge);
                  const badgeCls =
                    it.id === 'opportunities'
                      ? '!bg-accent-soft !text-accent'
                      : it.id === 'conversations'
                        ? '!bg-inverse !text-inverse-ink'
                        : '';
                  return (
                    <Link
                      key={it.id}
                      href={it.href}
                      aria-current={on ? 'page' : undefined}
                      className={`ml-2 flex h-[34px] items-center gap-[9px] rounded-[10px] border px-2.5 text-[13.5px] ${on ? 'border-line bg-surface font-semibold text-ink' : 'border-transparent font-medium text-ink-2 hover:bg-surface-3'}`}
                    >
                      <Icon name={it.icon} size={15} />
                      <span>{it.label}</span>
                      {it.beta ? (
                        <span className="ml-1.5 rounded-[5px] bg-accent-soft px-[5px] text-[10px] leading-[14px] font-bold text-accent">
                          Beta
                        </span>
                      ) : null}
                      {n ? <span className={`badge ${badgeCls}`}>{n}</span> : null}
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="flex-1" />
      <PlanUsageCard plan={counts.plan} usage={counts.usage} />
      <div className="flex items-center gap-2.5 px-1 pt-3 pb-0.5">
        <Avatar name={me.name} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="text-[13px] font-semibold">{me.name}</span>
          <span className="muted text-[11.5px]">{me.roleLabel}</span>
        </span>
      </div>
    </nav>
  );
}
