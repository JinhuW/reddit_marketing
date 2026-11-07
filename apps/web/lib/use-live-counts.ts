'use client';

import type { ShellCounts } from '@threadline/db/repos/shell';
import { useEffect, useState } from 'react';

/** Subscribes to /api/events (SSE) for queue counts; falls back to the server-rendered values. */
export function useLiveCounts(initial: ShellCounts): ShellCounts {
  const [counts, setCounts] = useState(initial);
  useEffect(() => setCounts(initial), [initial]);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events');
    es.addEventListener('counts', (e) => {
      try {
        setCounts(JSON.parse((e as MessageEvent).data));
      } catch {}
    });
    return () => es.close();
  }, []);
  return counts;
}
