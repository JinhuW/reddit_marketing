import { ago } from '@threadline/shared';

/** "26m", "3h", "2d" for recent activity; "Nov 2" after three days (as in the artboards). */
export function lastTouch(d: Date, now = new Date()): string {
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 3) return ago(d, now);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const shortDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const money = (cents: number) => (cents ? `$${Math.round(cents / 100).toLocaleString('en-US')}` : '—');

export const scoreChip = (score: number) => (score >= 80 ? 'chip chip-hot' : 'chip chip-mid');
export const scoreLevel = (score: number) => (score >= 80 ? 'High' : score >= 60 ? 'Medium' : 'Low');
