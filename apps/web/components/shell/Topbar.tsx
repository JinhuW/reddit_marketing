'use client';

import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { RANGES, type RangeKey } from '@/lib/range';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ThemeToggle } from './ThemeToggle';

export function Topbar({ me, canCreateAgent }: { me: { name: string }; canCreateAgent: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const range = (params.get('range') as RangeKey) ?? '7d';
  const searchRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<'range' | 'me' | null>(null);

  // ⌘K / Ctrl+K focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setRange = (r: RangeKey) => {
    const p = new URLSearchParams(params);
    p.set('range', r);
    router.push(`${pathname}?${p.toString()}`);
    setMenu(null);
  };

  return (
    <header className="sticky top-0 z-10 flex h-16 items-center gap-2.5 border-b border-line bg-surface px-6">
      <form
        role="search"
        className="flex h-[34px] max-w-[460px] flex-1 items-center gap-2 rounded-[10px] bg-surface-3 px-3 text-[13px] text-muted"
        onSubmit={(e) => {
          e.preventDefault();
          const q = searchRef.current?.value.trim();
          if (q) router.push(`/opportunities?q=${encodeURIComponent(q)}`);
        }}
      >
        <Icon name="search" size={15} />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search threads, people, drafts"
          aria-label="Search"
          className="flex-1 border-0 bg-transparent text-ink outline-none"
        />
        <kbd>⌘K</kbd>
      </form>
      <div className="flex-1" />
      <div className="relative">
        <button
          type="button"
          className="btn !h-[34px] !rounded-[10px]"
          aria-expanded={menu === 'range'}
          onClick={() => setMenu(menu === 'range' ? null : 'range')}
        >
          <Icon name="calendar" size={15} />
          {RANGES[range]?.label ?? 'Last 7 days'}
          <Icon name="chevDownSm" size={15} />
        </button>
        {menu === 'range' ? (
          <ul className="absolute top-10 right-0 z-30 m-0 w-44 list-none rounded-[12px] border border-line bg-surface p-1">
            {(Object.keys(RANGES) as RangeKey[]).map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => setRange(k)}
                  className={`w-full rounded-[9px] px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-3 ${k === range ? 'font-semibold' : ''}`}
                >
                  {RANGES[k].label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {canCreateAgent ? (
        <Link href="/agents?new=1" className="btn btn-dark !h-[34px] !rounded-[10px]">
          <Icon name="plus" size={15} />
          New agent
        </Link>
      ) : null}
      <ThemeToggle />
      <div className="relative">
        <button
          type="button"
          aria-label={`Account menu, ${me.name}`}
          aria-expanded={menu === 'me'}
          onClick={() => setMenu(menu === 'me' ? null : 'me')}
          className="rounded-full"
        >
          <Avatar name={me.name} size={34} />
        </button>
        {menu === 'me' ? (
          <div className="absolute top-11 right-0 z-30 w-48 rounded-[12px] border border-line bg-surface p-1 text-[13px]">
            <Link href="/settings" className="block rounded-[9px] px-2.5 py-1.5 hover:bg-surface-3">
              Settings
            </Link>
            <form action="/api/auth/signout" method="post">
              <SignOut />
            </form>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function SignOut() {
  const [csrf, setCsrf] = useState('');
  useEffect(() => {
    fetch('/api/auth/csrf')
      .then((r) => r.json())
      .then((d) => setCsrf(d.csrfToken))
      .catch(() => {});
  }, []);
  return (
    <>
      <input type="hidden" name="csrfToken" value={csrf} />
      <input type="hidden" name="callbackUrl" value="/login" />
      <button type="submit" className="w-full rounded-[9px] px-2.5 py-1.5 text-left hover:bg-surface-3">
        Sign out
      </button>
    </>
  );
}
