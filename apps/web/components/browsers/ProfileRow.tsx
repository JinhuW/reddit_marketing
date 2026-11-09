'use client';

import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

/**
 * A profile table row that opens the browser drawer when clicked anywhere. The row's own links stay the
 * keyboard and screen-reader path; clicks on them (or on any other control) are left to that control.
 */
export function ProfileRow({
  href,
  selected,
  name,
  children,
}: { href: string; selected: boolean; name: string; children: ReactNode }) {
  const router = useRouter();
  const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('a,button,input,select,textarea,label')) return;
    if (window.getSelection()?.toString()) return; // let people select text in a row
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      window.open(href, '_blank');
      return;
    }
    router.push(href);
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row's profile link is the keyboard path; the row click only widens the mouse target
    <tr
      data-profile={name}
      onClick={onClick}
      className={`cursor-pointer ${selected ? 'bg-surface-3' : 'row-hover'}`}
    >
      {children}
    </tr>
  );
}
