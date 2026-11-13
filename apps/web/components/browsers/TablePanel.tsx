'use client';

import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

/**
 * The profile list's panel. While a browser drawer is open (`closeHref` set), a click on any part of the panel
 * that is not a profile row and not a control closes the drawer, the way a click on a row opens it.
 */
export function TablePanel({ closeHref, children }: { closeHref: string | null; children: ReactNode }) {
  const router = useRouter();
  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (!closeHref || e.defaultPrevented || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('tr[data-profile],a,button,input,select,textarea,label,summary,details,[role="dialog"]'))
      return;
    if (window.getSelection()?.toString()) return;
    router.push(closeHref, { scroll: false });
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the drawer's Close link is the keyboard path; this only widens the mouse target
    <section className="panel min-w-0" aria-labelledby="profiles-h" onClick={onClick}>
      {children}
    </section>
  );
}
