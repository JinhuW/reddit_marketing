import Link from 'next/link';

/** Segmented control made of links (state lives in the URL). */
export function Seg({
  items,
  label,
  className = '',
}: {
  items: { href: string; label: string; active: boolean; count?: number }[];
  label: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={`inline-flex gap-0.5 rounded-[10px] bg-surface-3 p-[3px] ${className}`}
    >
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          scroll={false}
          aria-current={it.active ? 'page' : undefined}
          className={`flex h-7 flex-1 items-center justify-center gap-1 rounded-lg px-3 text-[12.5px] font-medium whitespace-nowrap ${it.active ? 'border border-line bg-surface text-ink' : 'text-ink-3 hover:text-ink'}`}
        >
          {it.label}
          {it.count !== undefined ? <span className="num text-muted">{it.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
