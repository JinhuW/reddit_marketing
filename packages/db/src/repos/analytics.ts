// Repository functions for the Analytics screen (docs/PLAN.md §5 step 7, §6, §7 row 7).
//
// Attribution model: last click within 30 days. A SiteEvent is attributed to the TrackedLink on its
// Attribution row (written by attribution.rollup); events the rollup has not processed yet fall back to
// the visitor's last ClickEvent in the 30 days before the event, so the screen is never behind the job.
import { Prisma } from '@prisma/client';
import { prisma } from '../client';

const DAY = 86_400_000;
const WINDOW_DAYS = 30;

export type BreakdownBy = 'subreddit' | 'keyword' | 'thread' | 'agent' | 'account';
export const BREAKDOWNS: { key: BreakdownBy; label: string }[] = [
  { key: 'subreddit', label: 'Subreddit' },
  { key: 'keyword', label: 'Keyword' },
  { key: 'thread', label: 'Thread' },
  { key: 'agent', label: 'Agent' },
  { key: 'account', label: 'Account' },
];

interface Totals {
  clicks: number;
  visitors: number;
  signups: number;
  customers: number;
  revenueCents: number;
  replies: number;
}

interface EventRow {
  link_id: string | null;
  kind: 'signup' | 'trial' | 'payment';
  amount: number;
  customer: string;
  day: Date;
}

/** Attributed signup / trial / payment events in [since, until). */
async function attributedEvents(workspaceId: string, since: Date, until: Date): Promise<EventRow[]> {
  return prisma
    .$queryRaw<EventRow[]>(Prisma.sql`
    SELECT COALESCE(a."trackedLinkId", lc."trackedLinkId") AS link_id,
           e.kind::text AS kind,
           e."amountCents"::int AS amount,
           COALESCE(e.email, e."visitorId", e.id) AS customer,
           date_trunc('day', e."occurredAt") AS day
    FROM "SiteEvent" e
    LEFT JOIN "Attribution" a ON a."siteEventId" = e.id AND a.model = 'last_click'
    LEFT JOIN LATERAL (
      SELECT c."trackedLinkId" FROM "ClickEvent" c
      WHERE a.id IS NULL AND e."visitorId" IS NOT NULL
        AND c."workspaceId" = e."workspaceId" AND c."visitorId" = e."visitorId"
        AND c."occurredAt" <= e."occurredAt"
        AND c."occurredAt" > e."occurredAt" - (${WINDOW_DAYS} * interval '1 day')
      ORDER BY c."occurredAt" DESC LIMIT 1
    ) lc ON true
    WHERE e."workspaceId" = ${workspaceId}
      AND e."occurredAt" >= ${since} AND e."occurredAt" < ${until}
      AND e.kind IN ('signup', 'trial', 'payment')
  `)
    .then((rows) => rows.filter((r) => r.link_id !== null));
}

async function totals(workspaceId: string, since: Date, until: Date): Promise<Totals> {
  const [clickAgg, events, replies] = await Promise.all([
    prisma.$queryRaw<{ clicks: bigint; visitors: bigint }[]>(Prisma.sql`
      SELECT count(*) AS clicks, count(DISTINCT "visitorId") AS visitors FROM "ClickEvent"
      WHERE "workspaceId" = ${workspaceId} AND "occurredAt" >= ${since} AND "occurredAt" < ${until}`),
    attributedEvents(workspaceId, since, until),
    prisma.draft.count({ where: { workspaceId, status: 'posted', postedAt: { gte: since, lt: until } } }),
  ]);
  const payments = events.filter((e) => e.kind === 'payment');
  return {
    clicks: Number(clickAgg[0]?.clicks ?? 0),
    visitors: Number(clickAgg[0]?.visitors ?? 0),
    signups: events.filter((e) => e.kind !== 'payment').length,
    customers: new Set(payments.map((p) => p.customer)).size,
    revenueCents: payments.reduce((s, p) => s + p.amount, 0),
    replies,
  };
}

export interface Kpi {
  key: string;
  label: string;
  value: number;
  /** cents for money KPIs */
  money?: boolean;
  /** relative change vs the prior period; null when the prior period is zero */
  delta: number | null;
}

/** KPI row with deltas vs the prior period of equal length. */
export async function kpis(workspaceId: string, since: Date, until: Date = new Date()): Promise<Kpi[]> {
  const len = until.getTime() - since.getTime();
  const prevSince = new Date(since.getTime() - len);
  const [cur, prev] = await Promise.all([
    totals(workspaceId, since, until),
    totals(workspaceId, prevSince, since),
  ]);
  const rpr = (t: Totals) => (t.replies ? t.revenueCents / t.replies : 0);
  const d = (a: number, b: number) => (b ? (a - b) / b : null);
  return [
    { key: 'clicks', label: 'Clicks', value: cur.clicks, delta: d(cur.clicks, prev.clicks) },
    { key: 'visitors', label: 'Unique visitors', value: cur.visitors, delta: d(cur.visitors, prev.visitors) },
    { key: 'signups', label: 'Signups', value: cur.signups, delta: d(cur.signups, prev.signups) },
    { key: 'customers', label: 'Customers', value: cur.customers, delta: d(cur.customers, prev.customers) },
    {
      key: 'revenue',
      label: 'Revenue',
      value: cur.revenueCents,
      money: true,
      delta: d(cur.revenueCents, prev.revenueCents),
    },
    { key: 'rpr', label: 'Revenue per reply', value: rpr(cur), money: true, delta: d(rpr(cur), rpr(prev)) },
  ];
}

// ───────── dimensions ─────────

interface LinkDims {
  id: string;
  subreddit: string | null;
  keyword: string | null;
  thread: string | null;
  agent: string | null;
  account: string | null;
}

async function linkDims(workspaceId: string): Promise<Map<string, LinkDims>> {
  const links = await prisma.trackedLink.findMany({
    where: { workspaceId },
    select: {
      id: true,
      subreddit: { select: { name: true } },
      post: {
        select: { title: true, opportunity: { select: { keywordGroup: { select: { name: true } } } } },
      },
      agent: { select: { name: true, account: { select: { username: true } } } },
    },
  });
  return new Map(
    links.map((l) => [
      l.id,
      {
        id: l.id,
        subreddit: l.subreddit ? `r/${l.subreddit.name}` : null,
        keyword: l.post?.opportunity?.keywordGroup?.name ?? null,
        thread: l.post?.title ?? null,
        agent: l.agent?.name ?? null,
        account: l.agent?.account ? `u/${l.agent.account.username}` : null,
      },
    ]),
  );
}

const OTHER: Record<BreakdownBy, string> = {
  subreddit: 'DMs and other',
  keyword: 'No keyword group',
  thread: 'No thread',
  agent: 'No agent',
  account: 'No account',
};

export interface BreakdownRow {
  name: string;
  replies: number;
  clicks: number;
  signups: number;
  customers: number;
  revenueCents: number;
}

async function clicksByLink(workspaceId: string, since: Date, until: Date) {
  const rows = await prisma.clickEvent.groupBy({
    by: ['trackedLinkId'],
    where: { workspaceId, occurredAt: { gte: since, lt: until } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.trackedLinkId, r._count._all]));
}

async function repliesByDim(workspaceId: string, by: BreakdownBy, since: Date, until: Date) {
  const posted = await prisma.draft.findMany({
    where: { workspaceId, status: 'posted', postedAt: { gte: since, lt: until } },
    select: {
      agent: { select: { name: true } },
      account: { select: { username: true } },
      opportunity: {
        select: {
          keywordGroup: { select: { name: true } },
          post: { select: { title: true, subreddit: { select: { name: true } } } },
        },
      },
      trackedLink: { select: { subreddit: { select: { name: true } } } },
    },
  });
  const out = new Map<string, number>();
  for (const d of posted) {
    const sub = d.opportunity?.post.subreddit.name ?? d.trackedLink?.subreddit?.name;
    const key =
      by === 'subreddit'
        ? sub
          ? `r/${sub}`
          : null
        : by === 'keyword'
          ? (d.opportunity?.keywordGroup?.name ?? null)
          : by === 'thread'
            ? (d.opportunity?.post.title ?? null)
            : by === 'agent'
              ? d.agent.name
              : `u/${d.account.username}`;
    const k = key ?? OTHER[by];
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Breakdown table, sorted by clicks desc. */
export async function breakdown(
  workspaceId: string,
  by: BreakdownBy,
  since: Date,
  until: Date = new Date(),
): Promise<BreakdownRow[]> {
  const [dims, clicks, events, replies] = await Promise.all([
    linkDims(workspaceId),
    clicksByLink(workspaceId, since, until),
    attributedEvents(workspaceId, since, until),
    repliesByDim(workspaceId, by, since, until),
  ]);
  const rows = new Map<string, BreakdownRow & { cust: Set<string> }>();
  const row = (name: string) => {
    let r = rows.get(name);
    if (!r) {
      r = { name, replies: 0, clicks: 0, signups: 0, customers: 0, revenueCents: 0, cust: new Set() };
      rows.set(name, r);
    }
    return r;
  };
  const keyOf = (linkId: string) => dims.get(linkId)?.[by] ?? OTHER[by];
  for (const [linkId, n] of clicks) row(keyOf(linkId)).clicks += n;
  for (const e of events) {
    const r = row(keyOf(e.link_id!));
    if (e.kind === 'payment') {
      r.revenueCents += e.amount;
      r.cust.add(e.customer);
    } else r.signups += 1;
  }
  for (const [k, n] of replies) row(k).replies += n;
  return [...rows.values()]
    .map(({ cust, ...r }) => ({ ...r, customers: cust.size }))
    .filter((r) => r.replies || r.clicks || r.signups || r.revenueCents)
    .sort((a, b) => b.clicks - a.clicks || b.revenueCents - a.revenueCents);
}

export interface Series {
  name: string;
  values: number[];
}

/**
 * Daily clicks and signups split by subreddit: top 3 subreddits by clicks + "Other".
 * `days` are UTC day starts.
 */
export async function dailyBySubreddit(workspaceId: string, since: Date, until: Date = new Date()) {
  const start = new Date(Math.floor(since.getTime() / DAY) * DAY);
  const nDays = Math.max(1, Math.ceil((until.getTime() - start.getTime()) / DAY));
  const days = Array.from({ length: nDays }, (_, i) => new Date(start.getTime() + i * DAY));
  const [dims, clickRows, events] = await Promise.all([
    linkDims(workspaceId),
    prisma.$queryRaw<{ link_id: string; day: Date; n: bigint }[]>(Prisma.sql`
      SELECT "trackedLinkId" AS link_id, date_trunc('day', "occurredAt") AS day, count(*) AS n
      FROM "ClickEvent" WHERE "workspaceId" = ${workspaceId} AND "occurredAt" >= ${start} AND "occurredAt" < ${until}
      GROUP BY 1, 2`),
    attributedEvents(workspaceId, start, until),
  ]);
  const sub = (linkId: string) => dims.get(linkId)?.subreddit ?? 'Other';
  const idx = (d: Date) =>
    Math.min(nDays - 1, Math.max(0, Math.floor((new Date(d).getTime() - start.getTime()) / DAY)));
  const totalBySub = new Map<string, number>();
  for (const r of clickRows)
    totalBySub.set(sub(r.link_id), (totalBySub.get(sub(r.link_id)) ?? 0) + Number(r.n));
  const top = [...totalBySub.entries()]
    .filter(([n]) => n !== 'Other')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n]) => n);
  const names = [...top, 'Other'];
  const mk = () => names.map((name) => ({ name, values: new Array<number>(nDays).fill(0) }));
  const clicks = mk();
  const signups = mk();
  const at = (list: Series[], s: string) => list[top.includes(s) ? top.indexOf(s) : names.length - 1]!;
  for (const r of clickRows) at(clicks, sub(r.link_id)).values[idx(r.day)]! += Number(r.n);
  for (const e of events) if (e.kind !== 'payment') at(signups, sub(e.link_id!)).values[idx(e.day)]! += 1;
  return { days: days.map((d) => d.toISOString()), clicks, signups };
}

/** Per subreddit: clicks → signups → customers → revenue, for the "Where revenue came from" flow. */
export async function revenueFlow(workspaceId: string, since: Date, until: Date = new Date()) {
  const rows = await breakdown(workspaceId, 'subreddit', since, until);
  return rows.sort((a, b) => b.revenueCents - a.revenueCents || b.clicks - a.clicks).slice(0, 6);
}

/** Tracked links with all-time clicks and conversions (attributed signups + payments). */
export async function trackedLinks(workspaceId: string) {
  const [links, ws, conv] = await Promise.all([
    prisma.trackedLink.findMany({
      where: { workspaceId },
      orderBy: { clicks: 'desc' },
      select: {
        id: true,
        slug: true,
        destinationUrl: true,
        medium: true,
        clicks: true,
        utm: true,
        createdAt: true,
        subreddit: { select: { name: true } },
        agent: { select: { name: true } },
        _count: { select: { clickEvents: true } },
      },
    }),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }),
    attributedEvents(workspaceId, new Date(0), new Date(Date.now() + DAY)),
  ]);
  const convBy = new Map<string, number>();
  for (const e of conv) convBy.set(e.link_id!, (convBy.get(e.link_id!) ?? 0) + 1);
  const settings = (ws.settings ?? {}) as { shortHost?: string };
  const host = settings.shortHost ?? new URL(process.env.TRACKING_HOST ?? 'http://localhost:3000').host;
  return links.map((l) => {
    const utm = (l.utm ?? {}) as { label?: string; full?: string };
    let destPath = l.destinationUrl;
    try {
      const u = new URL(l.destinationUrl);
      destPath = `${u.pathname}${u.search}` || '/';
    } catch {}
    return {
      id: l.id,
      slug: l.slug,
      short: `${host}/r/${utm.label ?? l.slug}`,
      href: `/r/${l.slug}`,
      destination: l.destinationUrl,
      destPath,
      full: utm.full ?? l.destinationUrl,
      medium: l.medium,
      subreddit: l.subreddit?.name ?? null,
      agent: l.agent?.name ?? null,
      clicks: Math.max(l.clicks, l._count.clickEvents),
      conversions: convBy.get(l.id) ?? 0,
    };
  });
}

/** Options for the UTM builder. */
export async function utmOptions(workspaceId: string) {
  const [subreddits, agents, ws] = await Promise.all([
    prisma.subreddit.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.agent.findMany({
      where: { workspaceId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }),
  ]);
  const siteUrl = ((ws.settings ?? {}) as { siteUrl?: string }).siteUrl ?? 'https://example.com';
  return { subreddits, agents, siteUrl };
}

export interface CreateLinkInput {
  workspaceId: string;
  destinationUrl: string;
  medium: 'comment' | 'dm' | 'post';
  subredditId: string | null;
  agentId: string | null;
  label: string | null;
  slug: string;
  utm: Prisma.InputJsonValue;
}

export async function createTrackedLink(input: CreateLinkInput) {
  if (input.subredditId) {
    await prisma.subreddit.findFirstOrThrow({
      where: { id: input.subredditId, workspaceId: input.workspaceId },
    });
  }
  if (input.agentId) {
    await prisma.agent.findFirstOrThrow({ where: { id: input.agentId, workspaceId: input.workspaceId } });
  }
  return prisma.trackedLink.create({
    data: {
      workspaceId: input.workspaceId,
      slug: input.slug,
      destinationUrl: input.destinationUrl,
      medium: input.medium,
      subredditId: input.subredditId,
      agentId: input.agentId,
      utm: input.utm,
    },
  });
}

export const slugTaken = async (slug: string) => (await prisma.trackedLink.count({ where: { slug } })) > 0;

/** Integration status tiles (link-out only in v1). */
export async function integrations(workspaceId: string) {
  const [connectors, pageviews, payments] = await Promise.all([
    prisma.connector.findMany({
      where: { workspaceId, provider: { in: ['ga4', 'posthog', 'stripe', 'hubspot'] } },
      select: { provider: true, status: true },
    }),
    prisma.siteEvent.findFirst({
      where: { workspaceId, kind: 'pageview' },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
    prisma.siteEvent.findFirst({
      where: { workspaceId, kind: 'payment', stripeCustomerId: { not: null } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
  ]);
  const status = (p: string) => {
    const list = connectors.filter((c) => c.provider === p).map((c) => c.status);
    if (list.includes('connected')) return 'connected' as const;
    if (list.includes('error')) return 'error' as const;
    if (list.length && list.every((s) => s === 'coming_soon')) return 'coming_soon' as const;
    return 'disconnected' as const;
  };
  const stripe = process.env.STRIPE_SECRET_KEY || payments ? ('connected' as const) : status('stripe');
  return [
    {
      key: 'site',
      label: 'Site script',
      status: pageviews ? ('connected' as const) : ('disconnected' as const),
      detail: pageviews ? 'receiving pageviews' : 'no pageviews yet',
      href: '/settings',
    },
    { key: 'ga4', label: 'GA4', status: status('ga4'), detail: null, href: 'https://analytics.google.com/' },
    {
      key: 'posthog',
      label: 'PostHog',
      status: status('posthog'),
      detail: null,
      href: 'https://app.posthog.com/',
    },
    { key: 'stripe', label: 'Stripe', status: stripe, detail: null, href: 'https://dashboard.stripe.com/' },
    {
      key: 'hubspot',
      label: 'HubSpot',
      status: status('hubspot'),
      detail: null,
      href: 'https://app.hubspot.com/',
    },
  ];
}
