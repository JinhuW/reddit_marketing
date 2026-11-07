/** Last-click attribution (docs/PLAN.md §5 step 7, §14 default: last click within 30 days). */
export const ATTRIBUTION_WINDOW_DAYS = 30;

export interface ClickLike {
  trackedLinkId: string;
  visitorId: string;
  occurredAt: Date;
}

/** The last click by this visitor at or before the event, within the window; null when none. */
export function lastClick<T extends ClickLike>(
  event: { visitorId: string | null; occurredAt: Date },
  clicks: T[],
  windowDays = ATTRIBUTION_WINDOW_DAYS,
): T | null {
  if (!event.visitorId) return null;
  const from = event.occurredAt.getTime() - windowDays * 86_400_000;
  let best: T | null = null;
  for (const c of clicks) {
    if (c.visitorId !== event.visitorId) continue;
    const t = c.occurredAt.getTime();
    if (t > event.occurredAt.getTime() || t < from) continue;
    if (!best || t > best.occurredAt.getTime()) best = c;
  }
  return best;
}

/** Stage a lead should move to after an attributed event; never moves a lead backwards. */
const ORDER = ['new', 'engaged', 'replied', 'interested', 'trial', 'customer'] as const;
export function stageAfterEvent(current: string, kind: 'signup' | 'trial' | 'payment' | 'pageview'): string {
  const target = kind === 'payment' ? 'customer' : kind === 'trial' || kind === 'signup' ? 'trial' : null;
  if (!target || current === 'lost')
    return current === 'lost' && target === 'customer' ? 'customer' : current;
  return ORDER.indexOf(target) > ORDER.indexOf(current as (typeof ORDER)[number]) ? target : current;
}
