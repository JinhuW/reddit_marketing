import Link from 'next/link';

/** Segmented control (artboard `.seg`). Link-based so the choice lives in the URL. */
export function SegLinks({
  label,
  items,
}: {
  label: string;
  items: { key: string; label: string; href: string; active: boolean }[];
}) {
  return (
    <nav aria-label={label} className="inline-flex gap-0.5 rounded-[10px] bg-surface-3 p-[3px]">
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          scroll={false}
          aria-current={it.active ? 'true' : undefined}
          className={`flex h-[26px] items-center rounded-[8px] px-2.5 text-xs font-medium ${it.active ? 'bg-surface text-ink' : 'text-ink-3 hover:text-ink'}`}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

export function SegButtons<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  items: { key: T; label: string }[];
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-[10px] bg-surface-3 p-[3px]"
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="radio"
          aria-checked={value === it.key}
          onClick={() => onChange(it.key)}
          className={`flex h-[26px] items-center rounded-[8px] px-2.5 text-xs font-medium ${value === it.key ? 'bg-surface text-ink' : 'text-ink-3 hover:text-ink'}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function LegendDot({
  color,
  dashed,
  children,
}: { color: string; dashed?: boolean; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
      <i
        className="inline-block h-2.5 w-2.5 rounded-[3px]"
        style={dashed ? { border: `2px dashed ${color}` } : { background: color }}
      />
      {children}
    </span>
  );
}
