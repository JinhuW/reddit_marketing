'use client';

import { useEffect, useState } from 'react';

/**
 * This device's user agent, screen, time zone, languages and OS as JSON for a hidden `fingerprint` field.
 * Captured once, in the person's real browser, so the browser profile matches their device. '' until mounted.
 */
export function useDeviceFingerprint(): string {
  const [fingerprint, setFingerprint] = useState('');
  useEffect(() => {
    try {
      setFingerprint(
        JSON.stringify({
          userAgent: navigator.userAgent,
          screen: `${screen.width}×${screen.height}`,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: navigator.languages?.join(', ') || navigator.language,
          os:
            (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
            navigator.platform,
        }),
      );
    } catch {}
  }, []);
  return fingerprint;
}
