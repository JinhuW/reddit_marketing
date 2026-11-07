'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/settings/team', label: 'Team and roles' },
  { href: '/settings/audit', label: 'Audit log' },
  { href: '/settings/billing', label: 'Billing' },
  { href: '/settings/workspaces', label: 'Client workspaces' },
  { href: '/settings/reports', label: 'Weekly report' },
];

export function SettingsNav() {
  const path = usePathname();
  const active = path === '/settings' ? '/settings/team' : path;
  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5 lg:sticky lg:top-20">
      <h1 className="m-0 mb-2.5 px-3 text-lg font-semibold">Settings</h1>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={active === l.href ? 'page' : undefined}
          className={`flex h-[34px] items-center rounded-[10px] border px-3 text-[13.5px] ${active === l.href ? 'border-line bg-surface font-semibold text-ink' : 'border-transparent font-medium text-ink-2 hover:bg-surface-3'}`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
