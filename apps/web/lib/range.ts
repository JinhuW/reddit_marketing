export const RANGES = {
  '24h': { label: 'Last 24 hours', days: 1 },
  '7d': { label: 'Last 7 days', days: 7 },
  '30d': { label: 'Last 30 days', days: 30 },
  '90d': { label: 'Last 90 days', days: 90 },
} as const;
export type RangeKey = keyof typeof RANGES;

export function parseRange(v: string | string[] | undefined): {
  key: RangeKey;
  days: number;
  since: Date;
  label: string;
} {
  const key = (typeof v === 'string' && v in RANGES ? v : '7d') as RangeKey;
  const days = RANGES[key].days;
  return { key, days, since: new Date(Date.now() - days * 86_400_000), label: RANGES[key].label };
}
