/**
 * Policy guardrails — docs/PLAN.md §10. These are enforced in code:
 * - evaluateDraft() runs when a draft is generated, edited and approved;
 * - post.publish re-runs it at post time and calls assertPublishable().
 * A failed `block` rule means the draft cannot be approved or posted.
 * NEVER weaken a block rule. Every rule has a pass and a fail case in rules.test.ts.
 */
import type { AccountHealth, DraftStatus, DraftType, LinkRule } from '@threadline/shared';
import type { RuleCheck } from '@threadline/shared';

export interface RuleContext {
  now: Date;
  /** IANA zone used for "today" (daily limit, Saturday link rule). */
  timeZone?: string;
  draft: {
    type: DraftType;
    body: string;
    /** Whether this item is promotional (mentions/links the product). */
    promotional: boolean;
  };
  account: {
    disclosureLine: string;
    dailyPostLimit: number;
    /** Items already posted by this account today (excluding this draft). */
    postedToday: number;
    karma: number;
    accountCreatedAt: Date | null;
    health: AccountHealth;
    /** percent 0-100 */
    selfPromoMax: number;
    /** last 7 days, excluding this draft */
    promoItems7d: number;
    totalItems7d: number;
  };
  /** Short-link host for this workspace (counted as a link even without a path). */
  shortHost?: string | null;
  subreddit?: {
    name: string;
    linkRule: LinkRule;
    minKarma: number;
    minAccountAgeDays: number;
  } | null;
  post?: { postedAt: Date } | null;
  conversation?: {
    inboundCount: number;
    /** True when no outbound message has been sent in this conversation yet. */
    isFirstOutbound: boolean;
  } | null;
  competitors?: string[];
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’'`"“”]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Fuzzy, case-insensitive disclosure match. Exact normalized containment passes; otherwise
 * at least 85% of the disclosure's words must appear in the body, in order.
 */
export function containsDisclosure(body: string, disclosure: string): boolean {
  const d = normalize(disclosure);
  if (!d) return false;
  const b = normalize(body);
  if (b.includes(d)) return true;
  const want = d.split(' ');
  const have = b.split(' ');
  let i = 0;
  let hits = 0;
  for (const w of want) {
    const at = have.indexOf(w, i);
    if (at !== -1) {
      hits++;
      i = at + 1;
    }
  }
  return want.length >= 3 && hits / want.length >= 0.85;
}

/**
 * Counts links the way a moderator would: http(s) URLs, www. hosts, and bare `domain.tld/path` links
 * (e.g. `acme.so/r/pm-6team`). A bare domain without a path ("Node.js", "acme.so") is not counted
 * unless it is one of `extraHosts` (e.g. the workspace's short-link host).
 */
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\/[^\s)>\]]*/gi;
export function countLinks(body: string, extraHosts: string[] = []): number {
  let n = (body.match(URL_RE) ?? []).length;
  const rest = body.replace(URL_RE, ' ');
  for (const h of extraHosts) {
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    n += (rest.match(new RegExp(`(?<![\\w.-])${esc}(?![\\w-])`, 'gi')) ?? []).length;
  }
  return n;
}

function weekdayIn(now: Date, timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(now);
}

/** Links allowed in one item today under the subreddit's link rule. */
export function linksAllowedToday(rule: LinkRule, now: Date, timeZone?: string): number {
  switch (rule) {
    case 'none':
      return 0;
    case 'one_per_comment':
      return 1;
    case 'saturdays':
      return weekdayIn(now, timeZone) === 'Sat' ? 1 : 0;
    case 'allowed':
      return Number.POSITIVE_INFINITY;
  }
}

const PRICE_RE =
  /(?:[$€£]\s?\d[\d,.]*(?:\s?(?:k|\/mo|\/month|\/user|per\s+(?:month|user|seat)))?|\b\d[\d,.]*\s?(?:usd|dollars|bucks)\b)/gi;

export function competitorPricingClaims(body: string, competitors: string[]): string[] {
  const found = new Set<string>();
  const lower = body.toLowerCase();
  const prices = [...body.matchAll(PRICE_RE)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  for (const c of competitors) {
    const name = c.toLowerCase().trim();
    if (!name) continue;
    let at = lower.indexOf(name);
    while (at !== -1) {
      const end = at + name.length;
      if (prices.some((p) => p.start - end <= 40 && at - p.end <= 40)) found.add(c);
      at = lower.indexOf(name, at + 1);
    }
  }
  return [...found];
}

const DAY = 86_400_000;

export function evaluateDraft(ctx: RuleContext): RuleCheck[] {
  const { draft, account, subreddit, post, conversation, now } = ctx;
  const checks: RuleCheck[] = [];

  // Disclosure present — block
  {
    const needs = draft.type !== 'dm' || (conversation?.isFirstOutbound ?? true);
    const ok = !needs || containsDisclosure(draft.body, account.disclosureLine);
    checks.push({
      key: 'disclosure',
      label: 'Disclosure present',
      level: 'block',
      passed: ok,
      detail: !needs
        ? 'Not the first message in this conversation; disclosure was already given.'
        : ok
          ? `Contains “${account.disclosureLine}”.`
          : `Add the account’s disclosure line: “${account.disclosureLine}”.`,
    });
  }

  // Subreddit link rule — block (comments and posts; DMs are not subject to sub rules)
  if (draft.type !== 'dm' && subreddit) {
    const allowed = linksAllowedToday(subreddit.linkRule, now, ctx.timeZone);
    const n = countLinks(draft.body, ctx.shortHost ? [ctx.shortHost] : []);
    checks.push({
      key: 'link_rule',
      label: 'Subreddit link rule',
      level: 'block',
      passed: n <= allowed,
      detail:
        allowed === Number.POSITIVE_INFINITY
          ? `r/${subreddit.name} allows links.`
          : `${n} link${n === 1 ? '' : 's'} · r/${subreddit.name} allows ${allowed} today.`,
    });
  }

  // Daily posting limit — block
  checks.push({
    key: 'daily_limit',
    label: 'Daily posting limit',
    level: 'block',
    passed: account.postedToday < account.dailyPostLimit,
    detail: `${account.postedToday} of ${account.dailyPostLimit} posted today.`,
  });

  // Account eligible — block
  {
    const ageDays = account.accountCreatedAt
      ? Math.floor((now.getTime() - account.accountCreatedAt.getTime()) / DAY)
      : 0;
    const problems: string[] = [];
    if (account.health === 'blocked') problems.push('account health is blocked');
    if (subreddit && account.karma < subreddit.minKarma)
      problems.push(`karma ${account.karma} < ${subreddit.minKarma}`);
    if (subreddit && ageDays < subreddit.minAccountAgeDays)
      problems.push(`age ${ageDays}d < ${subreddit.minAccountAgeDays}d`);
    checks.push({
      key: 'account_eligible',
      label: 'Account eligible',
      level: 'block',
      passed: problems.length === 0,
      detail: problems.length
        ? `Not eligible: ${problems.join(', ')}.`
        : 'Karma, age and health meet the subreddit’s minimums.',
    });
  }

  // DM only after engagement — block
  if (draft.type === 'dm') {
    const inbound = conversation?.inboundCount ?? 0;
    checks.push({
      key: 'dm_after_engagement',
      label: 'DM only after engagement',
      level: 'block',
      passed: inbound > 0,
      detail:
        inbound > 0
          ? `${inbound} inbound message${inbound === 1 ? '' : 's'} from this person.`
          : 'This person has not messaged or replied to us. DMs need prior inbound engagement.',
    });
  }

  // Self-promo ratio — warn
  {
    const promo = account.promoItems7d + (draft.promotional ? 1 : 0);
    const total = account.totalItems7d + 1;
    const pct = Math.round((promo / total) * 100);
    checks.push({
      key: 'self_promo_ratio',
      label: 'Self-promo ratio',
      level: 'warn',
      passed: pct <= account.selfPromoMax,
      detail: `${pct}% promotional over 7 days after this post (max ${account.selfPromoMax}%).`,
    });
  }

  // Thread age — warn
  if (post && draft.type !== 'dm') {
    const hours = Math.floor((now.getTime() - post.postedAt.getTime()) / 3_600_000);
    checks.push({
      key: 'thread_age',
      label: 'Thread age',
      level: 'warn',
      passed: hours <= 48,
      detail:
        hours <= 48
          ? `Thread is ${hours}h old.`
          : `Thread is ${hours}h old; replies after 48h get little reach.`,
    });
  }

  // Competitor pricing claims — warn
  {
    const hits = competitorPricingClaims(draft.body, ctx.competitors ?? []);
    checks.push({
      key: 'competitor_pricing',
      label: 'Competitor pricing claims',
      level: 'warn',
      passed: hits.length === 0,
      detail: hits.length
        ? `Price claim near ${hits.join(', ')}. Double-check it is current.`
        : 'No competitor price claims.',
    });
  }

  return checks;
}

export const blockingFailures = (checks: RuleCheck[]) =>
  checks.filter((c) => c.level === 'block' && !c.passed);
export const warnings = (checks: RuleCheck[]) => checks.filter((c) => c.level === 'warn' && !c.passed);
export const canApprove = (checks: RuleCheck[]) => blockingFailures(checks).length === 0;

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly failures: string[] = [],
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * Human approval — block. post.publish calls this before any Reddit call.
 * A draft is publishable only when approved/scheduled, has an approver who could approve
 * at approval time, and passes every block rule re-evaluated at post time.
 */
export function assertPublishable(
  draft: {
    status: DraftStatus;
    approverMemberId: string | null;
    approvedAt: Date | null;
    scheduledFor?: Date | null;
  },
  approverCouldApprove: boolean,
  checksAtPostTime: RuleCheck[],
  now: Date,
): void {
  if (draft.status !== 'approved' && draft.status !== 'scheduled')
    throw new PolicyError(`Draft is ${draft.status}; only approved or scheduled drafts can be posted.`);
  if (!draft.approverMemberId || !draft.approvedAt) throw new PolicyError('Draft has no approver.');
  if (!approverCouldApprove) throw new PolicyError('Approver did not have approval rights.');
  if (draft.status === 'scheduled' && draft.scheduledFor && draft.scheduledFor > now)
    throw new PolicyError('Scheduled time has not arrived.');
  const fails = blockingFailures(checksAtPostTime);
  if (fails.length)
    throw new PolicyError(
      'Draft fails block rules at post time.',
      fails.map((f) => f.key),
    );
}

/** One account per person — block. Used by the connect flow before creating a RedditAccount. */
export function assertOneAccountPerMember(existingAccountForMember: { username: string } | null): void {
  if (existingAccountForMember)
    throw new PolicyError(
      `You already own u/${existingAccountForMember.username}. Each person can connect one Reddit account.`,
    );
}

/**
 * Proxy region mismatch — warn (Browsers screen). Compares the proxy exit location (GeoLite2:
 * country + time zone) with the owner's fingerprint time zone. Same time zone passes; a different
 * time zone or a different country is a mismatch.
 */
const TZ_COUNTRY: Record<string, string> = {
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Phoenix': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'Europe/London': 'GB',
  'Europe/Berlin': 'DE',
  'Europe/Paris': 'FR',
  'Europe/Madrid': 'ES',
  'Europe/Amsterdam': 'NL',
  'Europe/Lisbon': 'PT',
  'Asia/Singapore': 'SG',
  'Asia/Tokyo': 'JP',
  'Australia/Sydney': 'AU',
};
export function proxyRegionMismatch(
  exit: { country?: string | null; timeZone?: string | null } | null | undefined,
  fingerprintTz: string | null | undefined,
): { mismatch: boolean; reason: string | null } {
  if (!exit || !fingerprintTz) return { mismatch: false, reason: null };
  if (exit.timeZone)
    return exit.timeZone === fingerprintTz
      ? { mismatch: false, reason: null }
      : { mismatch: true, reason: `Exit time zone ${exit.timeZone} ≠ owner ${fingerprintTz}` };
  const expected = TZ_COUNTRY[fingerprintTz];
  if (exit.country && expected && expected !== exit.country.toUpperCase())
    return { mismatch: true, reason: `Exit country ${exit.country} ≠ owner ${expected}` };
  return { mismatch: false, reason: null };
}
