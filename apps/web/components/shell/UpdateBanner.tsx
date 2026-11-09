'use client';

import { useEffect, useState } from 'react';

const POLL_MS = 60_000;

/**
 * Shows a banner across the top of every page once a newer build is deployed, so nobody keeps working on stale
 * JavaScript. It compares the build id baked into this bundle with /api/version and asks for a full reload.
 */
export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = process.env.NEXT_PUBLIC_BUILD_ID;
    if (!mine) return;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const { buildId } = (await res.json()) as { buildId: string | null };
        if (buildId && buildId !== mine) {
          setStale(true);
          stopped = true;
        }
      } catch {
        // offline or mid-deploy: try again on the next tick
      }
    };
    void check();
    const t = setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="alert"
      data-testid="update-banner"
      className="sticky top-0 z-50 flex items-center justify-center gap-3 border-b border-line bg-[var(--warn-soft)] px-4 py-2 text-[13px] text-ink"
    >
      <span>A new version of Threadline is available. Reload to get the latest changes.</span>
      <button type="button" className="btn btn-primary !h-7" onClick={() => window.location.reload()}>
        Reload now
      </button>
    </div>
  );
}
