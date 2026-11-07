import {
  INTENT_LABEL,
  type Intent,
  type OpportunityStatus,
  OpportunityStatus as STATUSES,
} from '@threadline/shared';
import { Intent as INTENTS } from '@threadline/shared';

export type SP = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined;
const list = (v: string | string[] | undefined) =>
  (one(v) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const DEFAULT_STATUS: OpportunityStatus[] = ['new', 'drafting'];
export const DEFAULT_SCORE = 60;
export const DEFAULT_DAYS = 7;
export const PAGE = 20;

/** URL search params → repository filters. Defaults match the artboard (score ≥ 60, last 7 days, open). */
export function parseFilters(sp: SP) {
  const status = one(sp.status);
  const score = Number(one(sp.score));
  const days = one(sp.days);
  return {
    group: one(sp.group) ?? null,
    subreddits: list(sp.sub),
    intents: list(sp.intent).filter((i): i is Intent => (INTENTS as readonly string[]).includes(i)),
    minScore: Number.isFinite(score) && one(sp.score) !== undefined ? score : DEFAULT_SCORE,
    sinceDays: days === 'all' ? undefined : Number(days) > 0 ? Number(days) : DEFAULT_DAYS,
    statuses:
      status === 'all'
        ? []
        : status
          ? list(sp.status).filter((s): s is OpportunityStatus => (STATUSES as readonly string[]).includes(s))
          : DEFAULT_STATUS,
    q: one(sp.q) ?? null,
    id: one(sp.id) ?? null,
    limit: Math.max(PAGE, Number(one(sp.limit)) || PAGE),
  };
}

export const STATUS_LABEL: Record<OpportunityStatus, string> = {
  new: 'New',
  drafting: 'Drafting',
  replied: 'Replied',
  skipped: 'Skipped',
  watched: 'Watched',
};
export { INTENT_LABEL };
