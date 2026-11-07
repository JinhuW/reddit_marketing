const nf = new Intl.NumberFormat('en-US');
export const fmtInt = (n: number) => nf.format(n);
export const fmtMoney = (cents: number, opts: { compact?: boolean } = {}) => {
  const dollars = cents / 100;
  if (opts.compact && dollars >= 10_000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${nf.format(Math.round(dollars))}`;
};
export const fmtPct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;

/** "3h", "12m", "2d" — compact relative age used throughout the mockups. */
export function ago(date: Date | string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export const initials = (name: string) =>
  name
    .replace(/^u\//, '')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
