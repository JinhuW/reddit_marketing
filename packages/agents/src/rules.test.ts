import { describe, expect, it } from 'vitest';
import {
  PolicyError,
  type RuleContext,
  assertOneAccountPerMember,
  assertPublishable,
  blockingFailures,
  canApprove,
  containsDisclosure,
  evaluateDraft,
  linksAllowedToday,
  proxyRegionMismatch,
} from './rules';

// Saturday, Nov 7 2026, 14:00 UTC
const SAT = new Date('2026-11-07T14:00:00Z');
const MON = new Date('2026-11-09T14:00:00Z');
const DISCLOSURE = 'Disclosure: I work on Acme';

function ctx(over: Partial<RuleContext> = {}, draft: Partial<RuleContext['draft']> = {}): RuleContext {
  return {
    now: SAT,
    draft: {
      type: 'comment',
      body: `We had the same issue with guest access. ${DISCLOSURE}. Happy to answer questions.`,
      promotional: true,
      ...draft,
    },
    account: {
      disclosureLine: DISCLOSURE,
      dailyPostLimit: 8,
      postedToday: 3,
      karma: 4200,
      accountCreatedAt: new Date('2019-01-01'),
      health: 'healthy',
      selfPromoMax: 30,
      promoItems7d: 2,
      totalItems7d: 20,
    },
    subreddit: {
      name: 'projectmanagement',
      linkRule: 'one_per_comment',
      minKarma: 100,
      minAccountAgeDays: 30,
    },
    post: { postedAt: new Date(SAT.getTime() - 3 * 3_600_000) },
    conversation: null,
    competitors: ['Asana', 'ClickUp'],
    ...over,
  };
}
const get = (c: RuleContext, key: string) => evaluateDraft(c).find((r) => r.key === key);

describe('disclosure (block)', () => {
  it('passes when the disclosure line is present (case-insensitive)', () => {
    expect(get(ctx({}, { body: 'Great question. disclosure: i WORK on acme!' }), 'disclosure')?.passed).toBe(
      true,
    );
  });
  it('passes on a near match with typographic quotes / punctuation', () => {
    expect(containsDisclosure('Disclosure — I work on Acme.', DISCLOSURE)).toBe(true);
  });
  it('fails when missing', () => {
    const r = get(ctx({}, { body: 'Try Acme, it is great.' }), 'disclosure');
    expect(r).toMatchObject({ level: 'block', passed: false });
  });
  it('requires it in the first DM of a conversation only', () => {
    const first = ctx(
      { conversation: { inboundCount: 1, isFirstOutbound: true } },
      { type: 'dm', body: 'Hi!' },
    );
    expect(get(first, 'disclosure')?.passed).toBe(false);
    const later = ctx(
      { conversation: { inboundCount: 2, isFirstOutbound: false } },
      { type: 'dm', body: 'Hi!' },
    );
    expect(get(later, 'disclosure')?.passed).toBe(true);
  });
});

describe('link rule (block)', () => {
  it('passes with one link where one is allowed', () => {
    expect(get(ctx({}, { body: `${DISCLOSURE} https://go.acme.com/r/Ab12Cd` }), 'link_rule')?.passed).toBe(
      true,
    );
  });
  it('fails with two links where one is allowed', () => {
    const r = get(ctx({}, { body: `${DISCLOSURE} https://a.com https://b.com` }), 'link_rule');
    expect(r).toMatchObject({ level: 'block', passed: false });
  });
  it('fails with any link where none are allowed', () => {
    const c = ctx(
      { subreddit: { name: 'SaaS', linkRule: 'none', minKarma: 0, minAccountAgeDays: 0 } },
      { body: `${DISCLOSURE} www.acme.com` },
    );
    expect(get(c, 'link_rule')?.passed).toBe(false);
  });
  it('allows one link on Saturdays only for the saturdays rule', () => {
    expect(linksAllowedToday('saturdays', SAT)).toBe(1);
    expect(linksAllowedToday('saturdays', MON)).toBe(0);
  });
});

describe('daily limit (block)', () => {
  it('passes under the limit', () => expect(get(ctx(), 'daily_limit')?.passed).toBe(true));
  it('fails at the limit', () => {
    const c = ctx();
    c.account.postedToday = 8;
    expect(get(c, 'daily_limit')).toMatchObject({ level: 'block', passed: false });
  });
});

describe('account eligible (block)', () => {
  it('passes for an established healthy account', () =>
    expect(get(ctx(), 'account_eligible')?.passed).toBe(true));
  it('fails on low karma', () => {
    const c = ctx();
    c.account.karma = 10;
    expect(get(c, 'account_eligible')?.passed).toBe(false);
  });
  it('fails on young account', () => {
    const c = ctx();
    c.account.accountCreatedAt = new Date(SAT.getTime() - 5 * 86_400_000);
    expect(get(c, 'account_eligible')?.passed).toBe(false);
  });
  it('fails when health is blocked', () => {
    const c = ctx();
    c.account.health = 'blocked';
    expect(get(c, 'account_eligible')?.passed).toBe(false);
  });
});

describe('DM only after engagement (block)', () => {
  it('passes with an inbound message', () => {
    const c = ctx(
      { conversation: { inboundCount: 1, isFirstOutbound: true } },
      { type: 'dm', body: `Thanks! ${DISCLOSURE}` },
    );
    expect(get(c, 'dm_after_engagement')?.passed).toBe(true);
  });
  it('fails without any inbound message', () => {
    const c = ctx(
      { conversation: { inboundCount: 0, isFirstOutbound: true } },
      { type: 'dm', body: `Hi ${DISCLOSURE}` },
    );
    expect(get(c, 'dm_after_engagement')).toMatchObject({ level: 'block', passed: false });
    expect(canApprove(evaluateDraft(c))).toBe(false);
  });
  it('fails with no conversation at all', () => {
    const c = ctx({ conversation: null }, { type: 'dm', body: `Hi ${DISCLOSURE}` });
    expect(get(c, 'dm_after_engagement')?.passed).toBe(false);
  });
});

describe('self-promo ratio (warn)', () => {
  it('passes under the max', () => expect(get(ctx(), 'self_promo_ratio')?.passed).toBe(true));
  it('warns over the max but does not block', () => {
    const c = ctx();
    c.account.selfPromoMax = 10;
    c.account.promoItems7d = 5;
    c.account.totalItems7d = 10;
    const checks = evaluateDraft(c);
    expect(checks.find((r) => r.key === 'self_promo_ratio')).toMatchObject({ level: 'warn', passed: false });
    expect(canApprove(checks)).toBe(true);
  });
});

describe('thread age (warn)', () => {
  it('passes for a fresh thread', () => expect(get(ctx(), 'thread_age')?.passed).toBe(true));
  it('warns after 48h', () => {
    expect(
      get(ctx({ post: { postedAt: new Date(SAT.getTime() - 72 * 3_600_000) } }), 'thread_age'),
    ).toMatchObject({
      level: 'warn',
      passed: false,
    });
  });
});

describe('competitor pricing (warn)', () => {
  it('passes without a price near a competitor', () => {
    expect(get(ctx({}, { body: `Asana is solid. ${DISCLOSURE}` }), 'competitor_pricing')?.passed).toBe(true);
  });
  it('warns when a competitor sits within 40 chars of a price', () => {
    const r = get(ctx({}, { body: `Asana costs $24/user now. ${DISCLOSURE}` }), 'competitor_pricing');
    expect(r).toMatchObject({ level: 'warn', passed: false });
  });
});

describe('human approval (block)', () => {
  const approved = { status: 'approved' as const, approverMemberId: 'm1', approvedAt: SAT };
  it('allows an approved draft with an approver who could approve', () => {
    expect(() => assertPublishable(approved, true, evaluateDraft(ctx()), SAT)).not.toThrow();
  });
  it('refuses a pending draft', () => {
    expect(() => assertPublishable({ ...approved, status: 'pending' }, true, [], SAT)).toThrow(PolicyError);
  });
  it('refuses a draft without an approver', () => {
    expect(() => assertPublishable({ ...approved, approverMemberId: null }, true, [], SAT)).toThrow(
      /no approver/,
    );
  });
  it('refuses when the approver lacked rights', () => {
    expect(() => assertPublishable(approved, false, [], SAT)).toThrow(/approval rights/);
  });
  it('refuses a scheduled draft before its time', () => {
    const d = { ...approved, status: 'scheduled' as const, scheduledFor: new Date(SAT.getTime() + 60_000) };
    expect(() => assertPublishable(d, true, [], SAT)).toThrow(/Scheduled/);
  });
  it('refuses when a block rule fails at post time', () => {
    const c = ctx();
    c.account.postedToday = 99;
    expect(() => assertPublishable(approved, true, evaluateDraft(c), SAT)).toThrow(/block rules/);
    expect(blockingFailures(evaluateDraft(c)).map((f) => f.key)).toContain('daily_limit');
  });
});

describe('one account per person (block)', () => {
  it('allows the first account', () => expect(() => assertOneAccountPerMember(null)).not.toThrow());
  it('refuses a second', () =>
    expect(() => assertOneAccountPerMember({ username: 'jane_from_acme' })).toThrow(/already own/));
});

describe('proxy region mismatch (warn)', () => {
  it('passes when the exit time zone matches the owner', () =>
    expect(
      proxyRegionMismatch({ country: 'US', timeZone: 'America/New_York' }, 'America/New_York').mismatch,
    ).toBe(false));
  it('flags New York exit for an Austin (America/Chicago) owner', () =>
    expect(
      proxyRegionMismatch({ country: 'US', timeZone: 'America/New_York' }, 'America/Chicago').mismatch,
    ).toBe(true));
  it('falls back to country when the exit time zone is unknown', () =>
    expect(proxyRegionMismatch({ country: 'DE' }, 'America/Los_Angeles').mismatch).toBe(true));
});
