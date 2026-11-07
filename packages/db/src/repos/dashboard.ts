// Repository functions for the Home screen (docs/PLAN.md §7 row 1).
import { prisma } from '../client';

const DAY = 86_400_000;

function buckets(dates: Date[], since: Date, until: Date, n = 7, weights?: number[]): number[] {
  const out = new Array(n).fill(0) as number[];
  const span = until.getTime() - since.getTime();
  dates.forEach((d, i) => {
    const t = d.getTime() - since.getTime();
    if (t < 0 || t > span) return;
    const b = Math.min(n - 1, Math.floor((t / span) * n));
    out[b] = (out[b] ?? 0) + (weights ? (weights[i] ?? 0) : 1);
  });
  return out;
}

function delta(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? '0%' : 'new';
  const pct = Math.round(((cur - prev) / prev) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

export interface Kpi {
  key: string;
  label: string;
  period: string;
  value: number;
  money?: boolean;
  delta: string;
  /** 'up' | 'down' | 'flat' — drives the chip color */
  trend: 'up' | 'down' | 'flat';
  spark: number[];
  accent?: boolean;
}

/** KPI tiles over a range with the prior period for deltas. */
export async function kpis(workspaceId: string, days: number, rangeLabel: string): Promise<Kpi[]> {
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY);
  const prevSince = new Date(since.getTime() - days * DAY);
  const window = { gte: prevSince };

  const [opps, posted, leads, clicks, payments, pending, pendingRecent] = await Promise.all([
    prisma.opportunity.findMany({ where: { workspaceId, createdAt: window }, select: { createdAt: true } }),
    prisma.draft.findMany({
      where: { workspaceId, status: 'posted', postedAt: window },
      select: { postedAt: true },
    }),
    prisma.lead.findMany({ where: { workspaceId, createdAt: window }, select: { createdAt: true } }),
    prisma.clickEvent.findMany({ where: { workspaceId, occurredAt: window }, select: { occurredAt: true } }),
    prisma.siteEvent.findMany({
      where: { workspaceId, kind: 'payment', occurredAt: window, attributions: { some: {} } },
      select: { occurredAt: true, amountCents: true },
    }),
    prisma.draft.count({ where: { workspaceId, status: 'pending' } }),
    prisma.draft.findMany({ where: { workspaceId, status: 'pending' }, select: { createdAt: true } }),
  ]);

  const split = <T>(rows: T[], at: (r: T) => Date, w?: (r: T) => number) => {
    let cur = 0;
    let prev = 0;
    const curDates: Date[] = [];
    const curW: number[] = [];
    for (const r of rows) {
      const d = at(r);
      const v = w ? w(r) : 1;
      if (d >= since) {
        cur += v;
        curDates.push(d);
        curW.push(v);
      } else prev += v;
    }
    return { cur, prev, spark: buckets(curDates, since, now, 7, curW) };
  };

  const trend = (c: number, p: number): Kpi['trend'] => (c > p ? 'up' : c < p ? 'down' : 'flat');
  const mk = (
    key: string,
    label: string,
    s: { cur: number; prev: number; spark: number[] },
    extra: Partial<Kpi> = {},
  ): Kpi => ({
    key,
    label,
    period: rangeLabel,
    value: s.cur,
    delta: delta(s.cur, s.prev),
    trend: trend(s.cur, s.prev),
    spark: s.spark,
    ...extra,
  });

  const o = split(opps, (r) => r.createdAt);
  const p = split(posted, (r) => r.postedAt!);
  const l = split(leads, (r) => r.createdAt);
  const c = split(clicks, (r) => r.occurredAt);
  const r = split(
    payments,
    (x) => x.occurredAt,
    (x) => x.amountCents,
  );
  const pendSpark = buckets(
    pendingRecent.map((d) => d.createdAt),
    new Date(now.getTime() - DAY),
    now,
  );

  return [
    mk('opps', 'New opportunities', o, { accent: true }),
    {
      key: 'pending',
      label: 'Drafts awaiting approval',
      period: 'Right now',
      value: pending,
      delta: `+${pendingRecent.filter((d) => d.createdAt.getTime() > now.getTime() - DAY).length}`,
      trend: 'flat',
      spark: pendSpark,
    },
    mk('replies', 'Replies posted', p),
    mk('leads', 'New leads', l),
    mk('clicks', 'Clicks to site', c),
    mk('revenue', 'Attributed revenue', r, { money: true }),
  ];
}

export async function hotOpportunities(workspaceId: string, take = 5) {
  const [rows, newToday] = await Promise.all([
    prisma.opportunity.findMany({
      where: { workspaceId, status: { in: ['new', 'drafting'] } },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take,
      include: {
        post: {
          select: {
            title: true,
            upvotes: true,
            comments: true,
            postedAt: true,
            subreddit: { select: { name: true } },
          },
        },
        suggestedAgent: { select: { name: true, color: true } },
      },
    }),
    prisma.opportunity.count({ where: { workspaceId, createdAt: { gte: new Date(Date.now() - DAY) } } }),
  ]);
  return {
    newToday,
    items: rows.map((o) => ({
      id: o.id,
      score: o.score,
      level: o.level,
      title: o.post.title,
      subreddit: o.post.subreddit.name,
      postedAt: o.post.postedAt,
      upvotes: o.post.upvotes,
      comments: o.post.comments,
      agent: o.suggestedAgent ? { name: o.suggestedAgent.name, color: o.suggestedAgent.color } : null,
    })),
  };
}

/** Unique people funnel, last 30 days. */
export async function funnel(workspaceId: string) {
  const since = new Date(Date.now() - 30 * DAY);
  const [opps, replies, engaged, visitors, signups, customers] = await Promise.all([
    prisma.opportunity.count({ where: { workspaceId, createdAt: { gte: since } } }),
    prisma.draft.count({ where: { workspaceId, status: 'posted', postedAt: { gte: since } } }),
    prisma.lead.count({ where: { workspaceId, stage: { not: 'new' }, lastActivityAt: { gte: since } } }),
    prisma.clickEvent.findMany({
      where: { workspaceId, occurredAt: { gte: since } },
      distinct: ['visitorId'],
      select: { visitorId: true },
    }),
    prisma.siteEvent.count({ where: { workspaceId, kind: 'signup', occurredAt: { gte: since } } }),
    prisma.siteEvent.findMany({
      where: { workspaceId, kind: 'payment', occurredAt: { gte: since } },
      distinct: ['visitorId'],
      select: { visitorId: true },
    }),
  ]);
  const steps = [
    { stage: 'Opportunities', n: opps },
    { stage: 'Replies', n: replies },
    { stage: 'Engaged users', n: engaged },
    { stage: 'Clicks', n: visitors.length },
    { stage: 'Signups', n: signups },
    { stage: 'Customers', n: customers.length },
  ];
  const top = Math.max(1, ...steps.map((s) => s.n));
  return steps.map((s, i) => {
    const prev = i === 0 ? 0 : steps[i - 1]!.n;
    // Step conversion only reads as a rate when the step is a subset of the previous one.
    return { ...s, rate: i === 0 || !prev || s.n > prev ? null : s.n / prev, width: s.n / top };
  });
}

/** Per-agent stats over 30 days. Approval rate = approved (incl. scheduled/posted) / decided. */
export async function agentLeaderboard(workspaceId: string) {
  const since = new Date(Date.now() - 30 * DAY);
  const agents = await prisma.agent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, roleTitle: true, color: true },
  });
  const [drafts, leads, revenue] = await Promise.all([
    prisma.draft.groupBy({
      by: ['agentId', 'status'],
      where: { workspaceId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({ by: ['agentId'], where: { workspaceId }, _count: { _all: true } }),
    prisma.attribution.findMany({
      where: { workspaceId, siteEvent: { kind: 'payment', occurredAt: { gte: since } } },
      select: {
        weight: true,
        trackedLink: { select: { agentId: true } },
        siteEvent: { select: { amountCents: true } },
      },
    }),
  ]);
  return agents.map((a) => {
    const by = (s: string[]) =>
      drafts.filter((d) => d.agentId === a.id && s.includes(d.status)).reduce((n, d) => n + d._count._all, 0);
    const ok = by(['approved', 'scheduled', 'posted']);
    const decided = ok + by(['rejected']);
    return {
      id: a.id,
      name: a.name,
      role: a.roleTitle,
      color: a.color,
      approvalRate: decided ? ok / decided : null,
      replies: by(['posted']),
      leads: leads.find((l) => l.agentId === a.id)?._count._all ?? 0,
      revenueCents: Math.round(
        revenue
          .filter((r) => r.trackedLink.agentId === a.id)
          .reduce((s, r) => s + r.siteEvent.amountCents * r.weight, 0),
      ),
    };
  });
}

const FEED_KIND: Record<string, { kind: string; tone: 'ok' | 'dark' | 'mid' | 'hot' | 'bad' }> = {
  'draft.posted': { kind: 'Posted', tone: 'ok' },
  'draft.approved': { kind: 'Approved', tone: 'ok' },
  'draft.created': { kind: 'Draft', tone: 'hot' },
  'draft.rejected': { kind: 'Rejected', tone: 'bad' },
  'draft.scheduled': { kind: 'Scheduled', tone: 'hot' },
  'lead.stage_changed': { kind: 'Stage', tone: 'mid' },
  'lead.created': { kind: 'Lead', tone: 'mid' },
  'session.started': { kind: 'Session', tone: 'dark' },
  'opportunity.assigned': { kind: 'Assigned', tone: 'mid' },
  'opportunity.skipped': { kind: 'Skipped', tone: 'mid' },
  'opportunity.watched': { kind: 'Watching', tone: 'mid' },
};

/** Human-readable activity lines from the audit log. */
export async function activity(workspaceId: string, take = 6) {
  const rows = await prisma.auditEvent.findMany({
    where: { workspaceId, action: { not: 'session.log' } },
    orderBy: { at: 'desc' },
    take,
    include: {
      actor: { include: { user: { select: { name: true } } } },
      account: { select: { username: true } },
    },
  });
  return rows.map((r) => {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const cap = (v: unknown) => (typeof v === 'string' && v ? v[0]!.toUpperCase() + v.slice(1) : undefined);
    if (meta.agent) meta.agent = cap(meta.agent);
    const who = r.actor?.user.name?.split(' ')[0] ?? cap(meta.agent) ?? 'Threadline';
    const item = typeof meta.item === 'string' ? meta.item : '';
    const acct = r.account ? ` · u/${r.account.username}` : '';
    let text: string;
    switch (r.action) {
      case 'draft.posted':
        text = `${who} posted ${meta.agent ? `${meta.agent}’s ` : ''}${item || 'a reply'}${acct}`;
        break;
      case 'draft.approved':
        text = `${who} approved ${meta.agent ? `${meta.agent}’s ` : ''}${item || 'a draft'}${acct}`;
        break;
      case 'draft.rejected':
        text = `${who} rejected ${item || 'a draft'}${meta.reason ? `: “${meta.reason}”` : ''}`;
        break;
      case 'draft.created':
        text = `${meta.agent ?? 'An agent'} drafted ${meta.type === 'dm' ? 'a DM' : meta.type === 'post' ? 'a post' : 'a comment'}${acct} · waiting on approval`;
        break;
      case 'draft.scheduled':
        text = `${who} scheduled ${item || 'a draft'}`;
        break;
      case 'lead.stage_changed':
        text = `${meta.lead ?? 'A lead'} moved ${meta.from ?? ''} → ${meta.to ?? ''}`;
        break;
      case 'session.started':
        text = `${who} took over ${meta.profile ?? 'a browser'}${meta.reason ? ` · ${meta.reason}` : ''}`;
        break;
      case 'opportunity.skipped':
        text = `${who} skipped an opportunity`;
        break;
      case 'opportunity.watched':
        text = `${who} marked an opportunity as watched`;
        break;
      case 'opportunity.assigned':
        text = meta.draftRequested
          ? `${who} asked ${meta.agent ?? 'an agent'} for a draft`
          : `${who} assigned an opportunity to ${meta.agent ?? 'an agent'}`;
        break;
      default:
        text = `${who} · ${r.action.replace('.', ' ')}${item ? ` · ${item}` : ''}`;
    }
    const k = FEED_KIND[r.action] ?? { kind: r.action.split('.')[0] ?? 'Event', tone: 'mid' as const };
    return { id: r.id, kind: k.kind, tone: k.tone, text, at: r.at };
  });
}
