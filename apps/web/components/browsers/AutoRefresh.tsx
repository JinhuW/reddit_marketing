'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-reads the server-rendered page every `ms` while the tab is visible (live profile and node status). */
export function AutoRefresh({ ms = 10_000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, ms);
    return () => clearInterval(t);
  }, [ms, router]);
  return null;
}
