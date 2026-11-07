export function lastActive(d: Date, now = new Date()): string {
  const m = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const days = Math.round(h / 24);
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}
