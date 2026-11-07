// Repository functions for the Leads screens (docs/PLAN.md §7 rows 5 and 5b).
import type { Prisma } from '@prisma/client';
import { LeadStage } from '@threadline/shared';
import { prisma } from '../client';
import { writeAudit } from './audit';

const leadInclude = {
  redditUser: { include: { firstSeenPost: { include: { subreddit: { select: { name: true } } } } } },
  owner: { include: { user: { select: { name: true, email: true } } } },
  agent: { select: { id: true, name: true, roleTitle: true, color: true } },
  attributions: { include: { siteEvent: { select: { visitorId: true } } } },
  conversations: { include: { post: { include: { subreddit: { select: { name: true } } } } } },
} satisfies Prisma.LeadInclude;

type LeadRow = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

/** Visitor ids we can tie to a lead: those on site events attributed to it. */
const visitorIds = (l: LeadRow) => [
  ...new Set(l.attributions.map((a) => a.siteEvent.visitorId).filter((v): v is string => !!v)),
];

async function clickStats(workspaceId: string, leads: LeadRow[]) {
  const all = [...new Set(leads.flatMap(visitorIds))];
  if (!all.length) return new Map<string, { count: number; last: Date | null }>();
  const rows = await prisma.clickEvent.groupBy({
    by: ['visitorId'],
    where: { workspaceId, visitorId: { in: all } },
    _count: { _all: true },
    _max: { occurredAt: true },
  });
  const byVisitor = new Map(rows.map((r) => [r.visitorId, r]));
  const out = new Map<string, { count: number; last: Date | null }>();
  for (const l of leads) {
    let count = 0;
    let last: Date | null = null;
    for (const v of visitorIds(l)) {
      const r = byVisitor.get(v);
      if (!r) continue;
      count += r._count._all;
      if (r._max.occurredAt && (!last || r._max.occurredAt > last)) last = r._max.occurredAt;
    }
    out.set(l.id, { count, last });
  }
  return out;
}

function subreddits(l: LeadRow): string[] {
  const s = new Set<string>();
  const first = l.redditUser.firstSeenPost?.subreddit.name;
  if (first) s.add(first);
  for (const c of l.conversations) if (c.post?.subreddit.name) s.add(c.post.subreddit.name);
  return [...s];
}

export interface LeadSummary {
  id: string;
  username: string;
  stage: LeadStage;
  intentScore: number;
  subreddits: string[];
  firstThread: string | null;
  firstSeenAt: Date;
  lastActivityAt: Date;
  owner: { id: string; name: string } | null;
  agent: { name: string; roleTitle: string; color: string } | null;
  dealValueCents: number;
  revenueCents: number;
  signupEmail: string | null;
  tags: string[];
  clicks: number;
  lastClickAt: Date | null;
  hubspotSyncedAt: Date | null;
  threads: number;
}

function summarize(l: LeadRow, clicks?: { count: number; last: Date | null }): LeadSummary {
  return {
    id: l.id,
    username: l.redditUser.username,
    stage: l.stage,
    intentScore: l.intentScore,
    subreddits: subreddits(l),
    firstThread: l.redditUser.firstSeenPost?.title ?? null,
    firstSeenAt: l.createdAt,
    lastActivityAt: l.lastActivityAt,
    owner: l.owner ? { id: l.owner.id, name: l.owner.user.name ?? l.owner.user.email } : null,
    agent: l.agent ? { name: l.agent.name, roleTitle: l.agent.roleTitle, color: l.agent.color } : null,
    dealValueCents: l.dealValueCents,
    revenueCents: l.revenueCents,
    signupEmail: l.signupEmail,
    tags: l.tags,
    clicks: clicks?.count ?? 0,
    lastClickAt: clicks?.last ?? null,
    hubspotSyncedAt: l.hubspotSyncedAt,
    threads: new Set([l.redditUser.firstSeenPostId, ...l.conversations.map((c) => c.postId)].filter(Boolean))
      .size,
  };
}

async function load(where: Prisma.LeadWhereInput, workspaceId: string) {
  const rows = await prisma.lead.findMany({ where: { workspaceId, ...where }, include: leadInclude });
  const clicks = await clickStats(workspaceId, rows);
  return rows.map((r) => summarize(r, clicks.get(r.id)));
}

/** Kanban: every lead grouped by stage, with counts and summed deal value. */
export async function listByStage(workspaceId: string) {
  const all = await load({}, workspaceId);
  return LeadStage.map((stage) => {
    const leads = all
      .filter((l) => l.stage === stage)
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
    return { stage, leads, count: leads.length, valueCents: leads.reduce((s, l) => s + l.dealValueCents, 0) };
  });
}

export const SAVED_VIEWS = {
  all: { label: 'All leads' },
  hot: { label: 'Hot (≥80)' },
  trials: { label: 'Trials' },
  customers: { label: 'Customers' },
  mine: { label: 'Mine' },
} as const;
export type SavedView = keyof typeof SAVED_VIEWS;

export const SORT_KEYS = [
  'username',
  'subreddits',
  'intentScore',
  'lastActivityAt',
  'owner',
  'stage',
  'firstThread',
  'agent',
  'clicks',
  'signupEmail',
  'revenueCents',
  'tags',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

const sortValue = (l: LeadSummary, k: SortKey): string | number => {
  switch (k) {
    case 'subreddits':
      return l.subreddits.join(',');
    case 'owner':
      return l.owner?.name ?? '';
    case 'agent':
      return l.agent?.name ?? '';
    case 'stage':
      return LeadStage.indexOf(l.stage);
    case 'lastActivityAt':
      return l.lastActivityAt.getTime();
    case 'tags':
      return l.tags.join(',');
    case 'firstThread':
      return l.firstThread ?? '';
    case 'signupEmail':
      return l.signupEmail ?? '';
    default:
      return l[k];
  }
};

/** Table: a saved view, sorted. */
export async function table(
  workspaceId: string,
  params: { view?: SavedView; sort?: SortKey; dir?: 'asc' | 'desc'; meMemberId?: string },
) {
  const where: Prisma.LeadWhereInput =
    params.view === 'hot'
      ? { intentScore: { gte: 80 } }
      : params.view === 'trials'
        ? { stage: 'trial' }
        : params.view === 'customers'
          ? { stage: 'customer' }
          : params.view === 'mine'
            ? { ownerMemberId: params.meMemberId ?? '__none__' }
            : {};
  const rows = await load(where, workspaceId);
  const key = params.sort ?? 'lastActivityAt';
  const dir = params.dir ?? (params.sort ? 'asc' : 'desc');
  rows.sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return dir === 'asc' ? c : -c;
  });
  return rows;
}

export async function pipelineSummary(workspaceId: string) {
  const [count, open, synced] = await Promise.all([
    prisma.lead.count({ where: { workspaceId } }),
    prisma.lead.aggregate({
      where: { workspaceId, stage: { notIn: ['customer', 'lost'] } },
      _sum: { dealValueCents: true },
    }),
    prisma.lead.aggregate({ where: { workspaceId }, _max: { hubspotSyncedAt: true } }),
  ]);
  return {
    count,
    openPipelineCents: open._sum.dealValueCents ?? 0,
    lastSyncedAt: synced._max.hubspotSyncedAt,
  };
}

export async function get(workspaceId: string, id: string) {
  const l = await prisma.lead.findFirst({
    where: { workspaceId, id },
    include: { ...leadInclude, tasks: { orderBy: [{ done: 'asc' }, { dueAt: 'asc' }] } },
  });
  if (!l) return null;
  const clicks = await clickStats(workspaceId, [l]);
  const notes = (Array.isArray(l.notes) ? l.notes : []) as { by: string; at: string; body: string }[];
  return { ...summarize(l, clicks.get(l.id)), notes, tasks: l.tasks, ownerMemberId: l.ownerMemberId };
}

export type TimelineEvent = {
  id: string;
  kind: 'msg' | 'click' | 'stage' | 'money';
  who: string;
  verb: string;
  text: string;
  meta?: string;
  at: Date;
};

/** Messages, clicks, stage changes, signups/payments and lead creation, newest first. */
export async function timeline(workspaceId: string, leadId: string): Promise<TimelineEvent[]> {
  const lead = await prisma.lead.findFirst({
    where: { workspaceId, id: leadId },
    include: {
      redditUser: { include: { firstSeenPost: { include: { subreddit: true } } } },
      attributions: { include: { siteEvent: true, trackedLink: true } },
      conversations: {
        include: {
          post: { include: { subreddit: true } },
          messages: {
            include: {
              account: { select: { username: true, roleLabel: true } },
              draft: {
                include: {
                  agent: { select: { name: true } },
                  approver: { include: { user: { select: { name: true } } } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!lead) return [];
  const username = lead.redditUser.username;
  const out: TimelineEvent[] = [];

  for (const c of lead.conversations) {
    const where = c.post ? `r/${c.post.subreddit.name}` : null;
    for (const m of c.messages) {
      if (m.direction === 'in') {
        out.push({
          id: m.id,
          kind: 'msg',
          who: `u/${m.author}`,
          verb: c.kind === 'dm' ? 'sent a DM' : 'replied to our comment',
          text: m.body,
          meta: c.kind === 'dm' ? undefined : (where ?? undefined),
          at: m.sentAt,
        });
      } else {
        const d = m.draft;
        const drafted = d
          ? ` · ${d.agent.name} drafted${d.approver ? ` · approved by ${d.approver.user.name}` : ''}`
          : '';
        out.push({
          id: m.id,
          kind: 'msg',
          who: `u/${m.account?.username ?? m.author}`,
          verb: `${c.kind === 'dm' ? 'sent a DM' : 'posted a comment'}${drafted}`,
          text: m.body,
          meta: [
            m.account
              ? `Disclosed as ${m.account.roleLabel[0]!.toUpperCase()}${m.account.roleLabel.slice(1)}`
              : null,
            d?.approvedAt ? `approved ${d.approvedAt.toISOString().slice(11, 16)}` : null,
            c.kind !== 'dm' ? where : null,
          ]
            .filter(Boolean)
            .join(' · '),
          at: m.sentAt,
        });
      }
    }
  }

  const vids = [
    ...new Set(lead.attributions.map((a) => a.siteEvent.visitorId).filter((v): v is string => !!v)),
  ];
  if (vids.length) {
    const clicks = await prisma.clickEvent.findMany({
      where: { workspaceId, visitorId: { in: vids } },
      include: { trackedLink: true },
      orderBy: { occurredAt: 'asc' },
    });
    clicks.forEach((ck, i) => {
      const utm = (ck.trackedLink.utm ?? {}) as Record<string, string>;
      out.push({
        id: ck.id,
        kind: 'click',
        who: `u/${username}`,
        verb: 'clicked a tracked link',
        text: `${utm.label ?? ck.trackedLink.slug} → ${new URL(ck.trackedLink.destinationUrl).pathname}`,
        meta: [
          `utm_medium=${ck.trackedLink.medium}`,
          utm.utm_term ? `utm_term=${utm.utm_term}` : null,
          `click ${i + 1}`,
        ]
          .filter(Boolean)
          .join(' · '),
        at: ck.occurredAt,
      });
    });
  }

  for (const a of lead.attributions) {
    const e = a.siteEvent;
    if (e.kind === 'pageview') continue;
    out.push({
      id: e.id,
      kind: 'money',
      who: `u/${username}`,
      verb: e.kind === 'payment' ? 'paid' : e.kind === 'trial' ? 'started a trial' : 'signed up',
      text:
        [e.email, e.amountCents ? `$${(e.amountCents / 100).toLocaleString('en-US')}` : null]
          .filter(Boolean)
          .join(' · ') || '—',
      meta: `Attributed to ${((a.trackedLink.utm ?? {}) as Record<string, string>).label ?? a.trackedLink.slug} · last click`,
      at: e.occurredAt,
    });
  }

  const stageEvents = await prisma.auditEvent.findMany({
    where: {
      workspaceId,
      action: 'lead.stage_changed',
      OR: [{ targetId: leadId }, { meta: { path: ['lead'], equals: `u/${username}` } }],
    },
    include: { actor: { include: { user: { select: { name: true } } } } },
  });
  for (const s of stageEvents) {
    const meta = (s.meta ?? {}) as { from?: string; to?: string; reason?: string };
    const label = (v?: string) => (v ? (STAGE_LABELS[v] ?? v) : '?');
    out.push({
      id: s.id,
      kind: 'stage',
      who: s.actor?.user.name ?? 'Threadline',
      verb: 'moved stage',
      text: `${label(meta.from)} → ${label(meta.to)}`,
      meta: meta.reason ? `Reason: ${meta.reason}` : undefined,
      at: s.at,
    });
  }

  out.push({
    id: `created-${lead.id}`,
    kind: 'stage',
    who: 'Threadline',
    verb: 'created the lead',
    text: lead.redditUser.firstSeenPost
      ? `Engaged with the thread “${lead.redditUser.firstSeenPost.title}”`
      : 'Engaged with one of our posts',
    meta: lead.redditUser.firstSeenPost ? `r/${lead.redditUser.firstSeenPost.subreddit.name}` : undefined,
    at: lead.createdAt,
  });

  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

const STAGE_LABELS: Record<string, string> = {
  new: 'New',
  engaged: 'Engaged',
  replied: 'Replied',
  interested: 'Interested',
  trial: 'Trial / Demo',
  customer: 'Customer',
  lost: 'Lost',
};

export class LeadNotFoundError extends Error {}

/** Move a lead to a stage; writes `lead.stage_changed` in the same transaction. No-op if unchanged. */
export async function moveStage(input: {
  workspaceId: string;
  leadId: string;
  stage: LeadStage;
  actorMemberId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { workspaceId: input.workspaceId, id: input.leadId },
      include: { redditUser: { select: { username: true } } },
    });
    if (!lead) throw new LeadNotFoundError('Lead not found');
    if (lead.stage === input.stage) return lead;
    const updated = await tx.lead.update({
      where: { id: lead.id },
      data: { stage: input.stage, lastActivityAt: new Date() },
    });
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: input.actorMemberId,
        action: 'lead.stage_changed',
        targetType: 'Lead',
        targetId: lead.id,
        meta: { lead: `u/${lead.redditUser.username}`, from: lead.stage, to: input.stage },
      },
      tx,
    );
    return updated;
  });
}

export async function addNote(input: { workspaceId: string; leadId: string; by: string; body: string }) {
  const lead = await prisma.lead.findFirst({ where: { workspaceId: input.workspaceId, id: input.leadId } });
  if (!lead) throw new LeadNotFoundError('Lead not found');
  const notes = Array.isArray(lead.notes) ? (lead.notes as Prisma.JsonArray) : [];
  return prisma.lead.update({
    where: { id: lead.id },
    data: { notes: [...notes, { by: input.by, at: new Date().toISOString(), body: input.body }] },
  });
}

export async function addTask(input: {
  workspaceId: string;
  leadId: string;
  title: string;
  dueAt: Date | null;
}) {
  const lead = await prisma.lead.findFirst({ where: { workspaceId: input.workspaceId, id: input.leadId } });
  if (!lead) throw new LeadNotFoundError('Lead not found');
  return prisma.leadTask.create({
    data: { workspaceId: input.workspaceId, leadId: lead.id, title: input.title, dueAt: input.dueAt },
  });
}

export async function setTaskDone(input: { workspaceId: string; taskId: string; done: boolean }) {
  const t = await prisma.leadTask.findFirst({ where: { workspaceId: input.workspaceId, id: input.taskId } });
  if (!t) throw new LeadNotFoundError('Task not found');
  return prisma.leadTask.update({ where: { id: t.id }, data: { done: input.done } });
}
